/**
 * Shell scripts for safe apply with automatic rollback.
 *
 * Scripts are generated only from constants and booleans: no user input is
 * ever interpolated. The live tables and the candidate /etc/nftables.conf
 * reach the apply script on stdin and are checked with `nft -c` before
 * anything is changed. Apply only loads this app's tables; the file is
 * written on confirmation, never loaded with `nft -f` as a whole, because its
 * `flush ruleset` would also drop tables of other tools.
 *
 * Rollback runs server-side from a transient systemd timer (or a detached
 * `sleep` when systemd-run is unavailable), so it fires even if the browser
 * disconnects. Apply, confirm, revert and rollback serialize on a flock(1)
 * lock; `decision` records which of confirm or rollback won, and a per-apply
 * token keeps a stale rollback from reverting a later change.
 */

import { INET_TABLE_NAME, LEGACY_NAT_TABLE_NAME } from './model.js';
import { NFTABLES_CONFIGURATION_PATH, STOCK_FILTER_TABLE } from './nftables-file.js';

export const STATE_DIRECTORY = "/run/cockpit-firewall";
export const SYSCTL_PATH = "/etc/sysctl.d/90-cockpit-firewall.conf";
export const BACKUP_DIRECTORY = "/var/backups/cockpit-firewall";
/** Files of earlier versions, moved to BACKUP_DIRECTORY on the first confirmation. */
export const LEGACY_CONFIGURATION_PATH = "/etc/cockpit-firewall/config.json";
export const LEGACY_RULESET_PATH = "/etc/nftables.d/cockpit-fw.nft";
export const LEGACY_UNIT_NAME = "cockpit-firewall.service";
export const LEGACY_UNIT_PATH = `/etc/systemd/system/${LEGACY_UNIT_NAME}`;
export const ROLLBACK_UNIT_NAME = "cockpit-firewall-rollback";
export const ROLLBACK_TIMEOUT_SECONDS = 60;
const LOCK_PATH = `${STATE_DIRECTORY}/lock`;
const LOCK_HELD_VARIABLE = "COCKPIT_FIREWALL_LOCK_HELD";

/** Exit codes shared between scripts and UI. */
export const ExitCode = {
    pendingConfirmation: 4,
    applyFailed: 5,
    nothingToConfirm: 6,
    alreadyRolledBack: 7,
    persistFailed: 8,
    otherChangePending: 9,
    fileChanged: 10,
} as const;

/** @returns the sysctl.d file enabling IPv4 forwarding. */
export function sysctlFileText(): string {
    return "# Managed by cockpit-firewall: forward or NAT rules are configured.\nnet.ipv4.ip_forward = 1\n";
}

/** Tables the apply may replace or delete, and therefore the rollback restores. */
function touchedTables(removeStockFilterTable: boolean): string[] {
    return [
        `inet ${INET_TABLE_NAME}`,
        `ip ${LEGACY_NAT_TABLE_NAME}`,
        ...removeStockFilterTable ? [`${STOCK_FILTER_TABLE.family} ${STOCK_FILTER_TABLE.name}`] : [],
    ];
}

/** @returns shell lines that print a ruleset deleting, then restoring, the tables the apply touches. */
function snapshotCommands(removeStockFilterTable: boolean): string[] {
    const tables = touchedTables(removeStockFilterTable);
    return [
        "{",
        `    printf '%s\\n' ${tables.map(table => `'table ${table}' 'delete table ${table}'`).join(" ")}`,
        ...tables.map(table => `    nft list table ${table} 2>/dev/null || true`),
        `} > "$state_directory/rollback.nft"`,
    ];
}

/** Shell lines taking the transaction lock (fd 9) unless the caller already holds it. */
const LOCK_COMMANDS = [
    `if [ -z "\${${LOCK_HELD_VARIABLE}:-}" ]; then`,
    `    exec 9>"${LOCK_PATH}"`,
    "    flock 9",
    "fi",
];

