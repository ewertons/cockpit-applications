# Cockpit OpenSSH

A Cockpit application for managing the OpenSSH server on a Linux host.

## Features

### Server

- Start / stop / restart / reload / enable / disable the SSH daemon, with
  `sshd.service` vs `ssh.service` detected automatically.
- Socket activation (`ssh.socket`, Ubuntu 22.10+ / Debian 13) is detected and
  handled — a port change there needs `daemon-reload` plus a socket restart, not
  a daemon reload.
- Edit the common `sshd_config` directives. Values shown are the **effective**
  ones reported by `sshd -G`, together with the file that currently provides
  them, so overrides from `sshd_config.d` drop-ins are never hidden.
- Changes are written to `/etc/ssh/sshd_config.d/00-cockpit-openssh.conf`. The
  `00-` prefix matters: sshd uses the first value it obtains and `Include` sits
  at the top of the main config, so the alphabetically first drop-in wins.
- Every change is validated with `sshd -t` **before** the daemon is reloaded. If
  validation fails the previous drop-in is restored and nothing is reloaded.
- Pre-flight checks warn about the specific ways a change can lock you out
  (firewall, SELinux port labelling, disabling password auth with no keys
  installed, `AllowUsers` that excludes you, ...).
- After a successful reload a rollback timer is armed. If you do not confirm
  "Keep changes", the previous configuration is restored automatically.

### Authorized keys

- Browse and edit `authorized_keys` for any account on the system. The path is
  resolved from the effective `AuthorizedKeysFile` directive, so non-default
  layouts work.
- Keys are listed with their SHA256 fingerprint, type and options.
- "Add client" wizard: paste an existing public key, or generate a new key pair
  on the server. Generated private keys live only in a tmpfs temporary directory
  and in the browser page — they are never stored, so the download is offered
  once and only once.
- Optional per-key restrictions (`from=`, `command=`, `expiry-time=`,
  `no-port-forwarding`, `no-pty`, `restrict`).

### Known hosts

- Inspect `/etc/ssh/ssh_known_hosts`, `/root/.ssh/known_hosts` and any user's
  `~/.ssh/known_hosts`.
- Hashed entries (the Debian/Ubuntu default) are clearly marked. Hostnames
  cannot be recovered from them — the app can still identify a host you name via
  `ssh-keygen -F`, and will try to label what it can from `/etc/hosts` and
  `~/.ssh/config`.
- Remove single entries, remove a host by name, or purge a whole file (a backup
  is written first). The `.old` file that `ssh-keygen -R` leaves behind is
  surfaced, since it still contains everything you just removed.
- Add a host by scanning it with `ssh-keyscan` — the fingerprint is always shown
  and must be confirmed, never added silently.
- Optional periodic check via a systemd timer. It is **report-only**: it
  compares stored keys against what the hosts currently present and records the
  result. It never removes anything.

## Install

```sh
sudo ./install.sh          # system-wide, to /usr/share/cockpit/
./install.sh --user        # just for you, to ~/.local/share/cockpit/
```

Then reload Cockpit in your browser. "OpenSSH" appears under Tools.

## Uninstall

```sh
sudo ./uninstall.sh
```

Your SSH configuration is left in place. To revert settings made here, remove
`/etc/ssh/sshd_config.d/00-cockpit-openssh.conf` and reload sshd.

## Development

```sh
npm install --ignore-scripts
make pkg/lib/cockpit-po-plugin.js   # fetch vendored Cockpit libraries
npm run watch                       # rebuild on change
make devel-install                  # symlink dist/ into ~/.local/share/cockpit
```

## Relationship to cockpit-security

`cockpit-security` has an "SSH Hardening" page that writes a handful of
directives directly into `/etc/ssh/sshd_config`. This application writes to a
higher-priority drop-in instead, so its settings win. The Server page shows
which file each effective value comes from, which makes any disagreement between
the two visible.
