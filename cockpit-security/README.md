# cockpit-security

A Cockpit extension for comprehensive Linux security monitoring and control.

## Features

### Security Overview Dashboard
- Service status at a glance (firewall, fail2ban, auditd, SELinux/AppArmor)
- Active connections count
- Failed login attempts (24h)
- Security alerts for misconfigurations

### Network Security
- **Firewall Management** — Control firewalld/ufw/nftables: toggle, add ports/services, view zones/rules
- **Network Monitor** — Real-time active connections, interface traffic stats, auto-refresh
- **Open Ports** — All listening services with process identification

### Access Control
- **SELinux / AppArmor** — View/toggle enforcement mode, manage SELinux booleans, list AppArmor profiles
- **Fail2Ban** — Service control, jail status, banned IPs, unban capability
- **SSH Hardening** — Audit sshd_config, one-click hardening (disable root, password auth, etc.)
- **Users & Auth** — User accounts audit, sudo membership, password age, login/failure history

### Monitoring
- **Audit Logs** — View auditd or journalctl security logs with filtering
- **Intrusion Detection** — Run AIDE/rkhunter/chkrootkit scans, SUID file audit, world-writable file detection

### Maintenance
- **System Updates** — Available/security updates, one-click upgrade (apt/dnf/zypper)
- **Certificates** — TLS certificate inventory with expiry tracking

## Installation

### Prerequisites
- Node.js >= 16 and npm
- Cockpit installed on the target system
- Git (for fetching cockpit build libraries)

### Quick Install (system-wide)
```bash
sudo ./install.sh
```

### User Install (no root required)
```bash
./install.sh --user
```

### Development
```bash
npm install --ignore-scripts
make pkg/lib/cockpit-po-plugin.js
npm run watch
# Then symlink dist/ to ~/.local/share/cockpit/cockpit-security
```

## Uninstall
```bash
sudo ./uninstall.sh        # system-wide
./uninstall.sh --user      # user install
```

## Architecture

```
src/
├── index.html          # Entry HTML
├── index.tsx           # React bootstrap
├── manifest.json       # Cockpit package manifest
├── app.tsx             # Main app with sidebar navigation
├── app.scss            # Global styles
└── pages/
    ├── overview-page.tsx
    ├── firewall-page.tsx
    ├── network-monitor-page.tsx
    ├── open-ports-page.tsx
    ├── selinux-page.tsx
    ├── fail2ban-page.tsx
    ├── ssh-hardening-page.tsx
    ├── user-security-page.tsx
    ├── audit-log-page.tsx
    ├── intrusion-detection-page.tsx
    ├── system-updates-page.tsx
    └── certificates-page.tsx
```

Built with React, PatternFly 6, TypeScript, and the Cockpit JS API.

## License

[MIT](../LICENSE)
