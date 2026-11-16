/**
 * Shell scripts and unit files for safe apply with automatic rollback.
 *
 * Scripts are generated only from constants and booleans: no user input is
 * ever interpolated. The ruleset itself reaches the apply script on stdin and
 * is checked with `nft -c` before anything is changed.
 *
 * Rollback runs server-side from a transient systemd timer (or a detached
 * `sleep` when systemd-run is unavailable), so it fires even if the browser
 * disconnects. Apply, confirm, revert and rollback serialize on a flock(1)
 * lock; `decision` records which of confirm or rollback won, and a per-apply
 * token keeps a stale rollback from reverting a later change.
 */

import { INET_TABLE_NAME, NAT_TABLE_NAME } from './model.js';

export const STATE_DIRECTORY = "/run/cockpit-firewall";
export const PERSISTED_RULESET_PATH = "/etc/nftables.d/cockpit-fw.nft";
export const CONFIGURATION_PATH = "/etc/cockpit-firewall/config.json";
export const SYSCTL_PATH = "/etc/sysctl.d/90-cockpit-firewall.conf";
export const BOOT_UNIT_NAME = "cockpit-firewall.service";
export const BOOT_UNIT_PATH = `/etc/systemd/system/${BOOT_UNIT_NAME}`;
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
} as const;

/** @returns the systemd unit that loads the persisted ruleset at boot and whenever nftables.service (re)starts. */
export function bootUnitText(): string {
    return [
        "[Unit]",
        `Description=Cockpit firewall rules (nftables tables inet ${INET_TABLE_NAME} and ip ${NAT_TABLE_NAME})`,
        "Documentation=https://github.com/ewertons/cockpit-applications/tree/main/cockpit-firewall",
        "DefaultDependencies=no",
        "Wants=network-pre.target",
        "Before=network-pre.target shutdown.target",
        "After=nftables.service",
        "PartOf=nftables.service",
        "ReloadPropagatedFrom=nftables.service",
        "Conflicts=shutdown.target",
        `ConditionPathExists=${PERSISTED_RULESET_PATH}`,
        "",
        "[Service]",
        "Type=oneshot",
        "RemainAfterExit=yes",
        `ExecStart=/usr/sbin/nft -f ${PERSISTED_RULESET_PATH}`,
        `ExecReload=/usr/sbin/nft -f ${PERSISTED_RULESET_PATH}`,
        "",
        "[Install]",
        "WantedBy=sysinit.target nftables.service",
        "",
    ].join("\n");
}

/** @returns the sysctl.d file enabling IPv4 forwarding. */
export function sysctlFileText(): string {
    return "# Managed by cockpit-firewall: forward or NAT rules are configured.\nnet.ipv4.ip_forward = 1\n";
}

