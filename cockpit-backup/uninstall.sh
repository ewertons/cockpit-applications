#!/bin/bash
set -euo pipefail

# uninstall.sh — Remove cockpit-backup from the system
# Usage: sudo ./uninstall.sh          (remove system-wide install)
#        ./uninstall.sh --user        (remove user install)

PACKAGE_NAME="cockpit-backup"
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

    # Disable and remove any active backup timers
    echo "==> Disabling backup timers..."
    for timer in /etc/systemd/system/cockpit-backup-*.timer; do
        if [[ -f "$timer" ]]; then
            timer_name="$(basename "$timer")"
            systemctl disable --now "$timer_name" 2>/dev/null || true
            rm -f "$timer"
            rm -f "${timer%.timer}.service"
        fi
    done
    systemctl daemon-reload 2>/dev/null || true

    echo ""
    echo "NOTE: Configuration in /etc/cockpit-backup/ was NOT removed."
    echo "      To fully remove, run: sudo rm -rf /etc/cockpit-backup"
    echo "      Backup repositories (data) are also preserved."
fi

echo "==> Done. Reload Cockpit in your browser — 'Backup' should be gone."
