#!/bin/bash
set -euo pipefail

# cockpit-install.sh — Install Cockpit and optionally all applications in this project
# Usage: sudo ./cockpit-install.sh                       (install cockpit only)
#        sudo ./cockpit-install.sh --add-applications    (install cockpit + all apps)
#        sudo ./cockpit-install.sh --local-only          (listen on 127.0.0.1 only; use an SSH tunnel)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_APPS=false
LOCAL_ONLY=false
USAGE="Usage: sudo $0 [--add-applications] [--local-only]"

for arg in "$@"; do
    case "$arg" in
        --add-applications) INSTALL_APPS=true ;;
        --local-only) LOCAL_ONLY=true ;;
        -h|--help)
            echo "$USAGE"
            echo ""
            echo "  --add-applications   Also build and install all cockpit applications"
            echo "                       (cockpit-backup, cockpit-git-server, cockpit-openssh,"
            echo "                       cockpit-security, cockpit-wireguard)"
            echo "  --local-only         Listen on 127.0.0.1:9090 only (reach it through an SSH"
            echo "                       tunnel), refuse logins to other hosts and as root, and"
            echo "                       end idle sessions after 15 minutes"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            echo "$USAGE" >&2
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

# Same files and header as host-setup's apply-host-security-standards.sh, so
# either script can run after the other without changing anything.
MANAGED_HEADER="# Managed by host-setup. Local changes are overwritten on the next run."
LOOPBACK_DROPIN=/etc/systemd/system/cockpit.socket.d/10-loopback.conf
COCKPIT_CONF=/etc/cockpit/cockpit.conf

# write_if_changed FILE: writes stdin to FILE; returns 0 only if FILE changed.
write_if_changed() {
    local file="$1" content
    content="$(cat)"
    if [[ -f "$file" ]] && [[ "$(cat "$file")" == "$content" ]]; then
        return 1
    fi
    mkdir -p "$(dirname "$file")"
    printf '%s\n' "$content" > "$file"
    chmod 644 "$file"
    echo "    Wrote $file"
}

# Written before the package is installed, so the socket never listens on the network.
SOCKET_CHANGED=false
if $LOCAL_ONLY; then
    echo "==> Restricting Cockpit to 127.0.0.1:9090..."
    if write_if_changed "$LOOPBACK_DROPIN" <<EOF
$MANAGED_HEADER
[Socket]
ListenStream=
ListenStream=127.0.0.1:9090
EOF
    then
        SOCKET_CHANGED=true
        systemctl daemon-reload
    fi
    if [[ ! -s "$COCKPIT_CONF" ]] || [[ "$(head -1 "$COCKPIT_CONF")" == "$MANAGED_HEADER" ]]; then
        write_if_changed "$COCKPIT_CONF" <<EOF || true
$MANAGED_HEADER
[WebService]
LoginTo = false

[Session]
IdleTimeout = 15
EOF
    else
        echo "    WARNING: $COCKPIT_CONF has local settings; left as is." >&2
        echo "             Make sure it has 'LoginTo = false' under [WebService] and" >&2
        echo "             'IdleTimeout = 15' under [Session]." >&2
    fi
    if ! grep -qx root /etc/cockpit/disallowed-users 2>/dev/null; then
        mkdir -p /etc/cockpit
        echo root >> /etc/cockpit/disallowed-users
        echo "    Added root to /etc/cockpit/disallowed-users"
    fi
fi

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
    if $SOCKET_CHANGED; then
        echo "==> Restarting cockpit.socket on the new address..."
        systemctl stop cockpit.service || true
        systemctl restart cockpit.socket
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
if $LOCAL_ONLY; then
    echo "    From your workstation: ssh -N -L 9090:127.0.0.1:9090 ${SUDO_USER:-<user>}@$(hostname)"
    echo "    then open https://localhost:9090"
else
    echo "    Access Cockpit at https://$(hostname):9090"
fi

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

