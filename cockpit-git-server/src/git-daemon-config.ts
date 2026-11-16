/** Path of the Debian/Ubuntu git-daemon defaults file. */
export const GIT_DAEMON_DEFAULTS_PATH = "/etc/default/git-daemon";

const ENABLE_RECEIVE_PACK = "--enable=receive-pack";
const READ_ONLY_OPTIONS = ["--disable=receive-pack", "--forbid-override=receive-pack"];
const RECEIVE_PACK_OPTIONS = new Set([
    ENABLE_RECEIVE_PACK, "--allow-override=receive-pack", ...READ_ONLY_OPTIONS,
]);

interface OptionsAssignment {
    options: string[];
    /** Text after the assigned value, such as a trailing comment. */
    trailing: string;
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
    return {
        options: value.split(/\s+/).filter(Boolean),
        trailing: source.slice(index).trim(),
    };
}

function formatOptionsAssignment(assignment: OptionsAssignment): string {
    const escaped = assignment.options.join(" ").replace(/[\\"$`]/g, character => "\\" + character);
    return `GIT_DAEMON_OPTIONS="${escaped}"` + (assignment.trailing ? " " + assignment.trailing : "");
}

/** True when the git-daemon defaults file enables push (receive-pack) for all repositories. */
export function defaultsEnableReceivePack(defaultsContent: string): boolean {
    return defaultsContent.split("\n").some(line =>
        parseOptionsAssignment(line)?.options.includes(ENABLE_RECEIVE_PACK) ?? false);
}

/**
 * Returns the defaults file content with GIT_DAEMON_OPTIONS forcing receive-pack off:
 * `--enable=receive-pack` is dropped and `--disable=receive-pack --forbid-override=receive-pack`
 * is added, so a repository's daemon.receivepack setting cannot turn push back on.
 */
export function removeReceivePackFromDefaults(defaultsContent: string): string {
    let found = false;
    const lines = defaultsContent.split("\n").map(line => {
        const assignment = parseOptionsAssignment(line);
        if (assignment === null)
            return line;
        found = true;
        const options = assignment.options.filter(option => !RECEIVE_PACK_OPTIONS.has(option));
        return formatOptionsAssignment({ options: [...options, ...READ_ONLY_OPTIONS], trailing: assignment.trailing });
    });
    if (!found) {
        const optionsLine = formatOptionsAssignment({ options: READ_ONLY_OPTIONS, trailing: "" });
        if (lines.length > 0 && lines[lines.length - 1] === "")
            lines.splice(lines.length - 1, 0, optionsLine);
        else
            lines.push(optionsLine);
    }
    return lines.join("\n");
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

/** True when `git config --bool --get daemon.receivepack` output enables push for the repository. */
export function repositoryConfigEnablesDaemonPush(configValue: string): boolean {
    return configValue.trim() === "true";
}
