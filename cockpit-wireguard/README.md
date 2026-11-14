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
- **Per-client LAN access** — let a split-tunnel client reach specific LAN hosts or ports; enforced on the server (see below)
- **Boot control** — enable/disable tunnels at boot via `wg-quick@` systemd units
- **Standard on-disk format** — plain `/etc/wireguard/*.conf`, nothing proprietary
- **Erase all** — remove every tunnel from one place, with double confirmation

## Requirements

- [Cockpit](https://cockpit-project.org/) installed and running
- [WireGuard tools](https://www.wireguard.com/install/) (`wg`, `wg-quick`)
- Node.js and npm (for building)

The installer installs `wireguard-tools` automatically if it is not already present.

## Client access and firewall rules

A split-tunnel client's **LAN access** list holds entries like `192.168.1.198:22/tcp`
(IPv4 address or CIDR, optional `:port`, optional `/tcp` or `/udp`; a port alone
means both). Each destination is added to the client's `AllowedIPs`. The list is
stored as a `# ClientLanAccess =` comment on the peer.

On tunnels whose `PostUp`/`PostDown` rules were created by this app, the server
filters forwarded traffic per client in an iptables chain `wg-access-<tunnel>`:
split-tunnel clients reach the VPN subnet and their listed destinations only;
full-tunnel clients reach anything. Changes apply on save, without restarting
the tunnel. Tunnels created by earlier versions are switched to these rules the
first time a client is saved; clients that were never edited keep unrestricted
forwarding until they are. Rules written by hand or by other tools are never
changed, and LAN access then only affects the client configuration.

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
