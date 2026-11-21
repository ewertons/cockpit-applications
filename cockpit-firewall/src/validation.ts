/**
 * Strict validation of every user-controlled value that ends up in generated
 * nftables text. Anything not accepted here never reaches nft.
 */

import {
    ANY_SERVICE,
    Endpoint,
    FirewallConfiguration,
    PortSpecification,
    allServices,
} from './model.js';

/** Object names (zones, hosts, services): letter first, then letters, digits, "_", ".", "-". */
const OBJECT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,62}$/;

/** Linux interface names: 1-15 chars, no "/", whitespace or quotes. Optional trailing "*" wildcard. */
const INTERFACE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,15}\*?$/;

export type AddressFamily = "ipv4" | "ipv6";

export interface ParsedAddress {
    family: AddressFamily;
    /** Canonical text: bare address for /32 and /128, "address/prefix" otherwise. */
    text: string;
}

/** Prefix of comments on rules the app generates itself; user comments may not use it. */
export const RESERVED_COMMENT_PREFIX = "cockpit-firewall:";

/** Rule comments: printable ASCII without quotes or backslashes, so they fit nft's 128-byte limit with a position tag. */
const COMMENT_PATTERN = /^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,100}$/;

/** WireGuard public key: 32 bytes, base64. */
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/** @returns whether `comment` may be stored as a rule comment. */
export function isValidComment(comment: string): boolean {
    return COMMENT_PATTERN.test(comment) && comment.trim() === comment &&
        !comment.startsWith(RESERVED_COMMENT_PREFIX) && !comment.startsWith("@");
}

/** @returns whether `key` looks like a WireGuard public key. */
export function isValidPublicKey(key: string): boolean {
    return PUBLIC_KEY_PATTERN.test(key);
}

/** @returns whether `name` is a valid zone, host or service name. */
export function isValidObjectName(name: string): boolean {
    return OBJECT_NAME_PATTERN.test(name);
}

/** @returns whether `name` is a valid interface name (optionally ending with "*"). */
export function isValidInterfaceName(name: string): boolean {
    return INTERFACE_NAME_PATTERN.test(name) && name !== "." && name !== ".." && name !== "*";
}

function parseIpv4Octets(text: string): number[] | null {
    const parts = text.split(".");
    if (parts.length !== 4)
        return null;
    const octets: number[] = [];
    for (const part of parts) {
        if (!/^(0|[1-9][0-9]{0,2})$/.test(part))
            return null;
        const value = Number(part);
        if (value > 255)
            return null;
        octets.push(value);
    }
    return octets;
}

