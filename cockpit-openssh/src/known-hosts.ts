/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * known_hosts inspection and the report-only periodic check.
 */

import cockpit from 'cockpit';

import { SystemUser } from './authorized-keys.js';
import reportScript from './known-hosts-report.py';

const _ = cockpit.gettext;

// --- Paths ---------------------------------------------------------------

export const SYSTEM_KNOWN_HOSTS = "/etc/ssh/ssh_known_hosts";

export const REPORT_UNIT = "cockpit-openssh-known-hosts-report";

const LIBEXEC_DIR = "/usr/local/libexec/cockpit-openssh";
const SCRIPT_PATH = `${LIBEXEC_DIR}/known-hosts-report`;
const CONFIG_DIR = "/etc/cockpit-openssh";
const CONFIG_PATH = `${CONFIG_DIR}/known-hosts-report.conf`;
const STATE_DIR = "/var/lib/cockpit-openssh";
const REPORT_PATH = `${STATE_DIR}/known-hosts-report.json`;
const UNIT_DIR = "/etc/systemd/system";

// --- Types ---------------------------------------------------------------

export interface KnownHostsFile {
    path: string;
    label: string;
    scope: "system" | "user";
    owner: string | null;
    exists: boolean;
}

export interface KnownHostEntry {
    /** The verbatim line; this is the identity used when removing an entry. */
    raw: string;
    lineNumber: number;
    marker: string;
    /** Empty when the entry is hashed — the host name cannot be recovered. */
    hostnames: string;
    hashed: boolean;
    keyType: string;
    blob: string;
    comment: string;
    fingerprint: string;
    /** Host name recovered for a hashed entry by probing candidates. */
    label: string;
}

export type FindingStatus =
    "match" | "mismatch" | "unreachable" | "unresolvable" | "skipped-hashed" | "skipped-pattern";

export interface ReportFinding {
    file: string;
    host: string;
    keyType: string;
    line: number;
    status: FindingStatus;
}

export interface Report {
    generated: string;
    findings: ReportFinding[];
    counts: Record<string, number>;
}

export interface TimerStatus {
    installed: boolean;
    enabled: boolean;
    active: boolean;
    schedule: string;
    nextRun: string;
    lastRun: string;
}

// --- Input validation ----------------------------------------------------

const SAFE_HOST_RE = /^[A-Za-z0-9._:[\]-]+$/;
const SAFE_SCHEDULE_RE = /^[A-Za-z0-9 ,:*/.-]+$/;

/** A host starting with "-" would be read as an option by ssh-keygen. */
export function assertSafeHost(host: string): string {
    const value = host.trim();
    if (!value || value.startsWith("-") || !SAFE_HOST_RE.test(value))
        throw new Error(_("Enter a host name, an address, or [host]:port."));
    return value;
}

// --- Parsing -------------------------------------------------------------

export function parseKnownHosts(content: string): KnownHostEntry[] {
    const entries: KnownHostEntry[] = [];
    content.split("\n").forEach((raw, index) => {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            return;
        const fields = line.split(/\s+/);
        const offset = (fields[0] === "@revoked" || fields[0] === "@cert-authority") ? 1 : 0;
        const hostnames = fields[offset];
        const keyType = fields[offset + 1];
        const blob = fields[offset + 2];
        if (!hostnames || !keyType || !blob)
            return;
        const hashed = hostnames.startsWith("|1|");
        entries.push({
            raw,
            lineNumber: index + 1,
            marker: offset ? fields[0] : "",
            hostnames: hashed ? "" : hostnames,
            hashed,
            keyType,
            blob,
            comment: fields.slice(offset + 3).join(" "),
            fingerprint: "",
            label: "",
        });
    });
    return entries;
}

/** Fingerprint every entry in one ssh-keygen call rather than one call per key. */
export async function annotateFingerprints(entries: KnownHostEntry[]): Promise<KnownHostEntry[]> {
    if (entries.length === 0)
        return entries;
    try {
        const proc = cockpit.spawn(["ssh-keygen", "-lf", "/dev/stdin"], { err: "message" });
        proc.input(entries.map(e => `host ${e.keyType} ${e.blob}`).join("\n") + "\n");
        const lines = (await proc).trim().split("\n");
        if (lines.length !== entries.length)
            return entries;
        return entries.map((entry, i) => ({ ...entry, fingerprint: lines[i].split(/\s+/)[1] ?? "" }));
    } catch {
        return entries;
    }
}

