// Helpers for the local ntopng instance: HTTP listener settings and admin password setup.

export const NTOPNG_CONFIG_PATH = "/etc/ntopng/ntopng.conf";
export const NTOPNG_DEFAULT_HTTP_PORT = 3000;
export const NTOPNG_MINIMUM_PASSWORD_LENGTH = 8;

const LISTENER_OPTION = /^\s*(-w|--http-port|-W|--https-port)(?:\s*=\s*|\s+)(\S+)\s*$/;
// An empty address (e.g. "-w=:3000") is ntopng's shorthand for the loopback address.
const LOOPBACK_ADDRESSES = ["", "127.0.0.1", "localhost", "[::1]"];
const REDIS_OPTION = /^\s*(?:-r|--redis)(?:\s*=\s*|\s+)(.*?)\s*$/;
const REDIS_HOST = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const REDIS_SOCKET_PATH = /^\/[A-Za-z0-9._/-]+$/;
// eslint-disable-next-line no-control-regex
const UNSUPPORTED_REDIS_PASSWORD_CHARACTERS = /[\u0000-\u001f\u007f\\`]/;

interface ListenerSetting {
    option: string;
    /** null when no address is given (all interfaces). */
    address: string | null;
    port: string;
}

function parseListenerLine(line: string): ListenerSetting | null {
    const match = line.match(LISTENER_OPTION);
    if (!match)
        return null;
    const value = match[2];
    const separator = value.lastIndexOf(":");
    return {
        option: match[1],
        address: separator === -1 ? null : value.slice(0, separator),
        port: separator === -1 ? value : value.slice(separator + 1),
    };
}

function isHttpOption(option: string): boolean {
    return option === "-w" || option === "--http-port";
}

/** HTTP port configured in ntopng.conf, or the ntopng default. */
export function httpPortFromConfig(configContent: string): number {
    for (const line of configContent.split("\n")) {
        const setting = parseListenerLine(line);
        if (setting && isHttpOption(setting.option) && /^[0-9]+$/.test(setting.port))
            return Number(setting.port);
    }
    return NTOPNG_DEFAULT_HTTP_PORT;
}

/**
 * True when every enabled web listener (HTTP and HTTPS) in ntopng.conf is bound to a loopback address.
 * A missing HTTP option means ntopng listens on all interfaces on its default port.
 */
export function listenersAreLoopbackOnly(configContent: string): boolean {
    let hasHttpOption = false;
    for (const line of configContent.split("\n")) {
        const setting = parseListenerLine(line);
        if (!setting)
            continue;
        if (isHttpOption(setting.option))
            hasHttpOption = true;
        if (setting.port !== "0" && (setting.address === null || !LOOPBACK_ADDRESSES.includes(setting.address)))
            return false;
    }
    return hasHttpOption;
}

/**
 * Returns ntopng.conf content with the web listeners bound to 127.0.0.1, or to all
 * interfaces when listenOnAllInterfaces is set. Ports and other options are kept;
 * an HTTP listener on the default port is added when none is configured.
 */
export function configureListeners(configContent: string, listenOnAllInterfaces: boolean): string {
    const addressPrefix = listenOnAllInterfaces ? "" : "127.0.0.1:";
    let hasHttpOption = false;
    const lines = configContent.split("\n").map(line => {
        const setting = parseListenerLine(line);
        if (!setting)
            return line;
        if (isHttpOption(setting.option))
            hasHttpOption = true;
        if (setting.port === "0")
            return line;
        return `${setting.option}=${addressPrefix}${setting.port}`;
    });
    if (lines.length > 0 && lines[lines.length - 1] === "")
        lines.pop();
    if (!hasHttpOption)
        lines.push(`-w=${addressPrefix}${NTOPNG_DEFAULT_HTTP_PORT}`);
    return lines.join("\n") + "\n";
}

/** Returns an error message when the new admin password is not acceptable, otherwise null. */
export function validateAdminPassword(password: string, confirmation: string): string | null {
    if (password.length < NTOPNG_MINIMUM_PASSWORD_LENGTH)
        return `The password must have at least ${NTOPNG_MINIMUM_PASSWORD_LENGTH} characters.`;
    if (password === "admin")
        return "The default password cannot be used.";
    if (password !== confirmation)
        return "The passwords do not match.";
    return null;
}

export interface RedisConnection {
    host: string;
    port: number;
    socketPath?: string;
    password?: string;
    database: number;
}

/**
 * Redis connection used by ntopng, from its -r/--redis option
 * (`[host[:port[:password]]][@database]` or a socket path). Throws for values this page cannot pass on safely.
 */
export function redisConnectionFromConfig(configContent: string): RedisConnection {
    let value: string | undefined;
    for (const line of configContent.split("\n")) {
        const match = line.match(REDIS_OPTION);
        if (match)
            value = match[1];
    }
    const connection: RedisConnection = { host: "127.0.0.1", port: 6379, database: 0 };
    if (value === undefined)
        return connection;

    const unsupported = new Error(`Unsupported ntopng Redis setting "-r=${value}"`);
    let endpoint = value;
    const databaseSeparator = value.lastIndexOf("@");
    if (databaseSeparator !== -1) {
        const database = value.slice(databaseSeparator + 1);
        if (!/^[0-9]{1,5}$/.test(database))
            throw unsupported;
        connection.database = Number(database);
        endpoint = value.slice(0, databaseSeparator);
    }
    if (endpoint.startsWith("/")) {
        if (!REDIS_SOCKET_PATH.test(endpoint))
            throw unsupported;
        connection.socketPath = endpoint;
        return connection;
    }
    if (endpoint === "")
        return connection;

    const [host, port, ...passwordParts] = endpoint.split(":");
    if (!REDIS_HOST.test(host))
        throw unsupported;
    connection.host = host;
    if (port !== undefined && port !== "") {
        if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
            throw unsupported;
        connection.port = Number(port);
    }
    const password = passwordParts.join(":");
    if (password) {
        if (UNSUPPORTED_REDIS_PASSWORD_CHARACTERS.test(password))
            throw unsupported;
        connection.password = password;
    }
    return connection;
}

/** Environment for SET_ADMIN_PASSWORD_SCRIPT; the Redis password goes in REDISCLI_AUTH, never in argv. */
export function redisEnvironment(connection: RedisConnection): string[] {
    const environment = [
        `NTOPNG_REDIS_HOST=${connection.host}`,
        `NTOPNG_REDIS_PORT=${connection.port}`,
        `NTOPNG_REDIS_SOCKET=${connection.socketPath ?? ""}`,
        `NTOPNG_REDIS_DATABASE=${connection.database}`,
    ];
    if (connection.password)
        environment.push(`REDISCLI_AUTH=${connection.password}`);
    return environment;
}

/**
 * Sets the ntopng admin password from stdin, using the Redis connection from
 * redisEnvironment(). ntopng creates the admin user in Redis on its first start,
 * so wait for it before replacing the password hash (ntopng stores an MD5 hex
 * digest). Each write must reply OK and the stored hash is read back.
 */
export const SET_ADMIN_PASSWORD_SCRIPT = [
    'key=ntopng.user.admin.password',
    'if [ -n "$NTOPNG_REDIS_SOCKET" ]; then set -- -s "$NTOPNG_REDIS_SOCKET"; else set -- -h "$NTOPNG_REDIS_HOST" -p "$NTOPNG_REDIS_PORT"; fi',
    'set -- "$@" -n "$NTOPNG_REDIS_DATABASE"',
    'for attempt in $(seq 1 30); do',
    '  [ "$(redis-cli "$@" EXISTS "$key" </dev/null)" = "1" ] && break',
    '  sleep 1',
    'done',
    '[ "$(redis-cli "$@" EXISTS "$key" </dev/null)" = "1" ] || { echo "ntopng did not create its admin user; is ntopng running?" >&2; exit 1; }',
    'hash=$(md5sum | cut -d" " -f1) || exit 1',
    'reply=$(printf %s "$hash" | redis-cli "$@" -x SET "$key") || exit 1',
    '[ "$reply" = "OK" ] || { echo "Redis did not store the new password: $reply" >&2; exit 1; }',
    '[ "$(redis-cli "$@" GET "$key" </dev/null)" = "$hash" ] || { echo "The new password was not stored in Redis" >&2; exit 1; }',
    'reply=$(redis-cli "$@" SET ntopng.prefs.admin_password_changed 1 </dev/null) || exit 1',
    '[ "$reply" = "OK" ] || { echo "Redis did not store the password change flag: $reply" >&2; exit 1; }',
].join("\n");
