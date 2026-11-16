/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from 'cockpit';

const BASE_PATH = "/srv/git";

let sessionIsRoot: Promise<boolean> | null = null;

/**
 * Runs git on a repository as the git account that owns /srv/git, never as
 * root: a symlinked repository then reaches only what that account can read,
 * and repository config runs with that account's rights. Only when switching
 * user is refused, in a non-root session, does git run as the session user;
 * failed git commands are not retried. Errors yield "".
 */
export async function repoGit(repoPath: string, args: string[]): Promise<string> {
    const git = ["git", "--git-dir", repoPath, ...args];
    try {
        return await cockpit.spawn(["runuser", "-u", "git", "--", ...git],
                                   { superuser: "require", err: "ignore", directory: BASE_PATH });
    } catch (error) {
        // problem is set when the bridge refused the privileged spawn; a git failure only has an exit status.
        if (!(error as cockpit.ProcessError).problem)
            return "";
    }
    sessionIsRoot ??= cockpit.spawn(["id", "-u"]).then(uid => uid.trim() === "0", () => true);
    if (await sessionIsRoot)
        return "";
    try {
        return await cockpit.spawn(git, { err: "ignore", directory: BASE_PATH });
    } catch {
        return "";
    }
}

/** Resolves false when the git account that repoGit runs as does not exist. */
export function gitAccountExists(): Promise<boolean> {
    return cockpit.spawn(["getent", "passwd", "git"], { err: "ignore" }).then(() => true, () => false);
}
