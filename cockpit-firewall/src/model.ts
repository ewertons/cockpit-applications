/**
 * Firewall configuration model. Pure data and helpers: no Cockpit APIs, so it
 * can be unit tested under Node.
 */

export type Verdict = "accept" | "drop";
export type TransportProtocol = "tcp" | "udp";

/** Named group of network interfaces (e.g. vpn = wg0). */
export interface Zone {
    name: string;
    interfaces: string[];
    /** Verdict for forwarded traffic entering through this zone that no rule matched. */
    forwardPolicy: Verdict;
    /** Verdict for traffic to this host entering through this zone that no rule matched. */
    inputPolicy: Verdict;
}

/** Named address set: single addresses or networks, IPv4 and/or IPv6. */
export interface HostEntry {
    name: string;
    addresses: string[];
    /** "wireguard" when imported read-only from a WireGuard peer. */
    origin: "manual" | "wireguard";
    wireguardInterface?: string;
}

export interface PortSpecification {
    protocol: TransportProtocol;
    /** Single port ("22") or inclusive range ("8000-8100"). */
    port: string;
}

/** Named set of ports. An empty port list means any protocol and port. */
export interface ServiceDefinition {
    name: string;
    ports: PortSpecification[];
}

/** Traffic endpoint: a zone, a host, both, or neither (any). */
export interface Endpoint {
    zone?: string;
    host?: string;
}

export interface ForwardRule {
    from: Endpoint;
    to: Endpoint;
    service: string;
    action: Verdict;
    enabled: boolean;
}

export interface InputRule {
    from: Endpoint;
    service: string;
    action: Verdict;
    enabled: boolean;
}

/** IPv4 masquerade of traffic from a source zone and/or address leaving through an egress zone. */
export interface NatRule {
    sourceZone?: string;
    /** Host name or literal IPv4 address/CIDR. */
    sourceAddress?: string;
    egressZone: string;
    enabled: boolean;
}

export interface FirewallConfiguration {
    version: 1;
    zones: Zone[];
    hosts: HostEntry[];
    services: ServiceDefinition[];
    forwardRules: ForwardRule[];
    natRules: NatRule[];
    inputRules: InputRule[];
    /** Keep SSH (tcp/22) and Cockpit (tcp/9090) reachable in the input chain. */
    allowManagementAccess: boolean;
    /** WireGuard listen ports, kept reachable in the input chain. Set by peer import. */
    wireguardListenPorts: number[];
}

export const INET_TABLE_NAME = "cockpit_fw";
export const NAT_TABLE_NAME = "cockpit_fw_nat";

export const ANY_SERVICE = "any";

export const BUILT_IN_SERVICES: readonly ServiceDefinition[] = [
    { name: ANY_SERVICE, ports: [] },
    { name: "ssh", ports: [{ protocol: "tcp", port: "22" }] },
    { name: "http", ports: [{ protocol: "tcp", port: "80" }] },
    { name: "https", ports: [{ protocol: "tcp", port: "443" }] },
    { name: "dns", ports: [{ protocol: "tcp", port: "53" }, { protocol: "udp", port: "53" }] },
    { name: "cockpit", ports: [{ protocol: "tcp", port: "9090" }] },
    { name: "rdp", ports: [{ protocol: "tcp", port: "3389" }] },
    { name: "smb", ports: [{ protocol: "tcp", port: "445" }] },
    { name: "wireguard", ports: [{ protocol: "udp", port: "51820" }] },
];

export const MANAGEMENT_TCP_PORTS: readonly number[] = [22, 9090];

/** @returns an empty configuration with management access kept open. */
export function createEmptyConfiguration(): FirewallConfiguration {
    return {
        version: 1,
        zones: [],
        hosts: [],
        services: [],
        forwardRules: [],
        natRules: [],
        inputRules: [],
        allowManagementAccess: true,
        wireguardListenPorts: [],
    };
}

/** @returns built-in services followed by user services. */
export function allServices(configuration: FirewallConfiguration): ServiceDefinition[] {
    return [...BUILT_IN_SERVICES, ...configuration.services];
}

/** @returns whether IPv4 forwarding is needed (any enabled forward or NAT rule). */
export function requiresForwarding(configuration: FirewallConfiguration): boolean {
    return configuration.forwardRules.some(rule => rule.enabled) ||
        configuration.natRules.some(rule => rule.enabled);
}

/**
 * Normalizes untrusted JSON (e.g. the stored configuration file) into a
 * configuration object. Values are not validated here; see validateConfiguration.
 */
export function normalizeConfiguration(value: unknown): FirewallConfiguration {
    const empty = createEmptyConfiguration();
    if (typeof value !== "object" || value === null)
        return empty;
    const source = value as Partial<FirewallConfiguration>;
    const arrayOrEmpty = <T, >(candidate: T[] | undefined): T[] => Array.isArray(candidate) ? candidate : [];
    return {
        version: 1,
        zones: arrayOrEmpty(source.zones),
        hosts: arrayOrEmpty(source.hosts),
        services: arrayOrEmpty(source.services),
        forwardRules: arrayOrEmpty(source.forwardRules),
        natRules: arrayOrEmpty(source.natRules),
        inputRules: arrayOrEmpty(source.inputRules),
        allowManagementAccess: source.allowManagementAccess !== false,
        wireguardListenPorts: arrayOrEmpty(source.wireguardListenPorts),
    };
}

/** @returns a human readable description of an endpoint. */
export function describeEndpoint(endpoint: Endpoint): string {
    if (endpoint.zone && endpoint.host)
        return `${endpoint.zone}:${endpoint.host}`;
    return endpoint.zone || endpoint.host || "any";
}
