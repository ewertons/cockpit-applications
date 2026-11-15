// Validation and quoting for values passed to restic, ssh and systemd unit files.

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const HOSTNAME_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOSTNAME = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*$`);
const IPV6_ADDRESS = /^[0-9A-Fa-f:.]+$/;
const SSH_USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const KEY_PATH = /^\/[A-Za-z0-9._/@+-]+$/;
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPOSITORY_SCHEME = /^[a-z0-9]+:/;

export interface SftpEndpoint {
    user?: string;
    host: string;
    port?: number;
}

export function hasControlCharacters(value: string): boolean {
    return CONTROL_CHARACTERS.test(value);
}

function parseHostAndPort(authority: string, allowPort: boolean): SftpEndpoint {
    let user: string | undefined;
    let hostAndPort = authority;
    const at = authority.lastIndexOf("@");
    if (at !== -1) {
        user = authority.slice(0, at);
        hostAndPort = authority.slice(at + 1);
        if (!SSH_USER.test(user))
            throw new Error(`Invalid SFTP user name "${user}"`);
    }

    let host: string;
    let portText: string | undefined;
    if (hostAndPort.startsWith("[")) {
        const close = hostAndPort.indexOf("]");
        host = close === -1 ? "" : hostAndPort.slice(1, close);
        const rest = close === -1 ? "x" : hostAndPort.slice(close + 1);
        if (!host.includes(":") || !IPV6_ADDRESS.test(host) || (rest !== "" && !rest.startsWith(":")))
            throw new Error(`Invalid SFTP host "${hostAndPort}"`);
        portText = rest ? rest.slice(1) : undefined;
    } else {
        const colon = hostAndPort.indexOf(":");
        host = colon === -1 ? hostAndPort : hostAndPort.slice(0, colon);
        portText = colon === -1 ? undefined : hostAndPort.slice(colon + 1);
        if (!HOSTNAME.test(host))
            throw new Error(`Invalid SFTP host "${host}"`);
    }

    let port: number | undefined;
    if (portText !== undefined) {
        port = Number(portText);
        if (!allowPort || !/^[0-9]{1,5}$/.test(portText) || port < 1 || port > 65535)
            throw new Error(`Invalid SFTP port "${portText}"`);
    }

    const endpoint: SftpEndpoint = { host };
    if (user !== undefined)
        endpoint.user = user;
    if (port !== undefined)
        endpoint.port = port;
    return endpoint;
}

/**
 * Parses the user, host and port of an sftp restic repository
 * (`sftp:user@host:/path` or `sftp://user@host:port//path`).
 * Returns null for other repository types; throws when the host part is invalid.
 */
export function parseSftpRepository(repository: string): SftpEndpoint | null {
    if (repository.startsWith("sftp://")) {
        const rest = repository.slice("sftp://".length);
        const slash = rest.indexOf("/");
        return parseHostAndPort(slash === -1 ? rest : rest.slice(0, slash), true);
    }
    if (repository.startsWith("sftp:")) {
        const rest = repository.slice("sftp:".length);
        let end: number;
        if (rest.includes("@[") || rest.startsWith("[")) {
            end = rest.indexOf("]") + 1;
            if (end === 0)
                throw new Error(`Invalid SFTP host in "${repository}"`);
        } else {
            end = rest.indexOf(":");
            if (end === -1)
                end = rest.length;
        }
        return parseHostAndPort(rest.slice(0, end), false);
    }
    return null;
}

/** Returns an error message when the repository string cannot be passed safely to restic, otherwise null. */
export function validateRepository(repository: string): string | null {
    if (!repository)
        return "Repository must not be empty";
    if (hasControlCharacters(repository))
        return "Repository must not contain line breaks or control characters";
    if (repository.startsWith("-"))
        return "Repository must not start with \"-\"";
    if (!REPOSITORY_SCHEME.test(repository) && !repository.startsWith("/"))
        return "Local repository must be an absolute path";
    try {
        parseSftpRepository(repository);
    } catch (error) {
        return (error as Error).message;
    }
    return null;
}

/** Returns an error message when the SSH key path is not an absolute path of plain characters, otherwise null. */
export function validateKeyPath(keyPath: string): string | null {
    if (!KEY_PATH.test(keyPath) || keyPath.split("/").includes(".."))
        return "SSH key path must be an absolute path of letters, digits and . _ / @ + -";
    return null;
}

/** Returns an error message when the value is not an absolute path without control characters, otherwise null. */
export function validateAbsolutePath(path: string): string | null {
    if (!path.startsWith("/"))
        return `"${path}" is not an absolute path`;
    if (hasControlCharacters(path))
        return "Paths must not contain line breaks or control characters";
    return null;
}

function assertValid(error: string | null): void {
    if (error)
        throw new Error(error);
}

export function assertValidRepository(repository: string): void {
    assertValid(validateRepository(repository));
}

export function assertValidEnvironmentVariable(name: string, value: string): void {
    if (!ENVIRONMENT_VARIABLE_NAME.test(name))
        throw new Error(`Invalid environment variable name "${name}"`);
    if (hasControlCharacters(value))
        throw new Error(`${name} must not contain line breaks or control characters`);
}

/**
 * Builds restic's `-o sftp.command=...` option for an sftp repository and SSH key.
 * Returns no arguments for other repository types. Restic splits the command on
 * whitespace, so the host and key path are validated to plain characters.
 */
export function buildSftpCommandOption(repository: string, keyPath: string): string[] {
    const endpoint = parseSftpRepository(repository);
    if (!endpoint)
        return [];
    assertValid(validateKeyPath(keyPath));
    const destination = endpoint.user ? `${endpoint.user}@${endpoint.host}` : endpoint.host;
    const command = ["ssh", "-i", keyPath, "-o", "StrictHostKeyChecking=accept-new"];
    if (endpoint.port)
        command.push("-p", String(endpoint.port));
    command.push("-s", "--", destination, "sftp");
    return ["-o", `sftp.command=${command.join(" ")}`];
}

/** Quotes one ExecStart= argument so systemd passes it through literally. */
export function quoteSystemdExecArgument(argument: string): string {
    if (hasControlCharacters(argument))
        throw new Error("Command arguments must not contain line breaks or control characters");
    const escaped = argument
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/%/g, "%%")
            .replace(/\$/g, "$$$$");
    return `"${escaped}"`;
}

/** Builds an `Environment=` line whose value systemd stores literally. */
export function systemdEnvironmentLine(name: string, value: string): string {
    assertValidEnvironmentVariable(name, value);
    const escaped = `${name}=${value}`
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/%/g, "%%");
    return `Environment="${escaped}"`;
}

/** Escapes free text (e.g. Description=) for a unit file: one line, no specifier expansion. */
export function escapeSystemdText(text: string): string {
    return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/%/g, "%%"); // eslint-disable-line no-control-regex
}
