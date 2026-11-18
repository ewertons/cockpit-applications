# Cockpit Samba

A [Cockpit](https://cockpit-project.org/) extension to manage a
[Samba](https://www.samba.org/) file server without editing `smb.conf` by hand.

Every change is checked with `testparm`, shown as a diff, backed up and then
applied with a configuration reload. Comments, ordering and parameters the UI
does not know are preserved.

## Features

- **Overview**: state of `smbd`, `nmbd` (and `samba-ad-dc` when installed); start, stop, restart, enable/disable at boot; Samba version; testparm errors and unknown parameters of the current file; security notes
- **Global settings**: workgroup, server string, NetBIOS name, interfaces and bind interfaces only, hosts allow/deny, server min/max protocol (NT1 to SMB3_11), server signing, SMB encryption, NTLM and LANMAN authentication, map to guest, guest account, log level and size, usershares, printer sharing on/off, plus a key/value editor for any other global parameter
- **Shares**: list, add (empty or "scanner drop folder" template), edit, rename, enable/disable (`available`), delete. Fields for path (existence, owner and mode check, create directory), comment, browseable, read only, guest access, valid users, write list, read list, admin users (with a user/@group picker), force user/group, create/directory mask, hosts allow/deny, VFS objects, inherit permissions, plus a key/value editor for any other share parameter
- **Users**: Samba accounts from `pdbedit -L -v`; add for an existing Linux user or a new no-login system user; set password (`smbpasswd`); enable/disable; delete. Linux groups are listed for use as `@group`
- **Connections**: `smbstatus` sessions with the negotiated protocol (SMB1 clients are highlighted), encryption and signing, shares, open files and byte-range locks; disconnect a client
- **Logs**: `smbd`/`nmbd` journal and the files in `/var/log/samba`
- **Configuration file**: edit the whole `smb.conf` as text; list and restore backups — through the same review and apply
- **Security notes** (informational, never blocking): SMB1 enabled, NTLMv1 or LANMAN authentication, guest mapping and guest shares, world-writable masks or share paths, shares without valid users

## Requirements

- [Cockpit](https://cockpit-project.org/) installed and running
- Samba 4.17 or later (`smbd`, `testparm`, `smbcontrol`, `smbstatus`, `pdbedit`, `smbpasswd`) — Debian 12+, Ubuntu 24.04+
- systemd
- Node.js and npm (for building)

The installer installs `samba` automatically if it is not already present.
Privileged operations ask for administrative access in Cockpit.

## Quick Install

```bash
# System-wide install (requires root)
sudo ./install.sh

# Or user-only install (no root needed)
./install.sh --user
```

Reload Cockpit in your browser: **Samba file server** appears in the Tools menu.

## Quick Uninstall

```bash
sudo ./uninstall.sh      # or ./uninstall.sh --user
```

Uninstalling removes only the Cockpit UI. Samba, `smb.conf` and the Samba
users are not changed. Backups stay in `/var/lib/cockpit-samba/backups`.

## How it works

### Files

| Path | Purpose |
|------|---------|
| `/etc/samba/smb.conf` | The configuration being managed |
| `/var/lib/cockpit-samba/backups/smb.conf.YYYYMMDD-HHMMSS` (UTC) | Copy of the previous file, taken before every apply (newest 50 kept) |
| `/run/cockpit-samba/` | Lock file and temporary candidates for `testparm` |

### Editing without losing anything

`smb.conf` is parsed line by line. Comments (`#`, `;`), blank lines,
continuation lines (`\`), `include` lines, repeated sections and lines the
parser does not understand are kept verbatim. Only the parameters you change
are rewritten, in place, keeping their spelling and indentation. Names are
matched the way Samba does (case- and space-insensitive) including synonyms:
`writeable = yes`, `writable = yes` and `read only = no` are the same setting,
and an existing `writeable` line is updated rather than duplicated.

### Safe apply

1. The new file is shown as a diff against the current one, with testparm's
   verdict, unknown parameters and the security notes of the new file.
2. On **Apply**, a single privileged script:
   - takes a lock and refuses if `smb.conf` changed since it was read (SHA-256);
   - writes the candidate next to `smb.conf` and runs `testparm -s` on it — if
     testparm fails, nothing is changed;
   - copies the current file to the backup directory, then atomically
     replaces `smb.conf` (keeping owner and mode);
   - reloads running daemons with `smbcontrol smbd reload-config` (and `nmbd`).
3. Restoring a backup goes through the same steps.

`testparm` accepts unknown parameter names (Samba ignores them); they are
reported prominently but do not block applying.

## Example: an SMB1-only network scanner

Some older devices, such as the HP OfficeJet Pro 8620, can only "scan to
network folder" over SMB1 (NT1). Samba disables SMB1 by default. To allow it
for one device while limiting the exposure:

1. **Users → Add user**: choose *New system user without login*, name it
   `scanner`, give it a long random password (enter the same in the printer).
2. **Shares → Add share**: name `scans`, start from *Scanner drop folder*.
   Set **Valid users** to `scanner`, **Hosts allow** to the printer's address
   (e.g. `192.168.1.50`), and click *Create directory* if the path is missing.
   Make the directory writable for `scanner`, e.g.
   `sudo chown scanner:scanner /srv/samba/scans`.
3. **Global settings**: **Server min protocol** = `NT1`, **NTLM
   authentication** = `ntlmv1-permitted` if the device fails to log in with
   NTLMv2 only, and restrict **Hosts allow** to your LAN plus the printer
   (and consider **Interfaces** with **Bind interfaces only**).
4. Review and apply. The app keeps showing an SMB1 warning; that is expected.
   **Connections** shows the scanner's session as `NT1 (SMB1)`.

Result in `smb.conf`:

```ini
[global]
   server min protocol = NT1
   ntlm auth = ntlmv1-permitted
   hosts allow = 192.168.1. 127.0.0.1

[scans]
   comment = Scanner drop folder
   path = /srv/samba/scans
   browseable = no
   read only = no
   create mask = 0660
   directory mask = 0770
   valid users = scanner
   hosts allow = 192.168.1.50
```

Revert to `server min protocol` default (SMB2_02) when the device is retired.

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
npm run test:samba   # needs samba installed
```

The unit tests cover the `smb.conf` parser and serializer (lossless round
trip), editing, validation, security notes, parsing of `smbstatus`,
`pdbedit`, `systemctl` and `getent` output, and the apply scripts, which are
run against a temporary directory with stub `testparm` and `smbcontrol`.
`test:samba` runs the same apply flow with the installed `testparm` and an
unprivileged `smbd` on a temporary configuration (rejected files, backups,
restore, reload, and Samba's own reading of synonyms such as `writeable`).

## License

[MIT](../LICENSE)
