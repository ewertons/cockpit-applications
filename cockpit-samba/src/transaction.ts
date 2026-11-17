/**
 * Shell scripts for reading and safely replacing smb.conf.
 *
 * Scripts are generated only from constant paths; user data (the candidate
 * file) arrives on stdin and the expected hash as $1. A candidate is written
 * next to smb.conf, checked with `testparm -s`, and only then moved over it
 * atomically after a timestamped backup, so a rejected candidate never
 * replaces the live file. Concurrent changes are detected with the SHA-256 of
 * the file the user edited. smbd and nmbd are told to reload when running.
 */

export interface TransactionPaths {
    configurationPath: string;
    backupDirectory: string;
    stateDirectory: string;
}

export const DEFAULT_PATHS: TransactionPaths = {
    configurationPath: "/etc/samba/smb.conf",
    backupDirectory: "/var/lib/cockpit-samba/backups",
    stateDirectory: "/run/cockpit-samba",
};

/** Number of backups kept; older ones are removed after each apply. */
export const BACKUPS_KEPT = 50;

/** Hash value standing for "smb.conf does not exist". */
export const ABSENT_HASH = "absent";

/** Backup file names: smb.conf.YYYYMMDD-HHMMSS (UTC) with an optional -N for several in one second. */
export const BACKUP_NAME_PATTERN = /^smb\.conf\.(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(-\d+)?$/;

/** Exit codes shared between scripts and UI. */
export const ExitCode = {
    testparmFailed: 5,
    writeFailed: 8,
    changedElsewhere: 9,
} as const;

/** @returns `text` quoted for /bin/sh. */
export function shellQuote(text: string): string {
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

function preamble(paths: TransactionPaths): string[] {
    return [
        "set -eu",
        "umask 077",
        `config=${shellQuote(paths.configurationPath)}`,
        `backups=${shellQuote(paths.backupDirectory)}`,
        `state=${shellQuote(paths.stateDirectory)}`,
    ];
}

const HASH_CURRENT = [
    `if [ -e "$config" ]; then current=$(sha256sum < "$config" | cut -d' ' -f1); else current=${ABSENT_HASH}; fi`,
];

/** Exits with changedElsewhere unless smb.conf still has the hash given as const HASH_CURRENT = [
    `if [ -e "$config" ]; then current=$(sha256sum < "$config" | cut -d' ' -f1); else current=${ABSENT_HASH}; fi`,
];
. */
const REFUSE_IF_CHANGED = [
    ...HASH_CURRENT,
    `if [ "$current" != "\${1:-}" ]; then`,
    `    echo "smb.conf was changed since it was loaded; reload the page and redo the change" >&2`,
    `    exit ${ExitCode.changedElsewhere}`,
    "fi",
];

/** @returns the script printing "present <sha256>" and the file, or "absent". */
export function snapshotScriptText(paths: TransactionPaths = DEFAULT_PATHS): string {
    return [
        ...preamble(paths),
        `if [ -e "$config" ]; then`,
        "    snapshot=$(mktemp)",
        `    trap 'rm -f "$snapshot"' EXIT`,
        `    cat "$config" > "$snapshot"`,
        `    printf 'present %s\\n' "$(sha256sum < "$snapshot" | cut -d' ' -f1)"`,
        `    cat "$snapshot"`,
        "else",
        `    echo ${ABSENT_HASH}`,
        "fi",
        "",
    ].join("\n");
}

/**
 * @returns the script that runs testparm on the candidate read from stdin
 * without changing anything. Prints "testparm-exit <code>" and then testparm's
 * diagnostics (its stderr); always exits 0 unless the script itself fails.
 */
export function checkScriptText(paths: TransactionPaths = DEFAULT_PATHS): string {
    return [
        ...preamble(paths),
        `mkdir -p "$state"`,
        `candidate=$(mktemp "$state/check.XXXXXX")`,
        `diagnostics=$(mktemp "$state/check-diagnostics.XXXXXX")`,
        `trap 'rm -f "$candidate" "$diagnostics"' EXIT`,
        `cat > "$candidate"`,
        "status=0",
        `testparm -s "$candidate" >/dev/null 2>"$diagnostics" || status=$?`,
        `echo "testparm-exit $status"`,
        `cat "$diagnostics"`,
        "",
    ].join("\n");
}

/**
 * @returns the apply script. $1 is the hash of the smb.conf the user edited
 * (or "absent"); the candidate comes on stdin. On success it prints
 * "backup <name>" (when there was a previous file), one
 * "reload <daemon> ok|failed|not-running" per daemon, then "diagnostics" and
 * testparm's messages.
 */
export function applyScriptText(paths: TransactionPaths = DEFAULT_PATHS): string {
    return [
        ...preamble(paths),
        `mkdir -p "$state"`,
        `exec 9>"$state/lock"`,
        "flock 9",
        // Replace the target of a symlinked smb.conf, not the link itself.
        `if [ -L "$config" ]; then config=$(readlink -f -- "$config"); fi`,
        `candidate=$(mktemp "$(dirname -- "$config")/.smb.conf.cockpit-XXXXXX")`,
        `diagnostics=$(mktemp "$state/apply-diagnostics.XXXXXX")`,
        `trap 'rm -f "$candidate" "$diagnostics"' EXIT`,
        `cat > "$candidate"`,
        ...REFUSE_IF_CHANGED,
        `if ! testparm -s "$candidate" >/dev/null 2>"$diagnostics"; then`,
        `    cat "$diagnostics" >&2`,
        `    exit ${ExitCode.testparmFailed}`,
        "fi",
        // External editors do not take the lock: check again after testparm.
        ...REFUSE_IF_CHANGED,
        `if [ -e "$config" ]; then`,
        `    mkdir -p "$backups"`,
        `    chmod 700 "$backups"`,
        "    stamp=$(date -u +%Y%m%d-%H%M%S)",
        `    backup="smb.conf.$stamp"`,
        "    counter=1",
        `    while [ -e "$backups/$backup" ]; do backup="smb.conf.$stamp-$counter"; counter=$((counter + 1)); done`,
        `    cp -p "$config" "$backups/$backup" || { echo "Cannot write the backup" >&2; exit ${ExitCode.writeFailed}; }`,
        `    chmod --reference="$config" "$candidate"`,
        `    chown --reference="$config" "$candidate" 2>/dev/null || true`,
        `    echo "backup $backup"`,
        "else",
        `    chmod 644 "$candidate"`,
        "fi",
        `mv -f "$candidate" "$config" || { echo "Cannot replace $config" >&2; exit ${ExitCode.writeFailed}; }`,
        `if [ -d "$backups" ]; then`,
        `    ls -1 "$backups" | grep -E '^smb\\.conf\\.[0-9]{8}-[0-9]{6}(-[0-9]+)?$' | sort -V | head -n -${BACKUPS_KEPT} | while read -r old; do rm -f "$backups/$old"; done`,
        "fi",
        "for daemon in smbd nmbd; do",
        `    if smbcontrol --configfile="$config" "$daemon" ping >/dev/null 2>&1; then`,
        `        if smbcontrol --configfile="$config" "$daemon" reload-config >/dev/null 2>&1; then echo "reload $daemon ok"; else echo "reload $daemon failed"; fi`,
        "    else",
        `        echo "reload $daemon not-running"`,
        "    fi",
        "done",
        "echo diagnostics",
        `cat "$diagnostics"`,
        "",
    ].join("\n");
}

/** @returns the script listing backups as "<name>\t<size>" lines. */
export function listBackupsScriptText(paths: TransactionPaths = DEFAULT_PATHS): string {
    return [
        ...preamble(paths),
        `[ -d "$backups" ] || exit 0`,
        `find "$backups" -maxdepth 1 -type f -name 'smb.conf.*' -printf '%f\\t%s\\n'`,
        "",
    ].join("\n");
}

export interface ConfigurationSnapshot {
    exists: boolean;
    /** SHA-256 of the file, or ABSENT_HASH. */
    hash: string;
    text: string;
}

/** @returns the parsed output of the snapshot script. */
export function parseSnapshot(output: string): ConfigurationSnapshot {
    const newline = output.indexOf("\n");
    const firstLine = newline < 0 ? output : output.slice(0, newline);
    const present = /^present ([0-9a-f]{64})$/.exec(firstLine);
    if (present)
        return { exists: true, hash: present[1], text: output.slice(newline + 1) };
    if (firstLine.trim() === ABSENT_HASH)
        return { exists: false, hash: ABSENT_HASH, text: "" };
    throw new Error(`Unexpected snapshot output: ${firstLine}`);
}

export interface TestparmResult {
    /** testparm accepted the file. */
    passed: boolean;
    /** Parameters testparm does not know; Samba ignores them. */
    unknownParameters: string[];
    /** WARNING lines and other errors, without the routine progress messages. */
    messages: string[];
}

/** testparm progress lines that carry no information for the user. */
const ROUTINE_TESTPARM_LINES = [
    /^Load smb config files from /,
    /^Loaded services file OK\.?$/,
    /^Server role: /,
    /^Weak crypto is allowed/,
    /^Press enter to see a dump/,
    /^Ignoring unknown parameter /,
];

/** @returns the interesting parts of testparm's stderr. */
export function parseTestparmDiagnostics(text: string, passed: boolean): TestparmResult {
    const unknownParameters: string[] = [];
    const messages: string[] = [];
    for (const line of text.split("\n").map(line => line.trim())
            .filter(Boolean)) {
        const unknown = /^Unknown parameter encountered: "(.*)"$/.exec(line);
        if (unknown) {
            if (!unknownParameters.includes(unknown[1]))
                unknownParameters.push(unknown[1]);
            continue;
        }
        if (!ROUTINE_TESTPARM_LINES.some(pattern => pattern.test(line)))
            messages.push(line);
    }
    return { passed, unknownParameters, messages };
}

/** @returns the parsed output of the check script. */
export function parseCheckOutput(output: string): TestparmResult {
    const newline = output.indexOf("\n");
    const firstLine = newline < 0 ? output : output.slice(0, newline);
    const status = /^testparm-exit (\d+)$/.exec(firstLine.trim());
    if (!status)
        throw new Error(`Unexpected check output: ${firstLine}`);
    return parseTestparmDiagnostics(newline < 0 ? "" : output.slice(newline + 1), status[1] === "0");
}

export type ReloadState = "ok" | "failed" | "not-running";

export interface ApplyResult {
    /** Name of the backup of the previous file, or null when there was none. */
    backupName: string | null;
    reloads: { daemon: string; state: ReloadState }[];
    testparm: TestparmResult;
}

/** @returns the parsed output of a successful apply script. */
export function parseApplyOutput(output: string): ApplyResult {
    const lines = output.split("\n");
    const result: ApplyResult = { backupName: null, reloads: [], testparm: { passed: true, unknownParameters: [], messages: [] } };
    let index = 0;
    for (; index < lines.length; index++) {
        const line = lines[index];
        if (line === "diagnostics")
            break;
        const backup = /^backup (\S+)$/.exec(line);
        if (backup && BACKUP_NAME_PATTERN.test(backup[1]))
            result.backupName = backup[1];
        const reload = /^reload (smbd|nmbd) (ok|failed|not-running)$/.exec(line);
        if (reload)
            result.reloads.push({ daemon: reload[1], state: reload[2] as ReloadState });
    }
    result.testparm = parseTestparmDiagnostics(lines.slice(index + 1).join("\n"), true);
    return result;
}

export interface BackupEntry {
    name: string;
    size: number;
    /** Time encoded in the name (local time of the server). */
    createdAt: Date;
}

/** @returns backups from the list script, newest first; unknown names are skipped. */
export function parseBackupList(output: string): BackupEntry[] {
    const entries: BackupEntry[] = [];
    for (const line of output.split("\n")) {
        const [name, size] = line.split("\t");
        const match = BACKUP_NAME_PATTERN.exec(name ?? "");
        if (!match)
            continue;
        const [, year, month, day, hour, minute, second] = match.map(Number);
        entries.push({ name, size: Number(size) || 0, createdAt: new Date(Date.UTC(year, month - 1, day, hour, minute, second)) });
    }
    return entries.sort((first, second) => second.name.localeCompare(first.name, undefined, { numeric: true }));
}
