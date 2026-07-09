# Cockpit WireGuard

A [Cockpit](https://cockpit-project.org/) extension for managing
[WireGuard](https://www.wireguard.com/) VPN tunnels.

It operates directly on the standard `wg-quick` configuration in
`/etc/wireguard` — the same files WireGuard uses on its own. Existing tunnels
are detected automatically, changes made outside Cockpit are reflected on
reload, and your configuration persists even if this extension is removed.

## Features

- **Tunnels** — list, create, edit and remove WireGuard interfaces
- **Live status** — up/down state, latest handshake and transfer per peer
- **Client wizard** — guided flow to add a client, with keys generated for you
- **Client config & QR** — copy, download or scan a ready-to-use client config
- **Boot control** — enable/disable tunnels at boot via `wg-quick@` systemd units
- **Standard on-disk format** — plain `/etc/wireguard/*.conf`, nothing proprietary
- **Erase all** — remove every tunnel from one place, with double confirmation

## Requirements

- [Cockpit](https://cockpit-project.org/) installed and running
- [WireGuard tools](https://www.wireguard.com/install/) (`wg`, `wg-quick`)
- Node.js and npm (for building)

The installer installs `wireguard-tools` automatically if it is not already present.

## Quick Install

```bash
# System-wide install (requires root)
sudo ./install.sh

# Or user-only install (no root needed)
./install.sh --user
```

Reload Cockpit in your browser — **WireGuard** appears in the Tools menu.

## Quick Uninstall

```bash
# System-wide
sudo ./uninstall.sh

# Or user-only
./uninstall.sh --user
```

Uninstalling removes only the Cockpit UI. Your tunnels in `/etc/wireguard` keep
running and all configuration is preserved.

## Development

```bash
npm install --ignore-scripts
make devel-install
make watch
```

## Linting

```bash
npm run eslint
npm run stylelint
```

## License

[MIT](../LICENSE)