// --- Files ---------------------------------------------------------------

async function readQuiet(path: string): Promise<string> {
    const handle = cockpit.file(path, { superuser: "try" });
    try {
        return (await handle.read()) || "";
    } catch {
        return "";
    } finally {
        handle.close();
    }
}

export async function listKnownHostsFiles(users: SystemUser[]): Promise<KnownHostsFile[]> {
    const candidates: KnownHostsFile[] = [{
        path: SYSTEM_KNOWN_HOSTS,
        label: _("System-wide"),
        scope: "system",
        owner: null,
        exists: false,
    }];
    for (const user of users) {
        candidates.push({
            path: `${user.home}/.ssh/known_hosts`,
            label: user.name,
            scope: "user",
            owner: user.name,
            exists: false,
        });
    }

    let existing = new Set<string>();
    try {
        const out = await cockpit.spawn(
            ["/bin/sh", "-c", 'for p in "$@"; do [ -f "$p" ] && echo "$p"; done; :', "sh",
                ...candidates.map(c => c.path)],
            { superuser: "try", err: "ignore" });
        existing = new Set(out.split("\n").map(s => s.trim())
                .filter(Boolean));
    } catch { /* report everything as missing */ }

    // The system file is always offered so it can be created; user files are not.
    return candidates
            .map(c => ({ ...c, exists: existing.has(c.path) }))
            .filter(c => c.exists || c.scope === "system");
}

export function readKnownHosts(path: string): Promise<string> {
    return readQuiet(path);
}

export async function writeKnownHosts(path: string, content: string, expected: string): Promise<void> {
    const handle = cockpit.file(path, { superuser: "require" });
    try {
        await handle.modify(current => {
            if ((current || "") !== expected)
                throw new Error(_("The file changed on disk since it was loaded. Reload and try again."));
            return content;
        });
    } finally {
        handle.close();
    }
}

export async function removeEntry(path: string, raw: string): Promise<void> {
    const handle = cockpit.file(path, { superuser: "require" });
    try {
        await handle.modify(current => {
            const lines = (current || "").split("\n");
            const kept = lines.filter(line => line.trim() !== raw.trim());
            if (kept.length === lines.length)
                throw new Error(_("That entry is no longer in the file."));
            return kept.join("\n").replace(/\n{2,}$/, "\n");
        });
    } finally {
        handle.close();
    }
}

export async function appendEntries(path: string, lines: string[]): Promise<void> {
    const handle = cockpit.file(path, { superuser: "require" });
    try {
        await handle.modify(current => {
            const content = current || "";
            const prefix = content && !content.endsWith("\n") ? content + "\n" : content;
            return prefix + lines.map(l => l.trim()).filter(Boolean)
                    .join("\n") + "\n";
        });
    } finally {
        handle.close();
    }
}

/** ssh-keygen -F reports a match even for hashed entries. */
export async function findHost(path: string, host: string): Promise<KnownHostEntry[]> {
    const target = assertSafeHost(host);
    try {
        // Exits 0 with no output when nothing matches, so the output decides.
        const out = await cockpit.spawn(["ssh-keygen", "-F", target, "-f", path],
                                        { superuser: "require", err: "ignore" });
        return parseKnownHosts(out);
    } catch {
        return [];
    }
}

export async function removeHost(path: string, host: string): Promise<void> {
    const target = assertSafeHost(host);
    await cockpit.spawn(["ssh-keygen", "-R", target, "-f", path], { superuser: "require", err: "message" });
}

/** ssh-keygen -R and -H leave a .old file holding everything just removed. */
export async function hasStaleBackup(path: string): Promise<boolean> {
    try {
        await cockpit.spawn(["test", "-f", `${path}.old`], { superuser: "try", err: "ignore" });
        return true;
    } catch {
        return false;
    }
}

export async function deleteStaleBackup(path: string): Promise<void> {
    await cockpit.spawn(["rm", "-f", `${path}.old`], { superuser: "require", err: "message" });
}

export async function purgeAll(path: string): Promise<string> {
    const backup = `${path}.cockpit-bak`;
    await cockpit.spawn(["/bin/sh", "-c", 'cp -a "$1" "$2"', "sh", path, backup],
                        { superuser: "require", err: "message" });
    const handle = cockpit.file(path, { superuser: "require" });
    try {
        await handle.replace("");
    } finally {
        handle.close();
    }
    return backup;
}

