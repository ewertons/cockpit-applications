#!/bin/bash
set -euo pipefail

# cockpit-install.sh — Install Cockpit and optionally all applications in this project
# Usage: sudo ./cockpit-install.sh                       (install cockpit only)
#        sudo ./cockpit-install.sh --add-applications    (install cockpit + all apps)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_APPS=false

for arg in "$@"; do
    case "$arg" in
        --add-applications) INSTALL_APPS=true ;;
        -h|--help)
            echo "Usage: sudo $0 [--add-applications]"
            echo ""
            echo "  --add-applications   Also build and install all cockpit applications"
            echo "                       (cockpit-backup, cockpit-git-server, cockpit-openssh,"
            echo "                       cockpit-security, cockpit-wireguard)"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            echo "Usage: sudo $0 [--add-applications]" >&2
            exit 1
            ;;
    esac
done

# Require root
if [[ $EUID -ne 0 ]]; then
    echo "ERROR: This script must be run as root (sudo)." >&2
    exit 1
fi

# Detect package manager
install_pkg() {
    local pkg="$1"
    if command -v apt-get &>/dev/null; then
        apt-get install -y -qq "$pkg"
    elif command -v dnf &>/dev/null; then
        dnf install -y "$pkg"
    elif command -v yum &>/dev/null; then
        yum install -y "$pkg"
    elif command -v zypper &>/dev/null; then
        zypper install -y "$pkg"
    elif command -v pacman &>/dev/null; then
        pacman -S --noconfirm "$pkg"
    else
        echo "ERROR: No supported package manager found. Install '$pkg' manually." >&2
        return 1
    fi
}

# --- Install Cockpit ---
echo "==> Checking Cockpit installation..."
if command -v cockpit-ws &>/dev/null || systemctl list-unit-files cockpit.socket &>/dev/null 2>&1; then
    echo "    Cockpit is already installed."
else
    echo "==> Installing Cockpit..."
    if command -v apt-get &>/dev/null; then
        apt-get update -qq
    fi
    install_pkg cockpit
fi

# Ensure cockpit socket is enabled and started
if systemctl list-unit-files cockpit.socket &>/dev/null 2>&1; then
    if ! systemctl is-enabled cockpit.socket &>/dev/null 2>&1; then
        echo "==> Enabling cockpit.socket..."
        systemctl enable cockpit.socket
    fi
    if ! systemctl is-active cockpit.socket &>/dev/null 2>&1; then
        echo "==> Starting cockpit.socket..."
        systemctl start cockpit.socket
    fi
    echo "    cockpit.socket is active."
fi

# Install cracklib-runtime (needed by cockpit for password quality checks)
echo "==> Ensuring cracklib-runtime is available..."
if command -v cracklib-check &>/dev/null; then
    echo "    cracklib-runtime is already installed."
else
    install_pkg cracklib-runtime || true
fi

echo ""
echo "==> Cockpit setup complete."
echo "    Access Cockpit at https://$(hostname):9090"

# --- Install applications ---
if $INSTALL_APPS; then
    echo ""
    echo "============================================"
    echo "==> Installing all cockpit applications..."
    echo "============================================"

    APPS=("cockpit-backup" "cockpit-git-server" "cockpit-openssh" "cockpit-security" "cockpit-wireguard")

    for app in "${APPS[@]}"; do
        APP_DIR="$SCRIPT_DIR/$app"
        if [[ -x "$APP_DIR/install.sh" ]]; then
            echo ""
            echo "--- Installing $app ---"
            "$APP_DIR/install.sh"
        else
            echo "    SKIP: $APP_DIR/install.sh not found or not executable."
        fi
    done

    echo ""
    echo "==> All applications installed. Reload Cockpit in your browser."
fi

