/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * sshd_config and sshd service management.
 */

import cockpit from 'cockpit';

const _ = cockpit.gettext;

// --- Paths ---------------------------------------------------------------

export const MAIN_CONFIG = "/etc/ssh/sshd_config";
export const DROPIN_DIR = "/etc/ssh/sshd_config.d";

// The "00-" prefix is load-bearing: sshd uses the FIRST value it obtains for a
// keyword and Include sits at the top of the main config, so the
// alphabetically first drop-in wins over distro ones like 50-cloud-init.conf.
export const DROPIN = `${DROPIN_DIR}/00-cockpit-openssh.conf`;

// Dot-prefixed so sshd's glob(3) over *.conf never picks it up.
const DROPIN_BAK = `${DROPIN_DIR}/.00-cockpit-openssh.conf.bak`;

const ROLLBACK_UNIT = "cockpit-openssh-rollback";

const SERVICE_UNITS = ["sshd.service", "ssh.service"];

// --- Types ---------------------------------------------------------------

/** Effective configuration as reported by `sshd -G`, keyed by lowercase keyword. */
export type EffectiveConfig = Record<string, string[]>;

export interface DirectiveRecord {
    keyword: string; // lowercased
    value: string;
    file: string;
    line: number;
    inMatch: boolean;
}

export interface ConfigScan {
    records: DirectiveRecord[];
    /** Files parsed, in the order sshd reads them. */
    files: string[];
    /** Files containing at least one Match block. */
    matchFiles: string[];
}

export interface Provenance {
    file: string;
    line: number;
}

export interface ServiceState {
    unit: string;
    activeState: string;
    subState: string;
    unitFileState: string;
    socketUnit: string | null;
    socketActive: boolean;
}

export interface ValidationResult {
    ok: boolean;
    error: string;
}

export interface PreflightWarning {
    id: string;
    severity: "warning" | "danger";
    title: string;
    detail: string;
    fixLabel?: string;
    fix?: () => Promise<void>;
}

export interface HostKey {
    path: string;
    fingerprint: string;
}

// --- Managed settings ----------------------------------------------------

export const MANAGED_KEYWORDS = [
    "Port",
    "ListenAddress",
    "PermitRootLogin",
    "PasswordAuthentication",
    "PubkeyAuthentication",
    "KbdInteractiveAuthentication",
    "PermitEmptyPasswords",
    "X11Forwarding",
    "AllowTcpForwarding",
    "MaxAuthTries",
    "LoginGraceTime",
    "ClientAliveInterval",
    "ClientAliveCountMax",
    "AllowUsers",
    "AllowGroups",
    "DenyUsers",
    "DenyGroups",
    "LogLevel",
    "Banner",
] as const;

export type ManagedKeyword = typeof MANAGED_KEYWORDS[number];

/** Every keyword holds a list; an empty list means "leave to the rest of the config". */
export type ManagedSettings = Record<ManagedKeyword, string[]>;

export function emptySettings(): ManagedSettings {
    const settings = {} as ManagedSettings;
    for (const keyword of MANAGED_KEYWORDS)
        settings[keyword] = [];
    return settings;
}

export function one(settings: ManagedSettings, key: ManagedKeyword): string {
    return settings[key][0] ?? "";
}

export function withOne(settings: ManagedSettings, key: ManagedKeyword, value: string): ManagedSettings {
    return { ...settings, [key]: value.trim() ? [value.trim()] : [] };
}

export function withList(settings: ManagedSettings, key: ManagedKeyword, values: string[]): ManagedSettings {
    return { ...settings, [key]: values.map(v => v.trim()).filter(Boolean) };
}

export function settingsEqual(a: ManagedSettings, b: ManagedSettings): boolean {
    return MANAGED_KEYWORDS.every(k => a[k].length === b[k].length && a[k].every((v, i) => v === b[k][i]));
}

