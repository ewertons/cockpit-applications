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

// A missing file reads as empty; any other read error is reported.
const READ_SCRIPT = '[ -e "$1" ] || exit 0; exec cat -- "$1"';

// Writes stdin to a private temp file next to "$1", then renames it over "$1".
const REPLACE_SCRIPT = 'umask 077; t=$(mktemp -- "$1.XXXXXXXX") || exit 1; ' +
    'if cat > "$t" && mv -f -- "$t" "$1"; then exit 0; fi; rm -f -- "$t"; exit 1';

/**
 * Rewrites path with change(current). With an owner, the read and the write run
 * as that user and the file ends up mode 0600; without one, as root.
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

    const current = await cockpit.spawn(asOwner(owner, ["/bin/sh", "-c", READ_SCRIPT, "sh", path]),
                                        { superuser: "require", err: "message" });
    const proc = cockpit.spawn(asOwner(owner, ["/bin/sh", "-c", REPLACE_SCRIPT, "sh", path]),
                               { superuser: "require", err: "message" });
    proc.input(change(current));
    await proc;
}
