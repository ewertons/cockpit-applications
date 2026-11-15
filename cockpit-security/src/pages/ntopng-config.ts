// Helpers for the local ntopng instance: HTTP listener settings and admin password setup.

export const NTOPNG_CONFIG_PATH = "/etc/ntopng/ntopng.conf";
export const NTOPNG_DEFAULT_HTTP_PORT = 3000;
export const NTOPNG_MINIMUM_PASSWORD_LENGTH = 8;

const LISTENER_OPTION = /^\s*(-w|--http-port|-W|--https-port)(?:\s*=\s*|\s+)(\S+)\s*$/;
const LOOPBACK_ADDRESSES = ["127.0.0.1", "localhost", "[::1]"];

interface ListenerSetting {
    option: string;
    address: string;
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
        address: separator === -1 ? "" : value.slice(0, separator),
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
        if (setting.port !== "0" && !LOOPBACK_ADDRESSES.includes(setting.address))
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

/**
 * Sets the ntopng admin password from stdin. ntopng creates the admin user in
 * Redis on its first start, so wait for it before replacing the password hash
 * (ntopng stores an MD5 hex digest). The password never appears in argv.
 */
export const SET_ADMIN_PASSWORD_SCRIPT = [
    'key=ntopng.user.admin.password',
    'for attempt in $(seq 1 30); do',
    '  [ "$(redis-cli EXISTS "$key" </dev/null)" = "1" ] && break',
    '  sleep 1',
    'done',
    '[ "$(redis-cli EXISTS "$key" </dev/null)" = "1" ] || { echo "ntopng did not create its admin user; is ntopng running?" >&2; exit 1; }',
    'hash=$(md5sum | cut -d" " -f1) || exit 1',
    'printf %s "$hash" | redis-cli -x SET "$key" >/dev/null || exit 1',
    'redis-cli SET ntopng.prefs.admin_password_changed 1 </dev/null >/dev/null',
].join("\n");