/**
 * @returns the rollback script. Its first argument is the token of the apply
 * that armed it; it does nothing when a newer apply replaced that token or a
 * decision was already taken, so stale timers or sleepers cannot revert a later change.
 * /etc/nftables.conf needs no rollback: it is only written on confirmation.
 */
export function rollbackScriptText(): string {
    return [
        "#!/bin/sh",
        ...LOCK_COMMANDS,
        `[ "$(cat "${STATE_DIRECTORY}/token" 2>/dev/null)" = "\${1:-}" ] || exit 0`,
        `mkdir "${STATE_DIRECTORY}/decision" 2>/dev/null || exit 0`,
        `cat "${STATE_DIRECTORY}/previous-ip-forward" > /proc/sys/net/ipv4/ip_forward`,
        `if nft -f "${STATE_DIRECTORY}/rollback.nft"; then`,
        `    echo rolled-back > "${STATE_DIRECTORY}/outcome"`,
        "else",
        `    echo rollback-failed > "${STATE_DIRECTORY}/outcome"`,
        "    exit 1",
        "fi",
        "",
    ].join("\n");
}

/** Preamble shared by apply, confirm and revert: strict mode and the transaction lock. */
const SCRIPT_PREAMBLE = [
    "set -eu",
    "umask 077",
    `state_directory="${STATE_DIRECTORY}"`,
    `rollback_unit="${ROLLBACK_UNIT_NAME}"`,
    `configuration_file="${NFTABLES_CONFIGURATION_PATH}"`,
    `mkdir -p "$state_directory"`,
    ...LOCK_COMMANDS,
];

/**
 * Prints the sha256 of /etc/nftables.conf as if it ended with a newline (the
 * form in which the reviewed copy reaches the apply script), or "absent".
 */
const FILE_DIGEST_COMMAND = `if [ -e "$configuration_file" ]; then { cat "$configuration_file"; [ -z "$(tail -c1 "$configuration_file")" ] || echo; } | sha256sum | cut -d' ' -f1; else echo absent; fi`;

/** Runs rollback.sh for the current transaction while this script holds the lock. */
const RUN_ROLLBACK_NOW = `${LOCK_HELD_VARIABLE}=1 /bin/sh "$state_directory/rollback.sh" "$(cat "$state_directory/token")"`;

/**
 * Builds the apply script. Its stdin is the text to load live, a line holding
 * only the separator given as $1 (32 lowercase hex digits), the candidate
 * /etc/nftables.conf, the separator again, then the file the user reviewed
 * ($2: "present", or "absent" when there was none). It refuses if the file no
 * longer matches the reviewed one, checks both texts with `nft -c`, records the
 * reviewed file's digest for confirmation,
 * snapshots the tables it touches, arms the rollback timer and only then loads
 * the live text atomically with `nft -f`. The whole script runs under the
 * transaction lock, so concurrent applies are serialized.
 * @param enableForwarding set net.ipv4.ip_forward=1 at runtime (restored on rollback)
 *        and persist it on confirmation.
 * @param removeStockFilterTable the live text deletes the stock `table inet filter`; snapshot it for rollback.
 */
