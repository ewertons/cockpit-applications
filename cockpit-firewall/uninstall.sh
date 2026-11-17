#!/bin/bash
set -euo pipefail

# uninstall.sh — Remove cockpit-firewall from the system
# Usage: sudo ./uninstall.sh          (remove system-wide install)
#        ./uninstall.sh --user        (remove user install)
#
# NOTE: This ONLY removes the Cockpit UI. Applied rules (tables inet cockpit_fw
#       and ip cockpit_fw_nat) stay loaded and keep being restored at boot.

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
    echo "          sudo systemctl disable --now cockpit-firewall.service"
    echo "          sudo nft delete table inet cockpit_fw"
    echo "          sudo nft delete table ip cockpit_fw_nat   # if present"
    echo "          sudo rm -f /etc/nftables.d/cockpit-fw.nft /etc/sysctl.d/90-cockpit-firewall.conf"
    echo "          sudo rm -f /etc/systemd/system/cockpit-firewall.service && sudo systemctl daemon-reload"
    echo "          sudo rm -rf /etc/cockpit-firewall"
fi

echo "==> Done. Reload Cockpit in your browser — 'Firewall rules' should be gone."
