#!/bin/bash
set -euo pipefail

# uninstall.sh — Remove cockpit-firewall from the system
# Usage: sudo ./uninstall.sh          (remove system-wide install)
#        ./uninstall.sh --user        (remove user install)
#
# NOTE: This ONLY removes the Cockpit UI. Applied rules (table inet cockpit_fw)
#       stay loaded and in /etc/nftables.conf, which loads them at boot.

PACKAGE_NAME="cockpit-firewall"
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
    echo "NOTE: Firewall rules applied by this app were NOT removed."
    echo "      To remove them as well:"
    echo "          sudo sed -i '/^# BEGIN cockpit-firewall\$/,/^# END cockpit-firewall\$/d' /etc/nftables.conf"
    echo "          sudo nft delete table inet cockpit_fw"
    echo "          sudo rm -f /etc/sysctl.d/90-cockpit-firewall.conf"
    echo "      Backups of earlier files are in /var/backups/cockpit-firewall."
fi

echo "==> Done. Reload Cockpit in your browser — 'Firewall rules' should be gone."
