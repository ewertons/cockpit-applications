/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from 'cockpit';

const BASE_PATH = "/srv/git";

/**
 * Runs git on a repository as the git account that owns /srv/git, never as
 * root: a symlinked repository then reaches only what that account can read,
 * and repository config runs with that account's rights. Without the rights
 * to switch user, git runs as the session user. Errors yield "".
 */
export function repoGit(repoPath: string, args: string[]): Promise<string> {
    const git = ["git", "--git-dir", repoPath, ...args];
    return cockpit.spawn(["runuser", "-u", "git", "--", ...git],
                         { superuser: "require", err: "ignore", directory: BASE_PATH })
            .catch(() => cockpit.spawn(git, { err: "ignore", directory: BASE_PATH }))
            .catch(() => "");
}
