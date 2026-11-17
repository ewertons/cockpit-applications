#!/bin/bash
set -euo pipefail

# uninstall.sh — Remove cockpit-samba from the system
# Usage: sudo ./uninstall.sh          (remove system-wide install)
#        ./uninstall.sh --user        (remove user install)
#
# NOTE: This ONLY removes the Cockpit UI. Samba, /etc/samba/smb.conf and the
#       Samba users are left untouched.

PACKAGE_NAME="cockpit-samba"
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
    echo "NOTE: Samba and its configuration were NOT changed."
    echo "      Backups of smb.conf taken by this app are kept in /var/lib/cockpit-samba/backups."
    echo "      To remove them as well:"
    echo "          sudo rm -rf /var/lib/cockpit-samba"
fi

echo "==> Done. Reload Cockpit in your browser — 'Samba file server' should be gone."
