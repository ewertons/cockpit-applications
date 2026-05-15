# Cockpit Git Server

A [Cockpit](https://cockpit-project.org/) extension for managing bare Git repositories on a Linux server.

## Features

- **Repository CRUD** — list, create, delete bare repos under `/srv/git/`
- **Repository detail** — branches, tags, recent commits, git config
- **Web-based repo browsing** — commit log, file tree, file viewer, diff viewer with branch/tag selector
- **Service management** — start/stop/restart `git-daemon.service` and `sshd.service` via systemd
- **Access control** — manage SSH public keys in `~git/.ssh/authorized_keys`, with Gitolite auto-detection
- **Clone URLs** — display SSH and git:// clone URLs for each repo

## Requirements

- [Cockpit](https://cockpit-project.org/) installed and running
- `git` installed (`/usr/bin/git`)
- Node.js and npm (for building)

On Debian/Ubuntu:

    sudo apt install cockpit git gettext nodejs npm make

On Fedora:

    sudo dnf install cockpit git gettext nodejs npm make

## Quick Install

```bash
# Clone and enter the project
git clone https://github.com/cockpit-project/cockpit-git-server.git
cd cockpit-git-server

# System-wide install (requires root)
sudo ./install.sh

# Or user-only install (no root needed)
./install.sh --user
```

Reload Cockpit in your browser — **Git Server** appears in the Tools menu.

## Quick Uninstall

```bash
# System-wide
sudo ./uninstall.sh

# Or user-only
./uninstall.sh --user
```

## Development

Build and install for local development:

```bash
npm install --ignore-scripts
make devel-install
```

This creates a symlink from `dist/` to `~/.local/share/cockpit/git-server`.

Rebuild after changes:

    make

Or use watch mode for auto-rebuild on save:

    make watch

To "uninstall" the dev symlink:

    make devel-uninstall

## Running eslint

```bash
npm run eslint
npm run eslint:fix    # auto-fix violations
```

## Running stylelint

```bash
npm run stylelint
npm run stylelint:fix
```

## Running tests

Run integration tests in a Cockpit test VM:

    make check

Or run manually after preparing the VM:

    TEST_OS=centos-9-stream test/check-application -tvs

## Further reading

 * [Cockpit Deployment and Developer documentation](https://cockpit-project.org/guide/latest/)
 * [Make your project easily discoverable](https://cockpit-project.org/blog/making-a-cockpit-application.html)
