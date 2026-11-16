/**
 * Privileged host operations. Every command is a fixed argv array or a
 * constant script from transaction.ts; user data only travels as validated
 * file content or stdin, never as shell text.
 */

import cockpit from 'cockpit';

import { ForeignTable, parseForeignTables } from './coexistence.js';
import { FirewallConfiguration, INET_TABLE_NAME, NAT_TABLE_NAME, normalizeConfiguration } from './model.js';
import {
    CONFIGURATION_PATH,
    PERSISTED_RULESET_PATH,
    SYSCTL_PATH,
    TransactionStatus,
    applyScriptText,
    confirmScriptText,
    parseTransactionStatus,
    revertScriptText,
    statusScriptText,
} from './transaction.js';
import { isValidInterfaceName } from './validation.js';
import { WireguardInterfaceSummary, parseWireguardConfiguration } from './wireguard-import.js';

const WIREGUARD_DIRECTORY = "/etc/wireguard";

function errorMessage(error: unknown): string {
    if (error && typeof error === "object" && "message" in error)
        return String((error as { message: unknown }).message);
    return String(error);
}

/** @returns the saved configuration, or an empty one when none exists. */
export async function loadConfiguration(): Promise<FirewallConfiguration> {
    const text = await cockpit.file(CONFIGURATION_PATH, { superuser: "try" }).read();
    if (!text)
        return normalizeConfiguration(null);
    return normalizeConfiguration(JSON.parse(text));
}

/** Saves the configuration (the editable draft; not applied to the kernel). */
export async function saveConfiguration(configuration: FirewallConfiguration): Promise<void> {
    await cockpit.spawn(["mkdir", "-p", "-m", "700", CONFIGURATION_PATH.replace(/\/[^/]+$/, "")],
                        { superuser: "require", err: "message" });
    await cockpit.file(CONFIGURATION_PATH, { superuser: "require" }).replace(JSON.stringify(configuration, null, 2) + "\n");
}

/** @returns the ruleset file loaded at boot, or "" when none was persisted yet. */
export async function readPersistedRuleset(): Promise<string> {
    return (await cockpit.file(PERSISTED_RULESET_PATH, { superuser: "try" }).read()) ?? "";
}

/** @returns `nft list` output for this app's tables currently in the kernel. */
export async function readLiveOwnTables(): Promise<string> {
    const parts: string[] = [];
    for (const [family, name] of [["inet", INET_TABLE_NAME], ["ip", NAT_TABLE_NAME]]) {
        try {
            parts.push(await cockpit.spawn(["nft", "list", "table", family, name], { superuser: "require", err: "ignore" }));
        } catch {
            // Table not loaded.
        }
    }
    return parts.join("");
}

/**
 * Checks and loads the ruleset with automatic rollback armed.
 * @throws Error with nft's message when the check or load fails.
 */
export async function applyRuleset(rulesetText: string, enableForwarding: boolean): Promise<void> {
    try {
        await cockpit.script(applyScriptText(enableForwarding), [], { superuser: "require", err: "message" }).input(rulesetText);
    } catch (error) {
        throw new Error(errorMessage(error));
    }
}

/**
 * Keeps the applied ruleset and persists it for boot.
 * @param token token of the pending change the user reviewed (from the status).
 */
export async function confirmRuleset(token: string): Promise<void> {
    try {
        await cockpit.script(confirmScriptText(), [token], { superuser: "require", err: "message" });
    } catch (error) {
        throw new Error(errorMessage(error));
    }
}

/**
 * Rolls back to the previous ruleset immediately.
 * @param token token of the pending change shown to the user.
 */
export async function revertRuleset(token: string): Promise<void> {
    try {
        await cockpit.script(revertScriptText(), [token], { superuser: "require", err: "message" });
    } catch (error) {
        throw new Error(errorMessage(error));
    }
}

/** @returns the state of the last apply (pending confirmation, confirmed, rolled back). */
export async function readTransactionStatus(): Promise<TransactionStatus> {
    try {
        return parseTransactionStatus(await cockpit.script(statusScriptText(), [], { superuser: "require", err: "ignore" }));
    } catch {
        return { state: "none" };
    }
}

/** @returns nftables tables not owned by this app, read-only. */
export async function listForeignTables(): Promise<ForeignTable[]> {
    return parseForeignTables(await cockpit.spawn(["nft", "-j", "list", "chains"], { superuser: "require", err: "message" }));
}

/** @returns names of other firewall managers that are running (firewalld, ufw). */
export async function detectOtherFirewallManagers(): Promise<string[]> {
    const running: string[] = [];
    for (const unit of ["firewalld", "ufw"]) {
        try {
            const state = await cockpit.spawn(["systemctl", "is-active", unit], { err: "ignore" });
            if (state.trim() === "active")
                running.push(unit);
        } catch {
            // Inactive or not installed.
        }
    }
    return running;
}

export interface ForwardingState {
    /** Current kernel value of net.ipv4.ip_forward. */
    enabled: boolean;
    /** Whether this app's sysctl.d file exists. */
    persistedByThisApplication: boolean;
}

/** @returns the IPv4 forwarding state. */
export async function readForwardingState(): Promise<ForwardingState> {
    const value = await cockpit.file("/proc/sys/net/ipv4/ip_forward").read();
    const sysctlFile = await cockpit.file(SYSCTL_PATH).read();
    return { enabled: (value ?? "").trim() === "1", persistedByThisApplication: sysctlFile !== null };
}

/** @returns network interface names present on the host. */
export async function listNetworkInterfaces(): Promise<string[]> {
    try {
        const output = await cockpit.spawn(["ls", "-1", "/sys/class/net"], { err: "ignore" });
        return output.split("\n").map(name => name.trim())
                .filter(name => name && isValidInterfaceName(name));
    } catch {
        return [];
    }
}

/** Result of scanning /etc/wireguard. */
export interface WireguardScan {
    summaries: WireguardInterfaceSummary[];
    /** Interfaces whose configuration could not be read. */
    failedInterfaces: string[];
}

/**
 * Reads every /etc/wireguard/*.conf (read-only) and returns its peers as hosts.
 * @throws Error when the directory cannot be listed.
 */
export async function importWireguardPeers(): Promise<WireguardScan> {
    let listing: string;
    try {
        listing = await cockpit.spawn(["find", WIREGUARD_DIRECTORY, "-maxdepth", "1", "-type", "f", "-name", "*.conf"],
                                      { superuser: "try", err: "message" });
    } catch (error) {
        if (error && typeof error === "object" && "exit_status" in error && /No such file/.test(errorMessage(error)))
            return { summaries: [], failedInterfaces: [] };
        throw new Error(cockpit.format("Cannot list $0: $1", WIREGUARD_DIRECTORY, errorMessage(error)));
    }
    const summaries: WireguardInterfaceSummary[] = [];
    const failedInterfaces: string[] = [];
    for (const path of listing.split("\n").map(line => line.trim())
            .filter(Boolean)
            .sort()) {
        const interfaceName = path.slice(WIREGUARD_DIRECTORY.length + 1, -".conf".length);
        if (!isValidInterfaceName(interfaceName) || interfaceName.endsWith("*"))
            continue;
        try {
            const text = await cockpit.file(path, { superuser: "try" }).read();
            summaries.push(parseWireguardConfiguration(interfaceName, text ?? ""));
        } catch {
            failedInterfaces.push(interfaceName);
        }
    }
    return { summaries, failedInterfaces };
}