function parseIpv6Groups(text: string): number[] | null {
    if (!/^[0-9A-Fa-f:]+$/.test(text) || text.length > 39)
        return null;
    const halves = text.split("::");
    if (halves.length > 2)
        return null;
    const parseHalf = (half: string): number[] | null => {
        if (half === "")
            return [];
        const groups = half.split(":");
        if (groups.some(group => !/^[0-9A-Fa-f]{1,4}$/.test(group)))
            return null;
        return groups.map(group => parseInt(group, 16));
    };
    const head = parseHalf(halves[0]);
    const tail = halves.length === 2 ? parseHalf(halves[1]) : [];
    if (head === null || tail === null)
        return null;
    if (halves.length === 1)
        return head.length === 8 ? head : null;
    if (head.length + tail.length > 7)
        return null;
    return [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
}

function hostBitsAreZero(bytes: number[], bitsPerUnit: number, prefixLength: number): boolean {
    for (let index = 0; index < bytes.length; index++) {
        const unitStart = index * bitsPerUnit;
        const networkBits = Math.max(0, Math.min(bitsPerUnit, prefixLength - unitStart));
        const hostMask = (1 << (bitsPerUnit - networkBits)) - 1;
        if ((bytes[index] & hostMask) !== 0)
            return false;
    }
    return true;
}

/**
 * Parses an IPv4/IPv6 address or CIDR network.
 * Rejects networks with host bits set (e.g. 10.0.0.1/24).
 * @returns the parsed address, or null when invalid.
 */
export function parseAddress(input: string): ParsedAddress | null {
    const text = input.trim();
    const slashIndex = text.indexOf("/");
    const addressPart = slashIndex === -1 ? text : text.slice(0, slashIndex);
    const prefixPart = slashIndex === -1 ? null : text.slice(slashIndex + 1);
    if (prefixPart !== null && !/^(0|[1-9][0-9]{0,2})$/.test(prefixPart))
        return null;

    const octets = parseIpv4Octets(addressPart);
    if (octets) {
        const prefixLength = prefixPart === null ? 32 : Number(prefixPart);
        if (prefixLength > 32 || !hostBitsAreZero(octets, 8, prefixLength))
            return null;
        const address = octets.join(".");
        return { family: "ipv4", text: prefixLength === 32 ? address : `${address}/${prefixLength}` };
    }

    const groups = parseIpv6Groups(addressPart);
    if (groups) {
        const prefixLength = prefixPart === null ? 128 : Number(prefixPart);
        if (prefixLength > 128 || !hostBitsAreZero(groups, 16, prefixLength))
            return null;
        const address = addressPart.toLowerCase();
        return { family: "ipv6", text: prefixLength === 128 ? address : `${address}/${prefixLength}` };
    }
    return null;
}

/** Inclusive numeric range covered by an address or network. */
export interface AddressRange {
    family: AddressFamily;
    low: bigint;
    high: bigint;
}

/** @returns the numeric range covered by a valid address or CIDR, or null when invalid. */
export function addressRange(input: string): AddressRange | null {
    const parsed = parseAddress(input);
    if (!parsed)
        return null;
    const [addressPart, prefixPart] = parsed.text.split("/");
    const bits = parsed.family === "ipv4" ? 32 : 128;
    const units = parsed.family === "ipv4" ? parseIpv4Octets(addressPart)! : parseIpv6Groups(addressPart)!;
    const unitBits = BigInt(parsed.family === "ipv4" ? 8 : 16);
    const low = units.reduce((accumulated, unit) => (accumulated << unitBits) + BigInt(unit), 0n);
    const prefixLength = prefixPart === undefined ? bits : Number(prefixPart);
    const high = low + (1n << BigInt(bits - prefixLength)) - 1n;
    return { family: parsed.family, low, high };
}

/** @returns pairs of addresses in the list that overlap (nft rejects overlapping intervals in one set). */
export function overlappingAddresses(addresses: string[]): [string, string][] {
    const ranges = addresses.map(address => ({ address, range: addressRange(address) }))
            .filter(entry => entry.range !== null);
    const overlaps: [string, string][] = [];
    for (let first = 0; first < ranges.length; first++)
        for (let second = first + 1; second < ranges.length; second++) {
            const a = ranges[first].range!;
            const b = ranges[second].range!;
            if (a.family === b.family && a.low <= b.high && b.low <= a.high)
                overlaps.push([ranges[first].address, ranges[second].address]);
        }
    return overlaps;
}

function portBounds(port: string): [number, number] {
    const [low, high] = port.split("-").map(Number);
    return [low, high ?? low];
}

/** @returns whether `port` is a single port 1-65535 or an ascending range "low-high". */
export function isValidPort(port: string): boolean {
    const match = /^([1-9][0-9]{0,4})(?:-([1-9][0-9]{0,4}))?$/.exec(port);
    if (!match)
        return false;
    const low = Number(match[1]);
    const high = match[2] === undefined ? low : Number(match[2]);
    return low <= 65535 && high <= 65535 && (match[2] === undefined || low < high);
}

/**
 * Parses a port list such as "tcp/22, udp/53, tcp/8000-8100".
 * @returns the port specifications, or an error message.
 */
export function parseServicePorts(text: string): PortSpecification[] | string {
    const entries = text.split(",").map(entry => entry.trim())
            .filter(Boolean);
    if (entries.length === 0)
        return "At least one protocol/port is required";
    const result: PortSpecification[] = [];
    for (const entry of entries) {
        const match = /^(tcp|udp)\/(.+)$/.exec(entry);
        if (!match || !isValidPort(match[2]))
            return `Invalid port "${entry}" (expected tcp/PORT, udp/PORT or tcp/LOW-HIGH)`;
        result.push({ protocol: match[1] as PortSpecification["protocol"], port: match[2] });
    }
    return result;
}

function validateEndpoint(configuration: FirewallConfiguration, endpoint: Endpoint, label: string, errors: string[]): void {
    if (endpoint.zone !== undefined && !configuration.zones.some(zone => zone.name === endpoint.zone))
        errors.push(`${label}: unknown zone "${endpoint.zone}"`);
    if (endpoint.host !== undefined && !configuration.hosts.some(host => host.name === endpoint.host))
        errors.push(`${label}: unknown host "${endpoint.host}"`);
}

function validateServiceReference(configuration: FirewallConfiguration, service: string, label: string, errors: string[]): void {
    if (!allServices(configuration).some(definition => definition.name === service))
        errors.push(`${label}: unknown service "${service}"`);
}

function validateComment(comment: string | undefined, label: string, errors: string[]): void {
    if (comment !== undefined && !isValidComment(comment))
        errors.push(`${label}: invalid comment (up to 100 printable ASCII characters, no quotes or backslashes, not starting with "@" or "${RESERVED_COMMENT_PREFIX}")`);
}

function checkUniqueNames(names: string[], kind: string, errors: string[]): void {
    const seen = new Set<string>();
    for (const name of names) {
        if (seen.has(name))
            errors.push(`Duplicate ${kind} name "${name}"`);
        seen.add(name);
    }
}

/**
 * Validates a complete configuration, including references between objects.
 * @returns a list of error messages; empty when the configuration is valid.
 */
export function validateConfiguration(configuration: FirewallConfiguration): string[] {
    const errors: string[] = [];
    const isVerdict = (value: unknown) => value === "accept" || value === "drop";

    for (const zone of configuration.zones) {
        if (!isValidObjectName(zone.name))
            errors.push(`Invalid zone name "${zone.name}"`);
        if (!Array.isArray(zone.interfaces) || zone.interfaces.length === 0)
            errors.push(`Zone "${zone.name}" has no interfaces`);
        else
            for (const interfaceName of zone.interfaces)
                if (!isValidInterfaceName(interfaceName))
                    errors.push(`Zone "${zone.name}": invalid interface name "${interfaceName}"`);
        if (!isVerdict(zone.forwardPolicy) || !isVerdict(zone.inputPolicy))
            errors.push(`Zone "${zone.name}": policy must be accept or drop`);
    }
    checkUniqueNames(configuration.zones.map(zone => zone.name), "zone", errors);

    for (const host of configuration.hosts) {
        if (!isValidObjectName(host.name))
            errors.push(`Invalid host name "${host.name}"`);
        if (!Array.isArray(host.addresses) || host.addresses.length === 0)
            errors.push(`Host "${host.name}" has no addresses`);
        else
            for (const address of host.addresses)
                if (!parseAddress(address))
                    errors.push(`Host "${host.name}": invalid address "${address}"`);
        if (Array.isArray(host.addresses)) {
            const unique = [...new Set(host.addresses.map(address => parseAddress(address)?.text ?? address))];
            for (const [first, second] of overlappingAddresses(unique))
                errors.push(`Host "${host.name}": addresses ${first} and ${second} overlap`);
        }
        if (host.origin === "wireguard" &&
            (!isValidInterfaceName(host.wireguardInterface ?? "") || !isValidPublicKey(host.wireguardPublicKey ?? "")))
            errors.push(`Host "${host.name}": invalid WireGuard interface or public key`);
    }
    checkUniqueNames(configuration.hosts.map(host => host.name), "host", errors);

    for (const service of configuration.services) {
        if (!isValidObjectName(service.name) || service.name === ANY_SERVICE)
            errors.push(`Invalid service name "${service.name}"`);
        if (!Array.isArray(service.ports) || service.ports.length === 0) {
            errors.push(`Service "${service.name}" has no ports`);
            continue;
        }
        for (const port of service.ports)
            if ((port.protocol !== "tcp" && port.protocol !== "udp") || !isValidPort(String(port.port)))
                errors.push(`Service "${service.name}": invalid port "${port.protocol}/${port.port}"`);
        const valid = service.ports.filter(port => isValidPort(String(port.port)));
        for (let first = 0; first < valid.length; first++)
            for (let second = first + 1; second < valid.length; second++) {
                const [firstLow, firstHigh] = portBounds(String(valid[first].port));
                const [secondLow, secondHigh] = portBounds(String(valid[second].port));
                if (valid[first].protocol === valid[second].protocol && firstLow <= secondHigh && secondLow <= firstHigh)
                    errors.push(`Service "${service.name}": ports ${valid[first].protocol}/${valid[first].port} and ${valid[second].protocol}/${valid[second].port} overlap`);
            }
    }
    checkUniqueNames(configuration.services.map(service => service.name), "service", errors);

    configuration.forwardRules.forEach((rule, index) => {
        const label = `Forward rule ${index + 1}`;
        validateEndpoint(configuration, rule.from, `${label} (from)`, errors);
        validateEndpoint(configuration, rule.to, `${label} (to)`, errors);
        validateServiceReference(configuration, rule.service, label, errors);
        if (!isVerdict(rule.action))
            errors.push(`${label}: action must be accept or drop`);
        validateComment(rule.comment, label, errors);
    });

    configuration.inputRules.forEach((rule, index) => {
        const label = `Input rule ${index + 1}`;
        validateEndpoint(configuration, rule.from, label, errors);
        if (rule.destinationHost !== undefined)
            validateEndpoint(configuration, { host: rule.destinationHost }, `${label} (to)`, errors);
        validateServiceReference(configuration, rule.service, label, errors);
        if (!isVerdict(rule.action))
            errors.push(`${label}: action must be accept or drop`);
        validateComment(rule.comment, label, errors);
    });

    configuration.natRules.forEach((rule, index) => {
        const label = `NAT rule ${index + 1}`;
        if (rule.sourceZone !== undefined)
            validateEndpoint(configuration, { zone: rule.sourceZone }, label, errors);
        if (!configuration.zones.some(zone => zone.name === rule.egressZone))
            errors.push(`${label}: unknown egress zone "${rule.egressZone}"`);
        if (rule.sourceAddress !== undefined) {
            const host = configuration.hosts.find(candidate => candidate.name === rule.sourceAddress);
            const addresses = host ? host.addresses : [rule.sourceAddress];
            if (addresses.some(address => parseAddress(address)?.family !== "ipv4"))
                errors.push(`${label}: source "${rule.sourceAddress}" must be an IPv4 address/CIDR or a host with only IPv4 addresses`);
        }
        validateComment(rule.comment, label, errors);
    });

    return errors;
}
