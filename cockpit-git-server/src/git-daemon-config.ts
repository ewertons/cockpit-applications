/** Path of the Debian/Ubuntu git-daemon defaults file. */
export const GIT_DAEMON_DEFAULTS_PATH = "/etc/default/git-daemon";

const ENABLE_RECEIVE_PACK = "--enable=receive-pack";
const READ_ONLY_COMMENT = "# Added by cockpit-git-server: push is accepted over SSH only.";
/**
 * git daemon applies options in order, so these win over an earlier --enable=receive-pack,
 * and --forbid-override stops a repository's daemon.receivepack from re-enabling push.
 * The existing value is extended rather than rewritten so its quoting and expansions stay intact.
 */
const READ_ONLY_ASSIGNMENT = 'GIT_DAEMON_OPTIONS="$GIT_DAEMON_OPTIONS --disable=receive-pack --forbid-override=receive-pack"';

interface OptionsAssignment {
    options: string[];
}

/**
 * Parse a shell `GIT_DAEMON_OPTIONS=value` line as sh would: the value ends at the
 * first unquoted blank, and the init script later splits it into words.
 */
function parseOptionsAssignment(line: string): OptionsAssignment | null {
    const match = line.match(/^\s*GIT_DAEMON_OPTIONS=(.*)$/);
    if (!match)
        return null;
    const source = match[1];
    let value = "";
    let quote: string | null = null;
    let index = 0;
    for (; index < source.length; index++) {
        const character = source[index];
        if (quote === "'") {
            if (character === "'")
                quote = null;
            else
                value += character;
        } else if (character === "\\" && index + 1 < source.length &&
                   (quote === null || "\\\"$`".includes(source[index + 1]))) {
            value += source[++index];
        } else if (quote === '"') {
            if (character === '"')
                quote = null;
            else
                value += character;
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (/\s/.test(character)) {
            break;
        } else {
            value += character;
        }
    }
    return { options: value.split(/\s+/).filter(Boolean) };
}

function isOptionsAssignment(line: string): boolean {
    return /^\s*GIT_DAEMON_OPTIONS=/.test(line);
}

function endsWithReadOnlyAssignment(lines: string[]): boolean {
    const assignments = lines.filter(isOptionsAssignment);
    return assignments.length > 0 && assignments[assignments.length - 1].trim() === READ_ONLY_ASSIGNMENT;
}

/** True when the git-daemon defaults file enables push (receive-pack) for all repositories. */
export function defaultsEnableReceivePack(defaultsContent: string): boolean {
    const lines = defaultsContent.split("\n");
    if (endsWithReadOnlyAssignment(lines))
        return false;
    return lines.some(line => parseOptionsAssignment(line)?.options.includes(ENABLE_RECEIVE_PACK) ?? false);
}

/**
 * Returns the defaults file content with receive-pack forced off by appending
 * READ_ONLY_ASSIGNMENT after every other GIT_DAEMON_OPTIONS assignment.
 * Existing lines are not modified.
 */
export function removeReceivePackFromDefaults(defaultsContent: string): string {
    const lines = defaultsContent.split("\n");
    if (endsWithReadOnlyAssignment(lines))
        return defaultsContent;
    const kept = lines.filter(line => line.trim() !== READ_ONLY_ASSIGNMENT && line.trim() !== READ_ONLY_COMMENT);
    while (kept.length > 0 && kept[kept.length - 1] === "")
        kept.pop();
    // An empty line ends a trailing backslash continuation before the appended lines.
    if (kept.length > 0 && kept[kept.length - 1].endsWith("\\"))
        kept.push("");
    return [...kept, READ_ONLY_COMMENT, READ_ONLY_ASSIGNMENT, ""].join("\n");
}

/**
 * Returns the defaults file content configured to serve /srv/git read-only as user git.
 * Push is forced off as in removeReceivePackFromDefaults(); other options are kept.
 */
export function configureReadOnlyDefaults(defaultsContent: string, basePath: string): string {
    const settings: Record<string, string> = {
        GIT_DAEMON_ENABLE: "true",
        GIT_DAEMON_USER: "git",
        GIT_DAEMON_BASE_PATH: basePath,
        GIT_DAEMON_DIRECTORY: basePath,
    };
    const seen = new Set<string>();
    const lines = defaultsContent.split("\n")
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
    return removeReceivePackFromDefaults(lines.join("\n") + "\n");
}

/** True when `git config --bool --get daemon.receivepack` output enables push for the repository. */
export function repositoryConfigEnablesDaemonPush(configValue: string): boolean {
    return configValue.trim() === "true";
}