export function applyScriptText(enableForwarding: boolean, removeStockFilterTable: boolean): string {
    return [
        ...SCRIPT_PREAMBLE,
        `case "\${1:-}" in`,
        "    *[!0-9a-f]*|'') echo 'Invalid separator' >&2; exit 2 ;;",
        "esac",
        `[ "\${#1}" -eq 32 ] || { echo 'Invalid separator' >&2; exit 2; }`,
        `if [ -e "$state_directory/armed" ] && [ ! -d "$state_directory/decision" ]; then`,
        `    echo "A previous change is still waiting for confirmation" >&2`,
        `    exit ${ExitCode.pendingConfirmation}`,
        "fi",
        `rm -rf "$state_directory/decision" "$state_directory/outcome" "$state_directory/armed" "$state_directory/token"`,
        `case "\${2:-}" in present|absent) ;; *) echo 'Invalid file state' >&2; exit 2 ;; esac`,
        `awk -v separator="$1" -v live="$state_directory/pending.nft" -v file="$state_directory/pending.conf" -v basis="$state_directory/basis.conf" \\`,
        `    'BEGIN { target = live; printf "" > live; printf "" > file; printf "" > basis }`,
        `     $0 == separator && target == live { target = file; next }`,
        `     $0 == separator && target == file { target = basis; next }`,
        `     { print > target }'`,
        `if [ "$2" = absent ]; then basis_digest=absent; else basis_digest=$(sha256sum < "$state_directory/basis.conf" | cut -d' ' -f1); fi`,
        `if [ "$(${FILE_DIGEST_COMMAND})" != "$basis_digest" ]; then`,
        `    echo "$configuration_file changed since it was reviewed; reload the page and apply again" >&2`,
        `    exit ${ExitCode.fileChanged}`,
        "fi",
        `nft -c -f "$state_directory/pending.nft"`,
        `nft -c -f "$state_directory/pending.conf"`,
        `echo "$basis_digest" > "$state_directory/file-digest"`,
        ...snapshotCommands(removeStockFilterTable),
        `cat /proc/sys/net/ipv4/ip_forward > "$state_directory/previous-ip-forward"`,
        `echo ${enableForwarding ? 1 : 0} > "$state_directory/forwarding"`,
        `cat > "$state_directory/rollback.sh" <<'COCKPIT_FIREWALL_ROLLBACK'`,
        rollbackScriptText() + "COCKPIT_FIREWALL_ROLLBACK",
        `token=$(cat /proc/sys/kernel/random/uuid)`,
        `echo "$token" > "$state_directory/token"`,
        `systemctl stop "$rollback_unit.timer" "$rollback_unit.service" 2>/dev/null || true`,
        `systemctl reset-failed "$rollback_unit.timer" "$rollback_unit.service" 2>/dev/null || true`,
        `if ! { command -v systemd-run >/dev/null 2>&1 && systemd-run --quiet --unit="$rollback_unit" --on-active=${ROLLBACK_TIMEOUT_SECONDS} --timer-property=AccuracySec=1s /bin/sh "$state_directory/rollback.sh" "$token" 9>&-; }; then`,
        `    setsid /bin/sh -c 'sleep ${ROLLBACK_TIMEOUT_SECONDS}; exec /bin/sh "$0" "$1"' "$state_directory/rollback.sh" "$token" </dev/null >/dev/null 2>&1 9>&- &`,
        "fi",
        `touch "$state_directory/armed"`,
        `if ! nft -f "$state_directory/pending.nft"; then`,
        `    ${RUN_ROLLBACK_NOW} || true`,
        `    systemctl stop "$rollback_unit.timer" 2>/dev/null || true`,
        `    exit ${ExitCode.applyFailed}`,
        "fi",
        // Only once the new filter is in place, so nothing is routed unfiltered.
        ...enableForwarding ? ["echo 1 > /proc/sys/net/ipv4/ip_forward"] : [],
        "",
    ].join("\n");
}

/** Rejects the request unless the pending change is the one the caller ($1) reviewed. */
const EXPECTED_TOKEN_CHECK = [
    `if [ "$(cat "$state_directory/token" 2>/dev/null)" != "\${1:-}" ]; then`,
    `    echo "Another change replaced the one shown; reload the page" >&2`,
    `    exit ${ExitCode.otherChangePending}`,
    "fi",
];