const DROPIN_HEADER =
    "# Managed by cockpit-openssh.\n" +
    "#\n" +
    "# sshd uses the first value it obtains for a keyword and Include sits at the\n" +
    "# top of sshd_config, so settings here override both the main file and any\n" +
    "# later drop-in. Remove this file and reload sshd to revert them.\n" +
    "\n";

export function serializeSettings(settings: ManagedSettings): string {
    const lines: string[] = [];
    for (const keyword of MANAGED_KEYWORDS)
        for (const value of settings[keyword])
            lines.push(`${keyword} ${value}`);
    return lines.length ? DROPIN_HEADER + lines.join("\n") + "\n" : "";
}

// sshd -G reports ListenAddress with the resolved port appended, and an explicit
// ListenAddress overrides Port. Copying it into the drop-in would silently pin
// the port, so it stays blank until the admin asks for it.
const NOT_PREFILLED: ManagedKeyword[] = ["ListenAddress"];

/**
 * Show the configuration that is actually in force rather than blank boxes.
 * Anything already set in our own drop-in wins over the inherited value.
 */
export function prefillSettings(settings: ManagedSettings, effective: EffectiveConfig): ManagedSettings {
    const filled = { ...settings };
    for (const keyword of MANAGED_KEYWORDS) {
        if (filled[keyword].length > 0 || NOT_PREFILLED.includes(keyword))
            continue;
        // "none" is how sshd reports an unset value, e.g. for Banner.
        const values = effectiveValues(effective, keyword).filter(value => value && value !== "none");
        if (values.length > 0)
            filled[keyword] = [...values];
    }
    return filled;
}

const DIRECTIVE_RE = /^([A-Za-z][A-Za-z0-9]*)(?:\s+|\s*=\s*)(.*)$/;

export function parseSettings(content: string): ManagedSettings {
    const settings = emptySettings();
    for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        const match = line.match(DIRECTIVE_RE);
        if (!match)
            continue;
        const keyword = MANAGED_KEYWORDS.find(k => k.toLowerCase() === match[1].toLowerCase());
        if (keyword)
            settings[keyword].push(match[2].trim());
    }
    return settings;
}

// --- sshd binary and effective config ------------------------------------

let sshdPathCache: string | null | undefined;

/** Forget cached probe results, e.g. after installing openssh-server. */
export function resetDetection(): void {
    sshdPathCache = undefined;
}

export async function sshdBinary(): Promise<string | null> {
    if (sshdPathCache !== undefined)
        return sshdPathCache;
    for (const path of ["/usr/sbin/sshd", "/usr/bin/sshd", "/sbin/sshd"]) {
        try {
            await cockpit.spawn(["test", "-x", path], { err: "ignore" });
            sshdPathCache = path;
            return path;
        } catch { /* not here, keep looking */ }
    }
    sshdPathCache = null;
    return null;
}

function parseEffective(output: string): EffectiveConfig {
    const config: EffectiveConfig = {};
    for (const raw of output.split("\n")) {
        const line = raw.trim();
        if (!line)
            continue;
        const idx = line.indexOf(" ");
        const key = (idx === -1 ? line : line.slice(0, idx)).toLowerCase();
        const value = idx === -1 ? "" : line.slice(idx + 1);
        if (!config[key])
            config[key] = [];
        config[key].push(value);
    }
    return config;
}

/**
 * The single source of truth for what sshd is actually configured to do.
 * Without `matchCriteria`, Match blocks are skipped entirely.
 */
export async function getEffectiveConfig(matchCriteria?: string): Promise<EffectiveConfig> {
    const sshd = await sshdBinary();
    if (!sshd)
        return {};
    const criteria = matchCriteria ? ["-C", matchCriteria] : [];
    try {
        // -G parses and dumps without host key checks, and needs no root.
        return parseEffective(await cockpit.spawn([sshd, "-G", ...criteria], { superuser: "try", err: "message" }));
    } catch {
        try {
            // Pre-9.0 sshd has no -G.
            return parseEffective(await cockpit.spawn([sshd, "-T", ...criteria], { superuser: "require", err: "message" }));
        } catch {
            return {};
        }
    }
}

