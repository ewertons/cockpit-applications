# Cockpit Backup

A [Cockpit](https://cockpit-project.org/) extension for managing file backups using [restic](https://restic.net/).

## Features

- **Backup destinations** — local and remote targets (SFTP, S3, Azure, GCS, B2)
- **Scheduled backups** — systemd timers for automated runs
- **Snapshot management** — versioning, retention policies, browsing
- **Point-in-time restore** — restore files from any snapshot
- **Status monitoring** — job history and current backup status

## Requirements

- [Cockpit](https://cockpit-project.org/) installed and running
- [restic](https://restic.net/) installed
- Node.js and npm (for building)

## Quick Install

```bash
# System-wide install (requires root)
sudo ./install.sh

# Or user-only install (no root needed)
./install.sh --user
```

Reload Cockpit in your browser — **Backup** appears in the Tools menu.

## Quick Uninstall

```bash
# System-wide
sudo ./uninstall.sh

# Or user-only
./uninstall.sh --user
```

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

[LGPL-2.1](../LICENSE)