/** @returns shell lines that print a ruleset deleting, then restoring, the app's current tables. */
function snapshotCommands(): string[] {
    return [
        "{",
        `    printf '%s\\n' 'table inet ${INET_TABLE_NAME}' 'delete table inet ${INET_TABLE_NAME}' 'table ip ${NAT_TABLE_NAME}' 'delete table ip ${NAT_TABLE_NAME}'`,
        `    nft list table inet ${INET_TABLE_NAME} 2>/dev/null || true`,
        `    nft list table ip ${NAT_TABLE_NAME} 2>/dev/null || true`,
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

function parentDirectory(path: string): string {
    return path.replace(/\/[^/]+$/, "");
}

function baseName(path: string): string {
    return path.replace(/^.*\//, "");
}

/** Preamble shared by apply, confirm and revert: strict mode and the transaction lock. */
const SCRIPT_PREAMBLE = [
    "set -eu",
    "umask 077",
    `state_directory="${STATE_DIRECTORY}"`,
    `rollback_unit="${ROLLBACK_UNIT_NAME}"`,
    `mkdir -p "$state_directory"`,
    ...LOCK_COMMANDS,
];

/** Runs rollback.sh for the current transaction while this script holds the lock. */
const RUN_ROLLBACK_NOW = `${LOCK_HELD_VARIABLE}=1 /bin/sh "$state_directory/rollback.sh" "$(cat "$state_directory/token")"`;

/**
 * Builds the apply script. It reads the new ruleset on stdin, checks it with
 * `nft -c`, snapshots the app's current tables, arms the rollback timer and
 * only then loads the new ruleset atomically with `nft -f`. The whole script
 * runs under the transaction lock, so concurrent applies are serialized.
 * @param enableForwarding set net.ipv4.ip_forward=1 at runtime (restored on rollback)
 *        and persist it on confirmation.
 */
export function applyScriptText(enableForwarding: boolean): string {
    return [
        ...SCRIPT_PREAMBLE,
        `if [ -e "$state_directory/armed" ] && [ ! -d "$state_directory/decision" ]; then`,
        `    echo "A previous change is still waiting for confirmation" >&2`,
        `    exit ${ExitCode.pendingConfirmation}`,
        "fi",
        `rm -rf "$state_directory/decision" "$state_directory/outcome" "$state_directory/armed" "$state_directory/token"`,
        `cat > "$state_directory/pending.nft"`,
        `nft -c -f "$state_directory/pending.nft"`,
        ...snapshotCommands(),
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
        ...enableForwarding ? ["echo 1 > /proc/sys/net/ipv4/ip_forward"] : [],
        `if ! nft -f "$state_directory/pending.nft"; then`,
        `    ${RUN_ROLLBACK_NOW} || true`,
        `    systemctl stop "$rollback_unit.timer" 2>/dev/null || true`,
        `    exit ${ExitCode.applyFailed}`,
        "fi",
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

/** Files written on confirmation; backed up first so a failed save can be undone. */
const PERSISTED_PATHS = [PERSISTED_RULESET_PATH, SYSCTL_PATH, BOOT_UNIT_PATH];

/**
 * Builds the confirm script ($1: token of the change the user reviewed). It persists the applied ruleset, the sysctl file
 * (as recorded by apply) and the boot unit, enables and starts the unit, and
 * only then cancels the rollback. If saving fails, the previous files are
 * restored and the change stays pending, so confirm can be retried or the
 * rollback still runs.
 */
export function confirmScriptText(): string {
    const backupDirectory = `"$state_directory/backup"`;
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
        `rm -rf ${backupDirectory}`,
        `mkdir -p ${backupDirectory}`,
        ...PERSISTED_PATHS.map(path => `if [ -e "${path}" ]; then cp -p "${path}" ${backupDirectory}/${baseName(path)}; fi`),
        `unit_was_enabled=$(systemctl is-enabled "${BOOT_UNIT_NAME}" 2>/dev/null || true)`,
        "restore_previous_files() {",
        ...PERSISTED_PATHS.map(path => `    if [ -e ${backupDirectory}/${baseName(path)} ]; then cp -p ${backupDirectory}/${baseName(path)} "${path}"; else rm -f "${path}"; fi`),
        `    [ "$unit_was_enabled" = enabled ] || systemctl disable "${BOOT_UNIT_NAME}" >/dev/null 2>&1 || true`,
        "    systemctl daemon-reload || true",
        "}",
        "persist() {",
        `    mkdir -p "${parentDirectory(PERSISTED_RULESET_PATH)}" "${parentDirectory(SYSCTL_PATH)}" "${parentDirectory(BOOT_UNIT_PATH)}" || return 1`,
        `    install -m 600 "$state_directory/pending.nft" "${PERSISTED_RULESET_PATH}.new" || return 1`,
        `    mv -f "${PERSISTED_RULESET_PATH}.new" "${PERSISTED_RULESET_PATH}" || return 1`,
        `    if [ "$(cat "$state_directory/forwarding" 2>/dev/null)" = 1 ]; then`,
        `        cat > "${SYSCTL_PATH}.new" <<'COCKPIT_FIREWALL_SYSCTL' || return 1`,
        sysctlFileText() + "COCKPIT_FIREWALL_SYSCTL",
        `        chmod 644 "${SYSCTL_PATH}.new" && mv -f "${SYSCTL_PATH}.new" "${SYSCTL_PATH}" || return 1`,
        "    else",
        `        rm -f "${SYSCTL_PATH}" || return 1`,
        "    fi",
        `    cat > "${BOOT_UNIT_PATH}.new" <<'COCKPIT_FIREWALL_UNIT' || return 1`,
        bootUnitText() + "COCKPIT_FIREWALL_UNIT",
        `    chmod 644 "${BOOT_UNIT_PATH}.new" && mv -f "${BOOT_UNIT_PATH}.new" "${BOOT_UNIT_PATH}" || return 1`,
        "    systemctl daemon-reload || return 1",
        `    systemctl enable "${BOOT_UNIT_NAME}" >/dev/null || return 1`,
        // Started now so ReloadPropagatedFrom=nftables.service works before the next boot.
        `    systemctl start "${BOOT_UNIT_NAME}" || return 1`,
        "}",
        "if ! persist; then",
        `    rm -f "${PERSISTED_RULESET_PATH}.new" "${SYSCTL_PATH}.new" "${BOOT_UNIT_PATH}.new"`,
        "    restore_previous_files",
        `    echo "Saving the rules failed; previous files were restored. The change is still pending: retry, or it is rolled back automatically." >&2`,
        `    exit ${ExitCode.persistFailed}`,
        "fi",
        `mkdir "$state_directory/decision"`,
        `systemctl stop "$rollback_unit.timer" 2>/dev/null || true`,
        `rm -f "$state_directory/armed"`,
        `echo confirmed > "$state_directory/outcome"`,
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
