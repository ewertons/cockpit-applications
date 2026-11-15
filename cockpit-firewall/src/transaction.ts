/**
 * Shell scripts and unit files for safe apply with automatic rollback.
 *
 * Scripts are generated only from constants and booleans: no user input is
 * ever interpolated. The ruleset itself reaches the apply script on stdin and
 * is checked with `nft -c` before anything is changed.
 *
 * Rollback runs server-side from a transient systemd timer (or a detached
 * `sleep` when systemd-run is unavailable), so it fires even if the browser
 * disconnects. Confirm and rollback race on `mkdir decision`, which is atomic:
 * whichever runs first wins and the other becomes a no-op.
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

/** Exit codes shared between scripts and UI. */
export const ExitCode = {
    pendingConfirmation: 4,
    applyFailed: 5,
    nothingToConfirm: 6,
    alreadyRolledBack: 7,
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

/** @returns the script run (detached) to restore the previous tables and IPv4 forwarding value. */
export function rollbackScriptText(): string {
    return [
        "#!/bin/sh",
        `mkdir "${STATE_DIRECTORY}/decision" 2>/dev/null || exit 0`,
        `cat "${STATE_DIRECTORY}/previous-ip-forward" > /proc/sys/net/ipv4/ip_forward`,
        `if nft -f "${STATE_DIRECTORY}/rollback.nft"; then`,
        `    echo rolled-back > "${STATE_DIRECTORY}/outcome"`,
        "else",
        `    echo rollback-failed > "${STATE_DIRECTORY}/outcome"`,
        "fi",
        "",
    ].join("\n");
}

function parentDirectory(path: string): string {
    return path.replace(/\/[^/]+$/, "");
}

const SCRIPT_PREAMBLE = [
    "set -eu",
    "umask 077",
    `state_directory="${STATE_DIRECTORY}"`,
    `rollback_unit="${ROLLBACK_UNIT_NAME}"`,
];

/**
 * Builds the apply script. It reads the new ruleset on stdin, checks it with
 * `nft -c`, snapshots the app's current tables, arms the rollback timer and
 * only then loads the new ruleset atomically with `nft -f`.
 * @param enableForwarding set net.ipv4.ip_forward=1 at runtime (restored on rollback).
 */
export function applyScriptText(enableForwarding: boolean): string {
    return [
        ...SCRIPT_PREAMBLE,
        `mkdir -p "$state_directory"`,
        `if [ -e "$state_directory/armed" ] && [ ! -d "$state_directory/decision" ]; then`,
        `    echo "A previous change is still waiting for confirmation" >&2`,
        `    exit ${ExitCode.pendingConfirmation}`,
        "fi",
        `rm -rf "$state_directory/decision" "$state_directory/outcome" "$state_directory/armed"`,
        `cat > "$state_directory/pending.nft"`,
        `nft -c -f "$state_directory/pending.nft"`,
        ...snapshotCommands(),
        `cat /proc/sys/net/ipv4/ip_forward > "$state_directory/previous-ip-forward"`,
        `cat > "$state_directory/rollback.sh" <<'COCKPIT_FIREWALL_ROLLBACK'`,
        rollbackScriptText() + "COCKPIT_FIREWALL_ROLLBACK",
        `systemctl stop "$rollback_unit.timer" "$rollback_unit.service" 2>/dev/null || true`,
        `systemctl reset-failed "$rollback_unit.timer" "$rollback_unit.service" 2>/dev/null || true`,
        `if ! { command -v systemd-run >/dev/null 2>&1 && systemd-run --quiet --unit="$rollback_unit" --on-active=${ROLLBACK_TIMEOUT_SECONDS} --timer-property=AccuracySec=1s /bin/sh "$state_directory/rollback.sh"; }; then`,
        `    setsid /bin/sh -c 'sleep ${ROLLBACK_TIMEOUT_SECONDS}; exec /bin/sh "$0"' "$state_directory/rollback.sh" </dev/null >/dev/null 2>&1 &`,
        "fi",
        `touch "$state_directory/armed"`,
        ...enableForwarding ? ["echo 1 > /proc/sys/net/ipv4/ip_forward"] : [],
        `if ! nft -f "$state_directory/pending.nft"; then`,
        `    /bin/sh "$state_directory/rollback.sh"`,
        `    systemctl stop "$rollback_unit.timer" 2>/dev/null || true`,
        `    exit ${ExitCode.applyFailed}`,
        "fi",
        "",
    ].join("\n");
}

/**
 * Builds the confirm script: cancels the rollback (unless it already ran) and
 * persists the applied ruleset, the sysctl file and the boot unit.
 * @param persistForwarding write the sysctl.d file; otherwise remove it (runtime value is left as is).
 */
export function confirmScriptText(persistForwarding: boolean): string {
    return [
        ...SCRIPT_PREAMBLE,
        `if [ ! -e "$state_directory/armed" ]; then`,
        `    echo "No change is waiting for confirmation" >&2`,
        `    exit ${ExitCode.nothingToConfirm}`,
        "fi",
        `if ! mkdir "$state_directory/decision" 2>/dev/null; then`,
        `    echo "The change was already rolled back" >&2`,
        `    exit ${ExitCode.alreadyRolledBack}`,
        "fi",
        `systemctl stop "$rollback_unit.timer" 2>/dev/null || true`,
        `rm -f "$state_directory/armed"`,
        `mkdir -p "${parentDirectory(PERSISTED_RULESET_PATH)}" "${parentDirectory(SYSCTL_PATH)}" "${parentDirectory(BOOT_UNIT_PATH)}"`,
        `install -m 600 "$state_directory/pending.nft" "${PERSISTED_RULESET_PATH}"`,
        ...persistForwarding
            ? [
                `cat > "${SYSCTL_PATH}" <<'COCKPIT_FIREWALL_SYSCTL'`,
                sysctlFileText() + "COCKPIT_FIREWALL_SYSCTL",
                `chmod 644 "${SYSCTL_PATH}"`,
            ]
            : [`rm -f "${SYSCTL_PATH}"`],
        `cat > "${BOOT_UNIT_PATH}" <<'COCKPIT_FIREWALL_UNIT'`,
        bootUnitText() + "COCKPIT_FIREWALL_UNIT",
        `chmod 644 "${BOOT_UNIT_PATH}"`,
        "systemctl daemon-reload",
        `systemctl enable "${BOOT_UNIT_NAME}" >/dev/null 2>&1 || systemctl enable "${BOOT_UNIT_NAME}"`,
        `echo confirmed > "$state_directory/outcome"`,
        "",
    ].join("\n");
}

/** @returns the script that rolls back immediately ("Revert now"). */
export function revertScriptText(): string {
    return [
        ...SCRIPT_PREAMBLE,
        `if [ ! -e "$state_directory/armed" ] || [ -d "$state_directory/decision" ]; then`,
        `    echo "No change is waiting for confirmation" >&2`,
        `    exit ${ExitCode.nothingToConfirm}`,
        "fi",
        `systemctl stop "$rollback_unit.timer" 2>/dev/null || true`,
        `/bin/sh "$state_directory/rollback.sh"`,
        "",
    ].join("\n");
}

/**
 * Status script. Prints one of: "none", "pending <seconds left>",
 * "rolled-back", "rollback-failed", "confirmed".
 */
export function statusScriptText(): string {
    return [
        ...SCRIPT_PREAMBLE,
        `if [ -e "$state_directory/armed" ] && [ ! -d "$state_directory/decision" ]; then`,
        `    armed_at=$(stat -c %Y "$state_directory/armed")`,
        `    now=$(date +%s)`,
        `    left=$((armed_at + ${ROLLBACK_TIMEOUT_SECONDS} - now))`,
        `    [ "$left" -ge 0 ] || left=0`,
        `    echo "pending $left"`,
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
    | { state: "pending"; secondsLeft: number };

/** @returns the parsed status script output. Unknown output maps to "none". */
export function parseTransactionStatus(output: string): TransactionStatus {
    const text = output.trim();
    const pending = /^pending (\d+)$/.exec(text);
    if (pending)
        return { state: "pending", secondsLeft: Number(pending[1]) };
    if (text === "rolled-back" || text === "rollback-failed" || text === "confirmed")
        return { state: text };
    return { state: "none" };
}
