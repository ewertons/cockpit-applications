# Cockpit Firewall

A [Cockpit](https://cockpit-project.org/) extension for forwarding, NAT and
input rules using [nftables](https://wiki.nftables.org/).

The app owns only two tables, `table inet cockpit_fw` and
`table ip cockpit_fw_nat`. It never modifies other tables and never writes
WireGuard files. Use it instead of loading firewall rules from WireGuard
`PostUp` hooks.

## Features

- **Zones**: named groups of interfaces (e.g. `vpn` = `wg0`, `lan` = `eth0`), each with a default forward and input policy (accept/drop) for traffic entering it
- **Hosts / networks**: name -> IPv4/IPv6 addresses or CIDRs
- **Services**: name -> TCP/UDP ports or ranges; built-ins `any`, `ssh`, `http`, `https`, `dns`, `cockpit`, `rdp`, `smb`, `wireguard`
- **Forward rules**: ordered `from zone[/host] -> to zone[/host]`, service, accept/drop; established/related traffic is always accepted
- **NAT**: masquerade an IPv4 source CIDR (and/or zone) out of an egress zone
- **Input rules**: what may reach the host itself; SSH (22) and Cockpit (9090) stay reachable unless explicitly disabled (with a warning)
- **WireGuard import (read-only)**: peers from `/etc/wireguard/*.conf` become hosts, named from the `# Name =` comment, addressed from `AllowedIPs`
- **Safe apply**: validate, preview diff, atomic apply, automatic rollback after 60 s unless confirmed
- **Coexistence**: other nftables tables (firewalld, docker, ...) are listed read-only, with warnings; running firewalld/ufw is detected
- **IP forwarding**: `net.ipv4.ip_forward=1` is set (and persisted in `/etc/sysctl.d/90-cockpit-firewall.conf`) when any forward or NAT rule exists

## Requirements

- [Cockpit](https://cockpit-project.org/) installed and running
- nftables (`nft`), systemd
- Node.js and npm (for building)

The installer installs `nftables` automatically if it is not already present.

## Quick Install

```bash
# System-wide install (requires root)
sudo ./install.sh

# Or user-only install (no root needed)
./install.sh --user
```

Reload Cockpit in your browser: **Firewall rules** appears in the Tools menu.

## Quick Uninstall

```bash
sudo ./uninstall.sh      # or ./uninstall.sh --user
```

Uninstalling removes only the Cockpit UI. Applied rules stay loaded and are
restored at boot; `uninstall.sh` prints the commands to remove them too.

## How it works

### Files

| Path | Purpose |
|------|---------|
| `/etc/cockpit-firewall/config.json` | Configuration draft (zones, hosts, services, rules) |
| `/etc/nftables.d/cockpit-fw.nft` | Confirmed ruleset, loaded at boot |
| `/etc/systemd/system/cockpit-firewall.service` | Boot unit loading the ruleset |
| `/etc/sysctl.d/90-cockpit-firewall.conf` | `net.ipv4.ip_forward = 1`, only while forward/NAT rules exist |
| `/run/cockpit-firewall/` | Pending apply state and rollback snapshot |

### Generated ruleset

The file deletes and recreates only the app's own tables, so loading it with
`nft -f` is atomic and leaves every other table untouched:

```
table inet cockpit_fw
delete table inet cockpit_fw
table ip cockpit_fw_nat
delete table ip cockpit_fw_nat

table inet cockpit_fw { ... }
table ip cockpit_fw_nat { ... }   # only when NAT rules exist
```

### Loading at boot

Debian's `/etc/nftables.conf` starts with `flush ruleset` and has no include
directory, so the ruleset is loaded by its own unit, `cockpit-firewall.service`
(`nft -f /etc/nftables.d/cockpit-fw.nft`). It is ordered after
`nftables.service`, wanted by it and `PartOf` it, so it is re-applied when
nftables is restarted or reloaded. It is enabled when a change is confirmed.

### Safe apply

1. The ruleset is generated from the configuration; every field is validated first.
2. **Status & apply** shows a diff against the persisted ruleset.
3. Click **Apply**: the server checks the ruleset with `nft -c -f`, snapshots the app's current tables, arms a rollback
   (`systemd-run --on-active=60`, transient unit `cockpit-firewall-rollback`, or a
   detached `sleep` fallback), then loads the new ruleset with `nft -f`.
4. Click **Keep changes** within 60 s to persist the ruleset, the sysctl file and the
   boot unit. Otherwise the previous tables and `ip_forward` value are restored
   server-side, even if the browser has lost its connection.

**Revert now** restores the snapshot immediately.

### Coexistence

A packet traverses every base chain on a hook. A `drop` in any of them (for
example a firewalld or docker table) still drops the packet, even if this app
accepts it. The **Other tables** tab lists foreign tables and base chains
read-only and warns about `drop` policies. firewalld or ufw may also flush the
whole ruleset when they reload; prefer not to run them together with this app.

### Security

- Privileged commands run through `cockpit.spawn`/`cockpit.script` with superuser;
  user input never becomes part of a shell command. The ruleset is passed on stdin.
- Interface names, object names, addresses, CIDRs and ports are validated strictly
  before any text is generated; interface names are always quoted.
- No `eval` and no downloads at runtime.

## Example: VPN client may reach only one LAN host over SSH

WireGuard tunnel `wg0` (VPN `10.10.20.0/24`) and LAN interface `eth0`
(`192.168.1.0/24`). Client `ewertons-msft` (`10.10.20.3`) must reach only
`conejo` (`192.168.1.198`) on tcp/22.

1. **Zones & objects -> Zones**: add `vpn` = `wg0` (forward default **drop**) and `lan` = `eth0`.
2. **Zones & objects -> Hosts and networks**: **Import WireGuard peers** (adds `ewertons-msft` from the
   peer's `# Name =` comment); add `conejo` = `192.168.1.198`.
3. **Rules -> Forward**: from zone `vpn`, host `ewertons-msft` -> host `conejo`,
   service `ssh`, **accept**.
4. **Rules -> NAT**: source `10.10.20.0/24`, egress zone `lan`.
5. **Status & apply**: review the diff, **Apply**, then **Keep changes** within 60 s.

Generated ruleset:

```
table inet cockpit_fw {
	chain forward {
		type filter hook forward priority filter; policy accept;
		ct state established,related accept
		iifname "wg0" ip saddr 10.10.20.3 ip daddr 192.168.1.198 tcp dport 22 counter accept
		iifname "wg0" counter drop
	}
}

table ip cockpit_fw_nat {
	chain postrouting {
		type nat hook postrouting priority srcnat; policy accept;
		ip saddr 10.10.20.0/24 oifname "eth0" counter masquerade
	}
}
```

This scenario is covered by the unit tests (`test/unit/ruleset.test.ts`).

### Migrating from WireGuard `PostUp` firewall hooks

If a tunnel loads its firewall from a hook such as
`PostUp = nft -f /etc/host-setup/vpn/firewall.nft`:

1. Recreate the rules in this app and confirm them (see above).
2. Remove the `PostUp`/`PostDown` firewall lines from `/etc/wireguard/wg0.conf`.
3. Delete the old table (e.g. `sudo nft delete table inet host_setup_vpn`), after
   checking its name with `sudo nft list tables`.
4. Restart the tunnel: `sudo systemctl restart wg-quick@wg0`.

### Verifying

```bash
sudo nft list table inet cockpit_fw        # counters on the accept/drop rules
sudo nft list table ip cockpit_fw_nat
sysctl net.ipv4.ip_forward                 # 1
systemctl is-enabled cockpit-firewall.service
```

From the client: `ssh user@192.168.1.198` works and the accept counter grows;
any other LAN address or port (e.g. `ping 192.168.1.1`) fails and the
`iifname "wg0" counter drop` counter grows.

## Development

```bash
npm install --ignore-scripts
make devel-install
make watch
```

## Linting and tests

```bash
npm run eslint
npm run stylelint
npm test
```

## License

[MIT](../LICENSE)
