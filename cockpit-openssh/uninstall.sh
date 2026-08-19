#!/bin/bash
set -euo pipefail

# uninstall.sh — Remove cockpit-openssh from the system
# Usage: sudo ./uninstall.sh          (remove system-wide install)
#        ./uninstall.sh --user        (remove user install)

PACKAGE_NAME="cockpit-openssh"
USER_UNINSTALL=false

if [[ "${1:-}" == "--user" ]]; then
    USER_UNINSTALL=true
fi

if $USER_UNINSTALL; then
    DEST="$HOME/.local/share/cockpit/$PACKAGE_NAME"
    echo "==> Removing user install at $DEST..."
    rm -rf "$DEST"
else
    DEST="/usr/share/cockpit/$PACKAGE_NAME"
    echo "==> Removing system-wide install at $DEST (requires root)..."
    if [[ $EUID -ne 0 ]]; then
        echo "ERROR: System-wide uninstall requires root. Run with sudo or use --user." >&2
        exit 1
    fi
    rm -rf "$DEST"

    if systemctl list-unit-files cockpit-openssh-known-hosts-report.timer &>/dev/null; then
        systemctl disable --now cockpit-openssh-known-hosts-report.timer 2>/dev/null || true
    fi
    rm -f /etc/systemd/system/cockpit-openssh-known-hosts-report.timer \
          /etc/systemd/system/cockpit-openssh-known-hosts-report.service
    rm -rf /etc/systemd/system/cockpit-openssh-known-hosts-report.timer.d
    rm -rf /usr/local/libexec/cockpit-openssh
    systemctl daemon-reload 2>/dev/null || true
fi

echo "==> Done. Reload Cockpit in your browser — 'OpenSSH' should be gone."
echo
echo "    NOTE: your SSH configuration was left untouched. In particular:"
echo "      /etc/ssh/sshd_config.d/00-cockpit-openssh.conf  (settings made here)"
echo "      /etc/cockpit-openssh/, /var/lib/cockpit-openssh/"
echo "    Remove the drop-in and reload sshd if you want to revert those settings."
