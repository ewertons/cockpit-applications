/** Validation for user input passed as positional arguments to privileged tools. */

const PORT_RANGE_PATTERN = /^(\d{1,5})(?:-(\d{1,5}))?$/;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_GROUP_PATTERN = /^[0-9A-Fa-f]{1,4}$/;

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

function isValidIpv4Address(value: string): boolean {
    const ipv4 = IPV4_PATTERN.exec(value);
    return ipv4 !== null && ipv4.slice(1).every(octet => Number(octet) <= 255);
}

/** Counts the 16-bit groups of one side of an IPv6 address, or returns null if a group is invalid. */
function countIpv6Groups(part: string, allowEmbeddedIpv4: boolean): number | null {
    if (part === "")
        return 0;
    const groups = part.split(":");
    const last = groups[groups.length - 1];
    let count = groups.length;
    if (allowEmbeddedIpv4 && last.includes(".")) {
        if (!isValidIpv4Address(last))
            return null;
        groups.pop();
        count += 1;
    }
    return groups.every(group => IPV6_GROUP_PATTERN.test(group)) ? count : null;
}

function isValidIpv6Address(value: string): boolean {
    const halves = value.split("::");
    if (halves.length > 2)
        return false;
    if (halves.length === 1)
        return countIpv6Groups(value, true) === 8;
    const head = countIpv6Groups(halves[0], false);
    const tail = countIpv6Groups(halves[1], true);
    return head !== null && tail !== null && head + tail <= 7;
}

/** Single IPv4 or IPv6 address, as accepted by "fail2ban-client unban". */
export function isValidIpAddress(value: string): boolean {
    return isValidIpv4Address(value) || (value.length <= 45 && isValidIpv6Address(value));
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
