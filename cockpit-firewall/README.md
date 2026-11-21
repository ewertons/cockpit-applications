# Cockpit Firewall

A [Cockpit](https://cockpit-project.org/) extension for forwarding, NAT and
input rules using [nftables](https://wiki.nftables.org/).

Its configuration is the nftables configuration itself: one table,
`table inet cockpit_fw`, in a marked block of `/etc/nftables.conf`, loaded at
boot by `nftables.service`. Zones, hosts and services are named sets, rule notes
are `comment`s, and the UI reads everything back from that file and from the live
ruleset. There is no side file, so edits made by hand or by another tool are seen
the next time the page loads.

The app never modifies other tables (except, on request, the stock accept-all
`table inet filter` of Debian), keeps the rest of `/etc/nftables.conf` verbatim
and never writes WireGuard files. Use it instead of loading firewall rules from
WireGuard `PostUp` hooks.

## Features

- **Zones**: named groups of interfaces (e.g. `vpn` = `wg0`, `lan` = `eth0`), each with a default forward and input policy (accept/drop) for traffic entering it
- **Hosts / networks**: name -> IPv4/IPv6 addresses or CIDRs
- **Services**: name -> TCP/UDP ports or ranges; built-ins `any`, `ssh`, `http`, `https`, `dns`, `cockpit`, `rdp`, `smb`, `wireguard`
- **Forward rules**: ordered `from zone[/host] -> to zone[/host]`, service, accept/drop; established/related traffic is always accepted
- **NAT**: masquerade an IPv4 source CIDR (and/or zone) out of an egress zone
- **Input rules**: what may reach the host itself, optionally limited to one destination address of the host; SSH (22) and Cockpit (9090) stay reachable unless explicitly disabled (with a warning); once disabled, that rule is not added back
- **Rule comments**: free text stored as the nftables `comment` of the rule
- **WireGuard import (read-only)**: peers from `/etc/wireguard/*.conf` become hosts, named from the `# Name =` comment or a `# <name> (access: ...)` comment above `[Peer]` (blank lines in between are ignored) (unnamed peers: `<interface>-peer-<PublicKey prefix>`), addressed from `AllowedIPs`; the interface's `ListenPort` gets an input accept rule (its own `wireguard-<interface>` service for non-default ports; a user service of that name is never changed, a `-2`, `-3`... suffix is used instead); re-imports list hosts removed or now held by a different peer
- **Safe apply**: validate, preview diff, atomic apply, automatic rollback after 60 s unless confirmed
- **Coexistence**: other tables, live and in `/etc/nftables.conf`, are listed read-only, with warnings; running firewalld/ufw is detected
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

Uninstalling removes only the Cockpit UI. The rules stay in `/etc/nftables.conf`
and stay loaded; `uninstall.sh` prints the commands to remove them too.

## How it works

### Files

| Path | Purpose |
|------|---------|
| `/etc/nftables.conf` | The app's block (`# BEGIN cockpit-firewall` ... `# END cockpit-firewall`) holds its whole configuration; the rest of the file is not changed |
| `/etc/sysctl.d/90-cockpit-firewall.conf` | `net.ipv4.ip_forward = 1`, only while forward/NAT rules exist |
| `/var/backups/cockpit-firewall/` | `nftables.conf.previous` (the file before the last confirmed change) and files of earlier versions |
| `/run/cockpit-firewall/` | Pending apply state and rollback snapshot |

Unsaved edits in the UI live only in the browser page; **Discard** drops them.

### Generated block

```
# BEGIN cockpit-firewall
# Managed by Cockpit (Firewall rules); read back by it. ...
table inet cockpit_fw
delete table inet cockpit_fw
table inet cockpit_fw {
	set zone_<zone> { type ifname; ... }                         # zones
	set host4_<host> { type ipv4_addr; flags interval; ... }     # hosts (host6_ for IPv6)
	set service_<service> { type inet_proto . inet_service; ... } # services used by rules
	chain forward { type filter hook forward priority filter; ... }
	chain input { type filter hook input priority filter; ... }  # only when needed
	chain postrouting { type nat hook postrouting priority srcnat; ... }
	chain forward_disabled { ... }                               # disabled rules, not hooked
}
# END cockpit-firewall
```

The `table` / `delete table` pair makes loading the block replace only this
table. Imported WireGuard hosts keep their interface and public key in the set
`comment`. Base chains start with `ct state established,related accept`
(and, for input, loopback, ICMP echo, ICMPv6 and DHCP client replies). A zone
with policy drop ends the chain with `iifname @zone_<zone> drop`. NAT rules
without a source address apply to IPv4 only.

Requires nftables >= 0.9.7 and Linux >= 5.6 (concatenated interval sets).

### Loading at boot

Debian's `nftables.service` loads `/etc/nftables.conf`; **Keep changes** enables
it. The app does not restart or reload it: Debian's file starts with
`flush ruleset`, which would also remove tables of other tools that are not in the
file (for example fail2ban's `inet f2b-table`). Such tools must add their tables
again after an nftables reload, as they do at their own start.

If the file holds the stock accept-all `table inet filter`, **Status & apply**
offers to remove it (from the file and the live ruleset). The server checks the
live table again before removing it and refuses if it has gained rules, sets or a
drop policy. Any other content is
kept as is and shown read-only in **Other tables**.

### Safe apply

1. The block is generated from the configuration; every field is validated first.
2. **Status & apply** shows the diff of `/etc/nftables.conf` and the table that
   will be loaded. Apply refuses (in the browser and again on the server) if the file changed since it was shown.
3. Click **Apply**: the server checks both the live text and the whole candidate
   file with `nft -c -f`, records the file's checksum, snapshots the tables it
   replaces, arms a rollback (`systemd-run --on-active=60`, transient unit
   `cockpit-firewall-rollback`, or a detached `sleep` fallback), then loads only
   the app's table with `nft -f` (stdin). `ip_forward` is enabled only after it
   has loaded. `/etc/nftables.conf` is not written yet.
4. Click **Keep changes** within 60 s: the file is backed up and written in place
   (following a symlink, keeping owner and mode), the sysctl file updated and
   `nftables.service` enabled. If the file was changed by something else since
   Apply, this is refused. Otherwise, without confirmation, the previous tables
   and `ip_forward` value are restored server-side, even if the browser has lost
   its connection.

**Revert now** restores the snapshot immediately.

Apply, confirm, revert and the rollback serialize on a lock (`flock`) in
`/run/cockpit-firewall`; each apply has its own token, so a stale rollback cannot
revert a later change. If saving fails on **Keep changes**, the previous files are
restored and the change stays pending (retry, or it is rolled back).

### Migrating from earlier versions

Earlier versions kept `/etc/cockpit-firewall/config.json`,
`/etc/nftables.d/cockpit-fw.nft`, the unit `cockpit-firewall.service` and a
separate `table ip cockpit_fw_nat`. When found, the page starts from
`config.json` (WireGuard listen ports become the first input rules; imported hosts without a stored public key become manual hosts) and says so. The
first **Keep changes** writes the block to `/etc/nftables.conf`, deletes the old
NAT table, disables the unit and moves the old files to
`/var/backups/cockpit-firewall/legacy-<date>/`.

### Coexistence

A packet traverses every base chain on a hook. A `drop` in any of them (for
example a firewalld, ufw or docker table) still drops the packet, even if this
app accepts it, and a drop in this app's table drops traffic they accept. The
**Other tables** tab lists foreign tables and base chains, live and in
`/etc/nftables.conf`, read-only and warns about `drop` policies. Prefer not to
run firewalld or ufw together with this app.

### Security

- Privileged commands run through `cockpit.spawn`/`cockpit.script` with superuser;
  user input never becomes part of a shell command. The ruleset is passed on stdin.
- Interface names, object names, addresses, CIDRs, ports and comments are validated
  strictly before any text is generated; interface names and comments are always quoted.
- No `eval` and no downloads at runtime.

## Example: VPN client may reach only one LAN host over SSH

WireGuard tunnel `wg0` (VPN `10.99.0.0/24`) and LAN interface `eth0`
(`192.168.1.0/24`). Client `vpn-laptop` (`10.99.0.3`) must reach only
`lan-server` (`192.168.1.30`) on tcp/22.

1. **Zones & objects -> Zones**: add `vpn` = `wg0` (forward default **drop**) and `lan` = `eth0`.
2. **Zones & objects -> Hosts and networks**: **Import WireGuard peers** (adds `vpn-laptop` from the
   peer's `# Name =` comment); add `lan-server` = `192.168.1.30`.
3. **Rules -> Forward**: from zone `vpn`, host `vpn-laptop` -> host `lan-server`,
   service `ssh`, **accept**.
4. **Rules -> NAT**: source `10.99.0.0/24`, egress zone `lan`.
5. **Status & apply**: review the diff, **Apply**, then **Keep changes** within 60 s.

Generated block (the WireGuard import also adds an input rule for the tunnel's
`ListenPort`; it is left out here):

```
table inet cockpit_fw {
	set zone_vpn {
		type ifname
		elements = { "wg0" }
	}
	set zone_lan {
		type ifname
		elements = { "eth0" }
	}
	set host4_vpn-laptop {
		type ipv4_addr
		flags interval
		comment "wireguard wg0 <public key>"
		elements = { 10.99.0.3 }
	}
	set host4_lan-server {
		type ipv4_addr
		flags interval
		elements = { 192.168.1.30 }
	}
	set service_ssh {
		type inet_proto . inet_service
		flags interval
		elements = { tcp . 22 }
	}

	chain forward {
		type filter hook forward priority filter; policy accept;
		ct state established,related accept comment "cockpit-firewall: baseline"
		iifname @zone_vpn ip saddr @host4_vpn-laptop ip daddr @host4_lan-server meta l4proto . th dport @service_ssh counter accept
		iifname @zone_vpn counter drop comment "cockpit-firewall: zone policy"
	}

	chain postrouting {
		type nat hook postrouting priority srcnat; policy accept;
		ip saddr 10.99.0.0/24 oifname @zone_lan counter masquerade
	}
}
```

This scenario is covered by the unit tests (`test/unit/ruleset.test.ts`).

### Migrating from WireGuard `PostUp` firewall hooks

If a tunnel loads its firewall from a hook such as
`PostUp = nft -f /etc/wireguard/firewall.nft`:

1. Recreate the rules in this app and confirm them (see above).
2. Remove the `PostUp`/`PostDown` firewall lines from `/etc/wireguard/wg0.conf`.
3. Delete the old table (e.g. `sudo nft delete table inet vpn_filter`), after
   checking its name with `sudo nft list tables`. If `/etc/nftables.conf` also
   defines it, remove it there too.
4. Restart the tunnel: `sudo systemctl restart wg-quick@wg0`.

### Verifying

```bash
sudo nft list table inet cockpit_fw        # counters on the accept/drop rules
sudo nft -c -f /etc/nftables.conf          # the saved file is valid
sysctl net.ipv4.ip_forward                 # 1
systemctl is-enabled nftables.service      # enabled
```

From the client: `ssh user@192.168.1.30` works and the accept counter grows;
any other LAN address or port (e.g. `ping 192.168.1.1`) fails and the
`iifname @zone_vpn counter drop` counter grows.

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