/** Moves files of earlier versions to a dated backup directory; failures are not fatal. */
const LEGACY_CLEANUP = [
    `if [ -e "${LEGACY_CONFIGURATION_PATH}" ] || [ -e "${LEGACY_RULESET_PATH}" ] || [ -e "${LEGACY_UNIT_PATH}" ]; then`,
    `    legacy_backup="${BACKUP_DIRECTORY}/legacy-$(date +%Y%m%d-%H%M%S)"`,
    `    mkdir -p "$legacy_backup" || true`,
    `    systemctl disable "${LEGACY_UNIT_NAME}" >/dev/null 2>&1 || true`,
    ...[LEGACY_CONFIGURATION_PATH, LEGACY_RULESET_PATH, LEGACY_UNIT_PATH]
            .map(path => `    if [ -e "${path}" ]; then mv -f "${path}" "$legacy_backup/" || true; fi`),
    `    rmdir "${LEGACY_CONFIGURATION_PATH.replace(/\/[^/]+$/, "")}" 2>/dev/null || true`,
    "    systemctl daemon-reload || true",
    "fi",
];

/**
 * Builds the confirm script ($1: token of the change the user reviewed). It
 * refuses when /etc/nftables.conf changed since the apply, backs the file up
 * to BACKUP_DIRECTORY/nftables.conf.previous, writes the candidate in place
 * (following a symlink, keeping mode and owner), writes or removes the sysctl
 * file, enables nftables.service and only then cancels the rollback. If saving
 * fails, the previous files are restored and the change stays pending, so
 * confirm can be retried or the rollback still runs. Files of earlier
 * versions are then moved to a backup directory.
 */
export function confirmScriptText(): string {
    return [
        ...SCRIPT_PREAMBLE,
        `if [ ! -e "$state_directory/armed" ]; then`,
        `    echo "No change is waiting for confirmation" >&2`,
        `    exit ${ExitCode.nothingToConfirm}`,
        "fi",
        `if [ -d "$state_directory/decision" ]; then`,
        `    echo "The change was already rolled back" >&2`,
        `    exit ${ExitCode.alreadyRolledBack}`,
        "fi",
        ...EXPECTED_TOKEN_CHECK,
        `if [ "$(${FILE_DIGEST_COMMAND})" != "$(cat "$state_directory/file-digest")" ]; then`,
        `    echo "$configuration_file was changed by something else since Apply; revert, reload the page and apply again" >&2`,
        `    exit ${ExitCode.fileChanged}`,
        "fi",
        `target=$(readlink -f "$configuration_file" || echo "$configuration_file")`,
        `mkdir -p "${BACKUP_DIRECTORY}"`,
        `chmod 700 "${BACKUP_DIRECTORY}"`,
        `rm -f "${BACKUP_DIRECTORY}/nftables.conf.previous" "$state_directory/sysctl.previous"`,
        `if [ -e "$target" ]; then cp -p "$target" "${BACKUP_DIRECTORY}/nftables.conf.previous"; fi`,
        `if [ -e "${SYSCTL_PATH}" ]; then cp -p "${SYSCTL_PATH}" "$state_directory/sysctl.previous"; fi`,
        `service_was_enabled=$(systemctl is-enabled nftables.service 2>/dev/null || true)`,
        "restore_previous_files() {",
        `    if [ -e "${BACKUP_DIRECTORY}/nftables.conf.previous" ]; then cp -p "${BACKUP_DIRECTORY}/nftables.conf.previous" "$target"; else rm -f "$target"; fi`,
        `    if [ -e "$state_directory/sysctl.previous" ]; then cp -p "$state_directory/sysctl.previous" "${SYSCTL_PATH}"; else rm -f "${SYSCTL_PATH}"; fi`,
        `    [ "$service_was_enabled" = enabled ] || systemctl disable nftables.service >/dev/null 2>&1 || true`,
        "}",
        "persist() {",
        `    if [ -e "$target" ]; then`,
        `        cp -p "$target" "$target.new" || return 1`,
        "    else",
        `        install -m 755 /dev/null "$target.new" || return 1`,
        "    fi",
        `    cat "$state_directory/pending.conf" > "$target.new" || return 1`,
        `    mv -f "$target.new" "$target" || return 1`,
        `    if [ "$(cat "$state_directory/forwarding" 2>/dev/null)" = 1 ]; then`,
        `        mkdir -p "${SYSCTL_PATH.replace(/\/[^/]+$/, "")}" || return 1`,
        `        cat > "${SYSCTL_PATH}.new" <<'COCKPIT_FIREWALL_SYSCTL' || return 1`,
        sysctlFileText() + "COCKPIT_FIREWALL_SYSCTL",
        `        chmod 644 "${SYSCTL_PATH}.new" && mv -f "${SYSCTL_PATH}.new" "${SYSCTL_PATH}" || return 1`,
        "    else",
        `        rm -f "${SYSCTL_PATH}" || return 1`,
        "    fi",
        // Loads the file at boot. Not restarted now: the live tables already match.
        "    systemctl enable nftables.service >/dev/null || return 1",
        "}",
        "if ! persist; then",
        `    rm -f "$target.new" "${SYSCTL_PATH}.new"`,
        "    restore_previous_files",
        `    echo "Saving the rules failed; previous files were restored. The change is still pending: retry, or it is rolled back automatically." >&2`,
        `    exit ${ExitCode.persistFailed}`,
        "fi",
        `mkdir "$state_directory/decision"`,
        `systemctl stop "$rollback_unit.timer" 2>/dev/null || true`,
        `rm -f "$state_directory/armed"`,
        `echo confirmed > "$state_directory/outcome"`,
        ...LEGACY_CLEANUP,
        "",
    ].join("\n");
}

