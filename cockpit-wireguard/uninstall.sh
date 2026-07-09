#!/bin/bash
set -euo pipefail

# uninstall.sh — Remove cockpit-wireguard from the system
# Usage: sudo ./uninstall.sh          (remove system-wide install)
#        ./uninstall.sh --user        (remove user install)
#
# NOTE: This ONLY removes the Cockpit UI. Your WireGuard configuration in
#       /etc/wireguard/ is left completely untouched — tunnels keep running and
#       all configuration persists, exactly as if managed by wg-quick directly.

PACKAGE_NAME="cockpit-wireguard"
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

    echo ""
    echo "NOTE: WireGuard configuration in /etc/wireguard/ was NOT removed."
    echo "      Active tunnels keep running and all configuration persists."
    echo "      To erase configuration, use the 'Erase all configuration' button"
    echo "      inside the app, or remove the files manually:"
    echo "          sudo wg-quick down <iface>   # for each active tunnel"
    echo "          sudo rm -f /etc/wireguard/*.conf"
fi

echo "==> Done. Reload Cockpit in your browser — 'WireGuard' should be gone."
