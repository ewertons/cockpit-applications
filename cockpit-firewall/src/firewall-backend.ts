/**
 * Privileged host operations. Every command is a fixed argv array or a
 * constant script from transaction.ts; user data only travels as validated
 * file content or stdin, never as shell text.
 */

import cockpit from 'cockpit';

import { ForeignTable, parseForeignTables } from './coexistence.js';
import { FirewallConfiguration, INET_TABLE_NAME, convertLegacyConfiguration } from './model.js';
import { HostFiles } from './firewall-state.js';
import { NFTABLES_CONFIGURATION_PATH } from './nftables-file.js';
import {
    LEGACY_CONFIGURATION_PATH,
    LEGACY_RULESET_PATH,
    LEGACY_UNIT_PATH,
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

/** Configuration files of earlier versions, which kept state outside nftables. */
export interface LegacyState {
    /** Contents of the old config.json, converted; null when absent or unreadable. */
    configuration: FirewallConfiguration | null;
    /** Whether any old file (config.json, cockpit-fw.nft, cockpit-firewall.service) exists. */
    filesPresent: boolean;
}

/** @returns /etc/nftables.conf, or null when it does not exist. */
export async function readNftablesConfigurationFile(): Promise<string | null> {
    return await cockpit.file(NFTABLES_CONFIGURATION_PATH, { superuser: "try" }).read();
}

/** @returns `nft list` output of this app's table in the kernel, "" when not loaded. */
export async function readLiveOwnTable(): Promise<string> {
    try {
        return await cockpit.spawn(["nft", "list", "table", "inet", INET_TABLE_NAME], { superuser: "require", err: "ignore" });
    } catch {
        return "";
    }
}

/** @returns `nft list ruleset` output. */
export async function readLiveRuleset(): Promise<string> {
    return await cockpit.spawn(["nft", "list", "ruleset"], { superuser: "require", err: "message" });
}

/** @returns files left by earlier versions of this app. */
export async function readLegacyState(): Promise<LegacyState> {
    let configuration: FirewallConfiguration | null = null;
    try {
        const text = await cockpit.file(LEGACY_CONFIGURATION_PATH, { superuser: "try" }).read();
        if (text)
            configuration = convertLegacyConfiguration(JSON.parse(text));
    } catch {
        // Unreadable or invalid: ignored, the file is still moved away on confirmation.
    }
    let filesPresent = configuration !== null;
    for (const path of [LEGACY_CONFIGURATION_PATH, LEGACY_RULESET_PATH, LEGACY_UNIT_PATH]) {
        try {
            await cockpit.spawn(["test", "-e", path], { superuser: "try", err: "ignore" });
            filesPresent = true;
        } catch {
            // Absent.
        }
    }
    return { configuration, filesPresent };
}

/** Random separator between the two parts of the apply script's stdin. */
function randomSeparator(): string {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Checks both texts with `nft -c`, loads `liveText` with automatic rollback
 * armed and keeps `candidateFile` to be written to /etc/nftables.conf on confirmation.
 * @param reviewedFile /etc/nftables.conf as the user reviewed it (null: absent); the
 *        apply fails if the file differs now.
 * @param removeStockFilterTable `liveText` deletes the stock `table inet filter`.
 * @throws Error with nft's message when the check or load fails.
 */
export async function applyRuleset(liveText: string, candidateFile: string, reviewedFile: string | null,
    enableForwarding: boolean, removeStockFilterTable: boolean): Promise<void> {
    const separator = randomSeparator();
    const withNewline = (text: string) => text === "" || text.endsWith("\n") ? text : text + "\n";
    try {
        await cockpit.script(applyScriptText(enableForwarding, removeStockFilterTable),
                             [separator, reviewedFile === null ? "absent" : "present"],
                             { superuser: "require", err: "message" })
                .input(withNewline(liveText) + separator + "\n" + withNewline(candidateFile) + separator + "\n" + (reviewedFile ?? ""));
    } catch (error) {
        throw new Error(errorMessage(error));
    }
}

/**
 * Keeps the applied rules and writes /etc/nftables.conf.
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

/** @returns everything deriveState needs. */
export async function readHostFiles(): Promise<HostFiles> {
    const [fileText, liveOwnTable, liveRuleset, legacy] = await Promise.all([
        readNftablesConfigurationFile(),
        readLiveOwnTable(),
        readLiveRuleset().catch(() => ""),
        readLegacyState(),
    ]);
    return { fileText, liveOwnTable, liveRuleset, legacyConfiguration: legacy.configuration, legacyFilesPresent: legacy.filesPresent };
}