/** @returns the script that rolls back immediately ("Revert now"); $1 is the token of the change shown. */
export function revertScriptText(): string {
    return [
        ...SCRIPT_PREAMBLE,
        `if [ ! -e "$state_directory/armed" ] || [ -d "$state_directory/decision" ]; then`,
        `    echo "No change is waiting for confirmation" >&2`,
        `    exit ${ExitCode.nothingToConfirm}`,
        "fi",
        ...EXPECTED_TOKEN_CHECK,
        `systemctl stop "$rollback_unit.timer" 2>/dev/null || true`,
        RUN_ROLLBACK_NOW,
        "",
    ].join("\n");
}

/**
 * Status script. Prints one of: "none", "pending <seconds left> <token>",
 * "rolled-back", "rollback-failed", "confirmed".
 */
export function statusScriptText(): string {
    return [
        "set -eu",
        `state_directory="${STATE_DIRECTORY}"`,
        `if [ -e "$state_directory/armed" ] && [ ! -d "$state_directory/decision" ]; then`,
        `    armed_at=$(stat -c %Y "$state_directory/armed")`,
        `    now=$(date +%s)`,
        `    left=$((armed_at + ${ROLLBACK_TIMEOUT_SECONDS} - now))`,
        `    [ "$left" -ge 0 ] || left=0`,
        `    echo "pending $left $(cat "$state_directory/token" 2>/dev/null)"`,
        `elif [ -s "$state_directory/outcome" ]; then`,
        `    cat "$state_directory/outcome"`,
        "else",
        "    echo none",
        "fi",
        "",
    ].join("\n");
}

/** Parsed output of the status script. */
export type TransactionStatus =
    | { state: "none" | "rolled-back" | "rollback-failed" | "confirmed" }
    | { state: "pending"; secondsLeft: number; token: string };

/** @returns the parsed status script output. Unknown output maps to "none". */
export function parseTransactionStatus(output: string): TransactionStatus {
    const text = output.trim();
    const pending = /^pending (\d+) ([0-9a-f-]{36})$/.exec(text);
    if (pending)
        return { state: "pending", secondsLeft: Number(pending[1]), token: pending[2] };
    if (text === "rolled-back" || text === "rollback-failed" || text === "confirmed")
        return { state: text };
    return { state: "none" };
}