/**
 * Trust on first use: the caller must show these fingerprints and get an explicit
 * confirmation. ssh-keyscan verifies nothing.
 */
export async function scanHost(host: string, port: string): Promise<KnownHostEntry[]> {
    const target = assertSafeHost(host);
    const args = ["ssh-keyscan", "-T", "5"];
    if (port.trim()) {
        if (!/^\d+$/.test(port.trim()))
            throw new Error(_("The port must be a number."));
        args.push("-p", port.trim());
    }
    args.push(target);

    // ssh-keyscan exits 0 even when the host fails, so check for output instead.
    const out = await cockpit.spawn(args, { err: "message" });
    const entries = parseKnownHosts(out);
    if (entries.length === 0)
        throw new Error(cockpit.format(_("No SSH keys could be retrieved from $0."), target));
    return annotateFingerprints(entries);
}

async function hostCandidates(path: string, entries: KnownHostEntry[]): Promise<string[]> {
    const names = new Set<string>();

    for (const entry of entries) {
        if (entry.hashed)
            continue;
        for (const name of entry.hostnames.split(","))
            if (name && !/[*?!]/.test(name))
                names.add(name);
    }

    for (const line of (await readQuiet("/etc/hosts")).split("\n")) {
        const trimmed = line.split("#")[0].trim();
        if (!trimmed)
            continue;
        for (const name of trimmed.split(/\s+/).slice(1))
            names.add(name);
    }

    const dir = path.slice(0, path.lastIndexOf("/"));
    for (const line of (await readQuiet(`${dir}/config`)).split("\n")) {
        const match = line.match(/^\s*Host\s+(.*)$/i);
        if (!match)
            continue;
        for (const name of match[1].split(/\s+/))
            if (name && !/[*?!]/.test(name))
                names.add(name);
    }

    return Array.from(names)
            .filter(name => SAFE_HOST_RE.test(name) && !name.startsWith("-"))
            .slice(0, 200);
}

/**
 * Hashed host names are HMAC-SHA1 and cannot be reversed. The best that can be
 * done is probing plausible names, so expect only partial coverage.
 */
export async function labelHashedEntries(path: string, entries: KnownHostEntry[]): Promise<KnownHostEntry[]> {
    const labelled = entries.map(entry => ({ ...entry }));
    if (!labelled.some(entry => entry.hashed))
        return labelled;

    for (const host of await hostCandidates(path, entries)) {
        for (const hit of await findHost(path, host)) {
            const match = labelled.find(entry =>
                entry.hashed && !entry.label && entry.keyType === hit.keyType && entry.blob === hit.blob);
            if (match)
                match.label = host;
        }
    }
    return labelled;
}

// --- Periodic report -----------------------------------------------------

const SERVICE_UNIT = `[Unit]
Description=Check SSH known_hosts entries against the live hosts
Documentation=man:ssh-keyscan(1)

[Service]
Type=oneshot
ExecStart=${SCRIPT_PATH}
ProtectSystem=strict
ReadWritePaths=${STATE_DIR}
ProtectHome=read-only
PrivateTmp=yes
NoNewPrivileges=yes
`;

const TIMER_UNIT = `[Unit]
Description=Periodic SSH known_hosts check

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
Unit=${REPORT_UNIT}.service

[Install]
WantedBy=timers.target
`;

async function writeRootFile(path: string, content: string): Promise<void> {
    const handle = cockpit.file(path, { superuser: "require" });
    try {
        await handle.replace(content);
    } finally {
        handle.close();
    }
}

export function validateSchedule(schedule: string): Promise<string> {
    const value = schedule.trim();
    if (!value || value.startsWith("-") || !SAFE_SCHEDULE_RE.test(value))
        return Promise.reject(new Error(_("That is not a valid systemd calendar expression.")));
    // systemd-analyze both validates the expression and says when it next fires.
    return cockpit.spawn(["systemd-analyze", "calendar", value], { err: "message" })
            .then(out => {
                const next = out.split("\n").find(line => line.startsWith("Next elapse:"));
                return next ? next.replace("Next elapse:", "").trim() : "";
            });
}

