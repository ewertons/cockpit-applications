#!/bin/bash
set -euo pipefail

# install.sh — Build and install cockpit-openssh
# Usage: sudo ./install.sh          (system-wide install to /usr/share/cockpit/)
#        ./install.sh --user        (user install to ~/.local/share/cockpit/)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

USER_INSTALL=false
if [[ "${1:-}" == "--user" ]]; then
    USER_INSTALL=true
fi

PACKAGE_NAME="cockpit-openssh"

echo "==> Checking prerequisites..."

# ssh-keygen ships with the OpenSSH client and is required for key handling.
# openssh-server itself is optional here — the app offers to install it.
if ! command -v ssh-keygen &>/dev/null; then
    echo "ERROR: ssh-keygen not found. Install the OpenSSH client package (openssh-clients / openssh-client)." >&2
    exit 1
fi

# Minimum required Node.js major version
MIN_NODE_VERSION=16

# Install Node.js and npm if not present
if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
    echo "==> Installing Node.js and npm..."
    if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq nodejs npm
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y nodejs npm
    elif command -v yum &>/dev/null; then
        sudo yum install -y nodejs npm
    elif command -v zypper &>/dev/null; then
        sudo zypper install -y nodejs npm
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm nodejs npm
    else
        echo "ERROR: Node.js/npm not found and no supported package manager available. Install manually." >&2
        exit 1
    fi
fi

# Verify node version is compatible
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if (( NODE_MAJOR < MIN_NODE_VERSION )); then
    echo "ERROR: Node.js >= $MIN_NODE_VERSION is required, but found version $(node --version)." >&2
    echo "       Please upgrade Node.js and retry." >&2
    exit 1
fi
echo "    node $(node --version), npm $(npm --version)"

# When run as root (sudo), build as the owning user to avoid leaving root-owned files
BUILD_CMD() {
    if [[ $EUID -eq 0 ]] && [[ -n "${SUDO_USER:-}" ]]; then
        sudo -u "$SUDO_USER" -- "$@"
    else
        "$@"
    fi
}

echo "==> Installing npm dependencies..."
BUILD_CMD npm install --ignore-scripts 2>&1 | tail -5

echo "==> Fetching Cockpit build libraries..."
BUILD_CMD make pkg/lib/cockpit-po-plugin.js 2>&1 | tail -5

echo "==> Building..."
BUILD_CMD env NODE_ENV=production ./build.js 2>&1 | tail -5

if $USER_INSTALL; then
    DEST="$HOME/.local/share/cockpit/$PACKAGE_NAME"
    echo "==> Installing to $DEST (user mode)..."
    mkdir -p "$HOME/.local/share/cockpit"
    rm -rf "$DEST"
    cp -r dist "$DEST"
else
    DEST="/usr/share/cockpit/$PACKAGE_NAME"
    echo "==> Installing to $DEST (system-wide, requires root)..."
    if [[ $EUID -ne 0 ]]; then
        echo "ERROR: System-wide install requires root. Run with sudo or use --user for user install." >&2
        exit 1
    fi
    rm -rf "$DEST"
    mkdir -p "$DEST"
    cp -r dist/* "$DEST/"

    echo "==> Creating state directories..."
    mkdir -p /etc/cockpit-openssh /var/lib/cockpit-openssh
    chmod 755 /etc/cockpit-openssh /var/lib/cockpit-openssh
fi

echo "==> Done. Reload Cockpit in your browser to see 'OpenSSH' in the menu."
