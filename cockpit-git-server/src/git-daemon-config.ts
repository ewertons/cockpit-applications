/** Path of the Debian/Ubuntu git-daemon defaults file. */
export const GIT_DAEMON_DEFAULTS_PATH = "/etc/default/git-daemon";

const RECEIVE_PACK_OPTION = /(^|\s)--enable=receive-pack(?=\s|$)/;

function optionsLineValue(line: string): string | null {
    const match = line.match(/^\s*GIT_DAEMON_OPTIONS\s*=\s*(.*)$/);
    return match ? match[1] : null;
}

function unquote(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.endsWith(trimmed[0]))
        return trimmed.slice(1, -1);
    return trimmed;
}

/** True when the git-daemon defaults file enables push (receive-pack) for all repositories. */
export function defaultsEnableReceivePack(defaultsContent: string): boolean {
    return defaultsContent.split("\n").some(line => {
        const value = optionsLineValue(line);
        return value !== null && RECEIVE_PACK_OPTION.test(unquote(value));
    });
}

/** Returns the defaults file content with `--enable=receive-pack` removed from GIT_DAEMON_OPTIONS. */
export function removeReceivePackFromDefaults(defaultsContent: string): string {
    return defaultsContent.split("\n").map(line => {
        const value = optionsLineValue(line);
        if (value === null)
            return line;
        const remaining = unquote(value).split(/\s+/)
                .filter(option => option && option !== "--enable=receive-pack")
                .join(" ");
        return `GIT_DAEMON_OPTIONS="${remaining}"`;
    })
            .join("\n");
}

/**
 * Returns the defaults file content configured to serve /srv/git read-only as user git.
 * Any `--enable=receive-pack` option is dropped; other options are kept.
 */
export function configureReadOnlyDefaults(defaultsContent: string, basePath: string): string {
    const settings: Record<string, string> = {
        GIT_DAEMON_ENABLE: "true",
        GIT_DAEMON_USER: "git",
        GIT_DAEMON_BASE_PATH: basePath,
        GIT_DAEMON_DIRECTORY: basePath,
    };
    const seen = new Set<string>();
    const lines = removeReceivePackFromDefaults(defaultsContent).split("\n")
            .map(line => {
                const match = line.match(/^\s*([A-Z_]+)\s*=/);
                if (match && match[1] in settings) {
                    seen.add(match[1]);
                    return `${match[1]}=${settings[match[1]]}`;
                }
                return line;
            });
    if (lines.length > 0 && lines[lines.length - 1] === "")
        lines.pop();
    for (const key of Object.keys(settings)) {
        if (!seen.has(key))
            lines.push(`${key}=${settings[key]}`);
    }
    return lines.join("\n") + "\n";
}

/** True when `git config --get daemon.receivepack` output enables push for the repository. */
export function repositoryConfigEnablesDaemonPush(configValue: string): boolean {
    return ["true", "yes", "on", "1"].includes(configValue.trim().toLowerCase());
}