async function installReportAssets(): Promise<void> {
    await cockpit.spawn(["mkdir", "-p", LIBEXEC_DIR, CONFIG_DIR, STATE_DIR],
                        { superuser: "require", err: "message" });
    await writeRootFile(SCRIPT_PATH, reportScript);
    await cockpit.spawn(["chmod", "0755", SCRIPT_PATH], { superuser: "require", err: "message" });
    await writeRootFile(`${UNIT_DIR}/${REPORT_UNIT}.service`, SERVICE_UNIT);
    await writeRootFile(`${UNIT_DIR}/${REPORT_UNIT}.timer`, TIMER_UNIT);
    await cockpit.spawn(["systemctl", "daemon-reload"], { superuser: "require", err: "message" });
}

async function setSchedule(schedule: string): Promise<void> {
    await cockpit.spawn(["mkdir", "-p", `${UNIT_DIR}/${REPORT_UNIT}.timer.d`],
                        { superuser: "require", err: "message" });
    // A drop-in, so the shipped unit is never rewritten. The empty OnCalendar
    // clears the inherited value instead of adding a second schedule.
    await writeRootFile(`${UNIT_DIR}/${REPORT_UNIT}.timer.d/schedule.conf`,
                        `[Timer]\nOnCalendar=\nOnCalendar=${schedule}\n`);
    await cockpit.spawn(["systemctl", "daemon-reload"], { superuser: "require", err: "message" });
}

export async function enableReport(schedule: string, targets: string[]): Promise<void> {
    await installReportAssets();
    await writeRootFile(CONFIG_PATH, JSON.stringify({ targets, timeout: 5 }, null, 2) + "\n");
    await setSchedule(schedule);
    await cockpit.spawn(["systemctl", "enable", "--now", `${REPORT_UNIT}.timer`],
                        { superuser: "require", err: "message" });
}

export async function disableReport(): Promise<void> {
    await cockpit.spawn(["systemctl", "disable", "--now", `${REPORT_UNIT}.timer`],
                        { superuser: "require", err: "message" });
}

/** The unit is oneshot, so this resolves once the check has finished. */
export async function runReportNow(): Promise<void> {
    await cockpit.spawn(["systemctl", "start", `${REPORT_UNIT}.service`],
                        { superuser: "require", err: "message" });
}

function formatTimestamp(value: string | undefined): string {
    const usec = parseInt(value || "0", 10);
    if (!usec || Number.isNaN(usec) || usec > Number.MAX_SAFE_INTEGER)
        return "";
    return new Date(usec / 1000).toLocaleString();
}

export async function timerStatus(): Promise<TimerStatus> {
    const status: TimerStatus = {
        installed: false, enabled: false, active: false, schedule: "", nextRun: "", lastRun: "",
    };
    try {
        const out = await cockpit.spawn(
            ["systemctl", "show", `${REPORT_UNIT}.timer`,
                "--property=LoadState,UnitFileState,ActiveState,TimersCalendar," +
                "NextElapseUSecRealtime,LastTriggerUSec"],
            { err: "ignore" });
        const props: Record<string, string> = {};
        for (const line of out.trim().split("\n")) {
            const idx = line.indexOf("=");
            if (idx > 0)
                props[line.slice(0, idx)] = line.slice(idx + 1);
        }
        status.installed = props.LoadState === "loaded";
        status.enabled = props.UnitFileState === "enabled";
        status.active = props.ActiveState === "active";
        const calendar = (props.TimersCalendar || "").match(/OnCalendar=([^;{}]+)/);
        status.schedule = calendar ? calendar[1].trim() : "";
        status.nextRun = formatTimestamp(props.NextElapseUSecRealtime);
        status.lastRun = formatTimestamp(props.LastTriggerUSec);
    } catch { /* not installed */ }
    return status;
}

export async function readReport(): Promise<Report | null> {
    const content = await readQuiet(REPORT_PATH);
    if (!content)
        return null;
    try {
        return JSON.parse(content) as Report;
    } catch {
        return null;
    }
}

export async function reportJournal(): Promise<string> {
    try {
        return await cockpit.spawn(
            ["journalctl", "-u", `${REPORT_UNIT}.service`, "-n", "200", "--no-pager", "-o", "cat"],
            { superuser: "try", err: "ignore" });
    } catch {
        return "";
    }
}