export function effectiveValue(config: EffectiveConfig, keyword: string): string {
    const values = config[keyword.toLowerCase()];
    return values && values.length > 0 ? values[0] : "";
}

export function effectiveValues(config: EffectiveConfig, keyword: string): string[] {
    return config[keyword.toLowerCase()] ?? [];
}

// --- Config file scanning (for provenance) -------------------------------

async function readFileQuiet(path: string): Promise<string> {
    const handle = cockpit.file(path, { superuser: "try" });
    try {
        return (await handle.read()) || "";
    } catch {
        return "";
    } finally {
        handle.close();
    }
}

// Only shell-safe glob characters; the patterns come from a root-owned file but
// are expanded by the shell, so anything else is rejected rather than run.
const SAFE_GLOB_RE = /^[A-Za-z0-9_./*?[\]-]+$/;

async function expandGlob(pattern: string): Promise<string[]> {
    // sshd resolves relative Include paths against /etc/ssh.
    const patterns = pattern.split(/\s+/)
            .filter(Boolean)
            .map(p => (p.startsWith("/") ? p : `/etc/ssh/${p}`))
            .filter(p => SAFE_GLOB_RE.test(p));
    if (patterns.length === 0)
        return [];
    try {
        const out = await cockpit.spawn(
            ["/bin/sh", "-c", 'for p in "$@"; do ls -1 $p 2>/dev/null; done', "sh", ...patterns],
            { superuser: "try", err: "ignore" });
        return out.split("\n").map(s => s.trim())
                .filter(Boolean);
    } catch {
        return [];
    }
}

function scanFile(path: string, content: string, scan: ConfigScan): void {
    let inMatch = false;
    content.split("\n").forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            return;
        const match = line.match(DIRECTIVE_RE);
        if (!match)
            return;
        const keyword = match[1].toLowerCase();
        if (keyword === "match") {
            if (!inMatch)
                scan.matchFiles.push(path);
            inMatch = true;
            return;
        }
        scan.records.push({ keyword, value: match[2].trim(), file: path, line: i + 1, inMatch });
    });
    scan.files.push(path);
}

/** Walk sshd_config expanding Include, recording where each directive comes from. */
export async function scanConfig(): Promise<ConfigScan> {
    const scan: ConfigScan = { records: [], files: [], matchFiles: [] };
    const main = await readFileQuiet(MAIN_CONFIG);
    if (!main)
        return scan;

    const lines = main.split("\n");
    let inMatch = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith("#"))
            continue;
        const match = line.match(DIRECTIVE_RE);
        if (!match)
            continue;
        const keyword = match[1].toLowerCase();
        if (keyword === "match") {
            if (!inMatch)
                scan.matchFiles.push(MAIN_CONFIG);
            inMatch = true;
            continue;
        }
        if (keyword === "include") {
            for (const path of await expandGlob(match[2].trim()))
                scanFile(path, await readFileQuiet(path), scan);
            continue;
        }
        scan.records.push({ keyword, value: match[2].trim(), file: MAIN_CONFIG, line: i + 1, inMatch });
    }
    scan.files.push(MAIN_CONFIG);
    return scan;
}

/** Which file currently supplies a keyword, ignoring conditional Match blocks. */
export function provenanceFor(scan: ConfigScan, keyword: string): Provenance | null {
    const key = keyword.toLowerCase();
    const hit = scan.records.find(r => r.keyword === key && !r.inMatch);
    return hit ? { file: hit.file, line: hit.line } : null;
}

export async function supportsIncludes(): Promise<boolean> {
    const main = await readFileQuiet(MAIN_CONFIG);
    return /^\s*Include\s+.*sshd_config\.d/mi.test(main);
}

// --- Drop-in read/write --------------------------------------------------

export async function readDropIn(): Promise<string> {
    return readFileQuiet(DROPIN);
}

