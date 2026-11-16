/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Edits files in a user's home directory as that user, so root never follows
 * links the user controls.
 */

import cockpit from 'cockpit';

/** Prefixes argv with runuser when owner is set; otherwise argv runs as root. */
export function asOwner(owner: string | null, argv: string[]): string[] {
    return owner ? ["runuser", "-u", owner, "--", ...argv] : argv;
}

// Prints a hash line, then the content; a missing file reads as empty with hash "none".
// The content is captured once so the hash matches exactly what is printed.
const READ_SCRIPT = 'if [ ! -e "$1" ]; then echo none; exit 0; fi; ' +
    'c=$(cat -- "$1" && echo x) || exit 1; c=${c%x}; ' + // eslint-disable-line no-template-curly-in-string
    'printf %s "$c" | sha256sum | cut -c1-64; printf %s "$c"';

// Writes stdin to a private temp file next to "$1" and renames it over "$1",
// unless "$1" no longer has hash "$2" (exit 75: changed since it was read).
const REPLACE_SCRIPT = 'umask 077; t=$(mktemp -- "$1.XXXXXXXX") || exit 1; ' +
    'cat > "$t" || { rm -f -- "$t"; exit 1; }; ' +
    'if [ -e "$1" ]; then h=$(sha256sum < "$1" | cut -c1-64) || h=; else h=none; fi; ' +
    'if [ "$h" != "$2" ]; then rm -f -- "$t"; exit 75; fi; ' +
    'mv -fT -- "$t" "$1" && exit 0; rm -f -- "$t"; exit 1';

const CHANGED_EXIT_STATUS = 75;
const MAX_ATTEMPTS = 5;

/**
 * Rewrites path with change(current). With an owner, the read and the write run
 * as that user and the file ends up mode 0600; without one, as root. Like
 * cockpit.file().modify(), change() is re-run when the file changed meanwhile.
 */
export async function modifyFile(
    owner: string | null, path: string, change: (current: string) => string
): Promise<void> {
    if (!owner) {
        const handle = cockpit.file(path, { superuser: "require" });
        try {
            await handle.modify((current: string | null) => change(current || ""));
        } finally {
            handle.close();
        }
        return;
    }

    for (let attempt = 1; ; attempt++) {
        const output = await cockpit.spawn(asOwner(owner, ["/bin/sh", "-c", READ_SCRIPT, "sh", path]),
                                           { superuser: "require", err: "message" });
        const newline = output.indexOf("\n");
        const hash = output.slice(0, newline);
        const updated = change(output.slice(newline + 1));
        try {
            const proc = cockpit.spawn(asOwner(owner, ["/bin/sh", "-c", REPLACE_SCRIPT, "sh", path, hash]),
                                       { superuser: "require", err: "message" });
            proc.input(updated);
            await proc;
            return;
        } catch (error) {
            const exitStatus = (error as cockpit.ProcessError).exit_status;
            if (exitStatus !== CHANGED_EXIT_STATUS || attempt >= MAX_ATTEMPTS)
                throw error;
        }
    }
}
