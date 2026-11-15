/** Validation for user input passed as positional arguments to privileged tools. */

const PORT_RANGE_PATTERN = /^(\d{1,5})(?:-(\d{1,5}))?$/;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_PATTERN = /^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*$/;

function isPortNumber(value: string): boolean {
    const port = Number(value);
    return port >= 1 && port <= 65535;
}

/**
 * Parse a port or "first-last" range.
 * @return The range in firewalld ("a-b") and ufw ("a:b") syntax, or null if invalid.
 */
export function parsePortRange(value: string): { firewalld: string; ufw: string } | null {
    const match = PORT_RANGE_PATTERN.exec(value.trim());
    if (!match || !isPortNumber(match[1]))
        return null;
    if (match[2] === undefined)
        return { firewalld: match[1], ufw: match[1] };
    if (!isPortNumber(match[2]) || Number(match[2]) < Number(match[1]))
        return null;
    return { firewalld: `${match[1]}-${match[2]}`, ufw: `${match[1]}:${match[2]}` };
}

/** Service or application profile name; never starts with "-". */
export function isValidServiceName(value: string): boolean {
    return value.length <= 64 && SERVICE_NAME_PATTERN.test(value);
}

/** Single IPv4 or IPv6 address, as accepted by "fail2ban-client unban". */
export function isValidIpAddress(value: string): boolean {
    const ipv4 = IPV4_PATTERN.exec(value);
    if (ipv4)
        return ipv4.slice(1).every(octet => Number(octet) <= 255);
    return value.length <= 45 && IPV6_PATTERN.test(value);
}

/**
 * Root shell script: read a new sshd_config on stdin, check it with "sshd -t"
 * and replace /etc/ssh/sshd_config only if the check passes.
 */
export const REPLACE_SSHD_CONFIG_SCRIPT = `set -eu
config=/etc/ssh/sshd_config
sshd=$(command -v sshd || echo /usr/sbin/sshd)
candidate=$(mktemp /etc/ssh/.sshd_config.XXXXXXXX)
trap 'rm -f "$candidate"' EXIT
cat > "$candidate"
chmod --reference="$config" "$candidate" 2>/dev/null || chmod 600 "$candidate"
chown --reference="$config" "$candidate" 2>/dev/null || true
"$sshd" -t -f "$candidate"
mv -f "$candidate" "$config"
trap - EXIT
restorecon "$config" 2>/dev/null || true
`;

/** Root shell script: check the current sshd configuration with "sshd -t". */
export const TEST_SSHD_CONFIG_SCRIPT = `set -eu
sshd=$(command -v sshd || echo /usr/sbin/sshd)
"$sshd" -t
`;