/** An absent drop-in and an empty one mean the same thing to sshd. */
async function saveBackup(previous: string): Promise<void> {
    const handle = cockpit.file(DROPIN_BAK, { superuser: "require" });
    try {
        await handle.replace(previous);
    } finally {
        handle.close();
    }
}

async function restoreBackup(): Promise<void> {
    const backup = cockpit.file(DROPIN_BAK, { superuser: "require" });
    const target = cockpit.file(DROPIN, { superuser: "require" });
    try {
        await target.replace((await backup.read()) || "");
    } finally {
        backup.close();
        target.close();
    }
}

export async function validateConfig(): Promise<ValidationResult> {
    const sshd = await sshdBinary();
    if (!sshd)
        return { ok: false, error: _("sshd is not installed") };
    try {
        await cockpit.spawn([sshd, "-t"], { superuser: "require", err: "message" });
        return { ok: true, error: "" };
    } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * Stage the new drop-in, validate the assembled config, and restore the previous
 * one if sshd rejects it. Does not reload — the daemon is still running the old
 * config when this returns, which is what makes a failed validation harmless.
 */
export async function applyConfig(content: string, expected: string): Promise<void> {
    await saveBackup(expected);

    const handle = cockpit.file(DROPIN, { superuser: "require" });
    try {
        await handle.modify(current => {
            if ((current || "") !== expected)
                throw new Error(_("The configuration changed on disk since it was loaded. Reload the page and try again."));
            return content;
        });
    } finally {
        handle.close();
    }

    const result = await validateConfig();
    if (!result.ok) {
        await restoreBackup();
        throw new Error(result.error || _("sshd rejected the new configuration"));
    }
}

/** Undo the last applyConfig() and reload, used by "Revert now". */
export async function revertConfig(unit: string): Promise<void> {
    await restoreBackup();
    await reloadService(unit);
}

// --- Service -------------------------------------------------------------

function systemctl(args: string[]): Promise<string> {
    return cockpit.spawn(["systemctl", ...args], { superuser: "require", err: "message" });
}

export async function detectServiceUnit(): Promise<string | null> {
    for (const unit of SERVICE_UNITS) {
        try {
            await cockpit.spawn(["systemctl", "cat", unit], { err: "ignore" });
            return unit;
        } catch { /* try the next name */ }
    }
    return null;
}

export async function getServiceState(unit: string): Promise<ServiceState> {
    const props: Record<string, string> = {};
    try {
        const out = await cockpit.spawn(
            ["systemctl", "show", unit, "--property=ActiveState,SubState,UnitFileState,TriggeredBy"],
            { err: "ignore" });
        for (const line of out.trim().split("\n")) {
            const idx = line.indexOf("=");
            if (idx > 0)
                props[line.slice(0, idx)] = line.slice(idx + 1);
        }
    } catch { /* leave everything unknown */ }

    const socketUnit = (props.TriggeredBy || "").split(/\s+/).find(u => u.endsWith(".socket")) ?? null;
    let socketActive = false;
    if (socketUnit) {
        try {
            await cockpit.spawn(["systemctl", "is-active", "--quiet", socketUnit], { err: "ignore" });
            socketActive = true;
        } catch { /* present but not listening */ }
    }

    return {
        unit,
        activeState: props.ActiveState || "unknown",
        subState: props.SubState || "",
        unitFileState: props.UnitFileState || "",
        socketUnit,
        socketActive,
    };
}

export function startService(unit: string): Promise<string> {
    return systemctl(["start", unit]);
}

export function stopService(unit: string): Promise<string> {
    return systemctl(["stop", unit]);
}

export function restartService(unit: string): Promise<string> {
    return systemctl(["restart", unit]);
}

/** SIGHUP re-execs sshd; established sessions are unaffected. */
export function reloadService(unit: string): Promise<string> {
    return systemctl(["reload", unit]);
}

export function enableService(unit: string): Promise<string> {
    return systemctl(["enable", unit]);
}

export function disableService(unit: string): Promise<string> {
    return systemctl(["disable", unit]);
}

/** A port change on a socket-activated host needs this, not a daemon reload. */
export async function restartSocket(socketUnit: string): Promise<void> {
    await systemctl(["daemon-reload"]);
    await systemctl(["restart", socketUnit]);
}

/**
 * Ubuntu 22.10-23.10 migrated Port/ListenAddress into a socket drop-in; while it
 * exists, sshd_config's Port is ignored entirely.
 */
export async function socketAddressOverride(socketUnit: string): Promise<string | null> {
    const path = `/etc/systemd/system/${socketUnit}.d/addresses.conf`;
    return (await readFileQuiet(path)) ? path : null;
}

export async function hostKeyFingerprints(config: EffectiveConfig): Promise<HostKey[]> {
    const keys: HostKey[] = [];
    for (const path of effectiveValues(config, "hostkey")) {
        try {
            const out = await cockpit.spawn(["ssh-keygen", "-lf", `${path}.pub`], { superuser: "try", err: "ignore" });
            if (out.trim())
                keys.push({ path, fingerprint: out.trim() });
        } catch { /* key not generated yet */ }
    }
    return keys;
}

// --- Rollback timer ------------------------------------------------------

export async function cancelRollback(): Promise<void> {
    const units = [`${ROLLBACK_UNIT}.timer`, `${ROLLBACK_UNIT}.service`];
    try {
        await cockpit.spawn(["systemctl", "stop", ...units], { superuser: "require", err: "ignore" });
    } catch { /* not running */ }
    try {
        await cockpit.spawn(["systemctl", "reset-failed", ...units], { superuser: "require", err: "ignore" });
    } catch { /* nothing to reset */ }
}

/** Restore the previous drop-in after `seconds` unless the change is confirmed. */
export async function armRollback(seconds: number, unit: string): Promise<void> {
    await cancelRollback();
    await cockpit.spawn([
        "systemd-run",
        `--unit=${ROLLBACK_UNIT}`,
        `--on-active=${seconds}`,
        "--description=Revert cockpit-openssh sshd configuration",
        "/bin/sh", "-c", 'cp -a "$1" "$2" && systemctl reload "$3"',
        "sh", DROPIN_BAK, DROPIN, unit,
    ], { superuser: "require", err: "message" });
}

// --- Package installation ------------------------------------------------

export async function detectPackageManager(): Promise<"apt" | "dnf" | null> {
    try {
        await cockpit.spawn(["which", "apt-get"], { err: "ignore" });
        return "apt";
    } catch { /* not Debian-like */ }
    try {
        await cockpit.spawn(["which", "dnf"], { err: "ignore" });
        return "dnf";
    } catch { /* not Fedora-like */ }
    return null;
}

export async function installServerPackage(manager: "apt" | "dnf"): Promise<void> {
    const cmd = manager === "apt"
        ? ["apt-get", "install", "-y", "openssh-server"]
        : ["dnf", "install", "-y", "openssh-server"];
    await cockpit.spawn(cmd, { superuser: "require", err: "message" });
    resetDetection();
}

// --- Pre-flight checks ---------------------------------------------------

export interface PreflightContext {
    settings: ManagedSettings;
    effective: EffectiveConfig;
    service: ServiceState;
    scan: ConfigScan;
    currentUser: string;
    currentUserGroups: string[];
    currentUserHasKey: boolean;
    hasNonRootUser: boolean;
}

async function selinuxPortWarning(port: string): Promise<PreflightWarning | null> {
    let mode = "";
    try {
        mode = (await cockpit.spawn(["getenforce"], { err: "ignore" })).trim();
    } catch {
        return null; // no SELinux on this host
    }
    if (mode !== "Enforcing")
        return null;

    try {
        const out = await cockpit.spawn(["semanage", "port", "-l"], { superuser: "try", err: "ignore" });
        const labelled = out.split("\n")
                .filter(line => line.startsWith("ssh_port_t"))
                .some(line => line.split(/[\s,]+/).includes(port));
        if (labelled)
            return null;
    } catch {
        return {
            id: "selinux-no-semanage",
            severity: "warning",
            title: _("The SELinux port label cannot be checked"),
            detail: cockpit.format(
                _("SELinux is enforcing but semanage is missing. Install policycoreutils-python-utils, then run: semanage port -a -t ssh_port_t -p tcp $0"),
                port),
        };
    }

    return {
        id: "selinux-port",
        severity: "danger",
        title: cockpit.format(_("SELinux will not let sshd bind port $0"), port),
        detail: _("sshd fails to start with \"Permission denied\" until the port is labelled ssh_port_t."),
        fixLabel: cockpit.format(_("Label port $0 for SSH"), port),
        fix: async () => {
            try {
                await cockpit.spawn(["semanage", "port", "-a", "-t", "ssh_port_t", "-p", "tcp", port],
                                    { superuser: "require", err: "message" });
            } catch {
                // Already assigned to another type; modify instead of add.
                await cockpit.spawn(["semanage", "port", "-m", "-t", "ssh_port_t", "-p", "tcp", port],
                                    { superuser: "require", err: "message" });
            }
        },
    };
}

async function firewallPortWarning(port: string): Promise<PreflightWarning | null> {
    try {
        await cockpit.spawn(["systemctl", "is-active", "--quiet", "firewalld"], { err: "ignore" });
        const out = await cockpit.spawn(["firewall-cmd", "--list-ports"], { superuser: "try", err: "ignore" });
        if (out.split(/\s+/).includes(`${port}/tcp`))
            return null;
        return {
            id: "firewalld-port",
            severity: "danger",
            title: cockpit.format(_("firewalld is not allowing TCP port $0"), port),
            detail: _("New SSH connections will be refused until the port is opened."),
            fixLabel: _("Open the port in firewalld"),
            fix: async () => {
                await cockpit.spawn(["firewall-cmd", "--permanent", `--add-port=${port}/tcp`],
                                    { superuser: "require", err: "message" });
                await cockpit.spawn(["firewall-cmd", "--reload"], { superuser: "require", err: "message" });
            },
        };
    } catch { /* firewalld not running, try ufw */ }

    try {
        const out = await cockpit.spawn(["ufw", "status"], { superuser: "try", err: "ignore" });
        if (!out.includes("Status: active"))
            return null;
        const allowed = out.split("\n").some(line => line.includes(`${port}/tcp`) && line.includes("ALLOW"));
        if (allowed)
            return null;
        return {
            id: "ufw-port",
            severity: "danger",
            title: cockpit.format(_("ufw is not allowing TCP port $0"), port),
            detail: _("New SSH connections will be refused until the port is opened."),
            fixLabel: _("Open the port in ufw"),
            fix: async () => {
                await cockpit.spawn(["ufw", "allow", `${port}/tcp`, "comment", "OpenSSH"],
                                    { superuser: "require", err: "message" });
            },
        };
    } catch {
        return null;
    }
}

export async function preflight(ctx: PreflightContext): Promise<PreflightWarning[]> {
    const warnings: PreflightWarning[] = [];
    const { settings, effective, service } = ctx;

    const newPort = one(settings, "Port");
    const oldPort = effectiveValue(effective, "port") || "22";
    if (newPort && newPort !== oldPort) {
        const selinux = await selinuxPortWarning(newPort);
        if (selinux)
            warnings.push(selinux);
        const firewall = await firewallPortWarning(newPort);
        if (firewall)
            warnings.push(firewall);

        if (service.socketUnit) {
            const override = await socketAddressOverride(service.socketUnit);
            if (override) {
                warnings.push({
                    id: "socket-address-override",
                    severity: "danger",
                    title: _("The listening port is controlled by systemd, not by sshd_config"),
                    detail: cockpit.format(
                        _("$0 sets the listening address. Changing Port here has no effect until that file is removed or edited."),
                        override),
                });
            } else {
                warnings.push({
                    id: "socket-activated",
                    severity: "warning",
                    title: cockpit.format(_("$0 is socket-activated"), service.unit),
                    detail: cockpit.format(
                        _("The port change also needs a daemon reload and a restart of $0. This will be done for you, which briefly stops new connections from being accepted."),
                        service.socketUnit),
                });
            }
        }
    }

    const passwordAuth = one(settings, "PasswordAuthentication");
    if (passwordAuth === "no") {
        if (!ctx.currentUserHasKey) {
            warnings.push({
                id: "no-key-for-current-user",
                severity: "danger",
                title: cockpit.format(_("$0 has no authorized SSH key"), ctx.currentUser),
                detail: _("Turning off password authentication now locks this account out of SSH. Add a public key on the Authorized keys page first."),
            });
        }
        const kbd = one(settings, "KbdInteractiveAuthentication") ||
                    effectiveValue(effective, "kbdinteractiveauthentication");
        if (effectiveValue(effective, "usepam") === "yes" && kbd !== "no") {
            warnings.push({
                id: "pam-still-prompts",
                severity: "warning",
                title: _("Password logins may still be possible"),
                detail: _("With UsePAM yes, PAM keeps offering a password prompt through keyboard-interactive authentication. Set KbdInteractiveAuthentication to no as well."),
            });
        }
    }

    if (one(settings, "PermitRootLogin") === "no" && !ctx.hasNonRootUser) {
        warnings.push({
            id: "root-only",
            severity: "danger",
            title: _("root is the only account that can log in"),
            detail: _("Denying root login leaves no way to reach this host over SSH. Create another account first."),
        });
    }

    const allowUsers = one(settings, "AllowUsers");
    if (allowUsers) {
        const listed = allowUsers.split(/\s+/)
                .some(p => p === ctx.currentUser || p.startsWith(`${ctx.currentUser}@`));
        if (!listed) {
            warnings.push({
                id: "allowusers-excludes-user",
                severity: "danger",
                title: cockpit.format(_("AllowUsers does not include $0"), ctx.currentUser),
                detail: _("Only the listed accounts will be able to log in over SSH."),
            });
        }
    }

    const allowGroups = one(settings, "AllowGroups");
    if (allowGroups && !allowGroups.split(/\s+/).some(g => ctx.currentUserGroups.includes(g))) {
        warnings.push({
            id: "allowgroups-excludes-user",
            severity: "danger",
            title: cockpit.format(_("AllowGroups does not include any group of $0"), ctx.currentUser),
            detail: _("Only members of the listed groups will be able to log in over SSH."),
        });
    }

    const denyUsers = one(settings, "DenyUsers");
    if (denyUsers && denyUsers.split(/\s+/).some(p => p === ctx.currentUser || p.startsWith(`${ctx.currentUser}@`))) {
        warnings.push({
            id: "denyusers-includes-user",
            severity: "danger",
            title: cockpit.format(_("DenyUsers includes $0"), ctx.currentUser),
            detail: _("This account will no longer be able to log in over SSH."),
        });
    }

    const keysCommand = effectiveValue(effective, "authorizedkeyscommand");
    if (keysCommand && keysCommand !== "none") {
        warnings.push({
            id: "authorizedkeyscommand",
            severity: "warning",
            title: _("Authorized keys may come from somewhere else"),
            detail: cockpit.format(
                _("AuthorizedKeysCommand is set to $0, so keys can be supplied by that program rather than by the authorized_keys files shown in this application."),
                keysCommand),
        });
    }

    if (ctx.scan.matchFiles.length > 0) {
        warnings.push({
            id: "match-blocks",
            severity: "warning",
            title: _("Conditional Match blocks are present"),
            detail: cockpit.format(
                _("$0 contains Match blocks. Settings made here apply globally and may still be overridden for particular users, groups or addresses."),
                ctx.scan.matchFiles.join(", ")),
        });
    }

    return warnings;
}
