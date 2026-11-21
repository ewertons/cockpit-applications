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
    /** Peer PublicKey, for hosts imported from WireGuard. */
    wireguardPublicKey?: string;
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
    /** Free text, stored as the nftables rule comment. */
    comment?: string;
}

export interface InputRule {
    from: Endpoint;
    /** Host whose addresses are local addresses of this machine (e.g. the VPN hub address). */
    destinationHost?: string;
    service: string;
    action: Verdict;
    enabled: boolean;
    comment?: string;
}

/** IPv4 masquerade of traffic from a source zone and/or address leaving through an egress zone. */
export interface NatRule {
    sourceZone?: string;
    /** Host name or literal IPv4 address/CIDR. */
    sourceAddress?: string;
    egressZone: string;
    enabled: boolean;
    comment?: string;
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
}

/** The only table this app writes. Filter and NAT chains both live in it. */
export const INET_TABLE_NAME = "cockpit_fw";
/** NAT table of earlier versions; deleted on apply. */
export const LEGACY_NAT_TABLE_NAME = "cockpit_fw_nat";

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
    };
}

/** @returns built-in services followed by user services; a user service replaces a built-in one of the same name. */
export function allServices(configuration: FirewallConfiguration): ServiceDefinition[] {
    const userNames = new Set(configuration.services.map(service => service.name));
    return [...BUILT_IN_SERVICES.filter(service => service.name === ANY_SERVICE || !userNames.has(service.name)), ...configuration.services];
}

/** @returns whether IPv4 forwarding is needed (any enabled forward or NAT rule). */
export function requiresForwarding(configuration: FirewallConfiguration): boolean {
    return configuration.forwardRules.some(rule => rule.enabled) ||
        configuration.natRules.some(rule => rule.enabled);
}

/**
 * Makes the input rule accepting a WireGuard interface's listen port match `port`.
 * Port 51820 uses the built-in "wireguard" service. Other ports use a service the
 * import owns: the one an earlier import's rule (comment "WireGuard <label>") uses
 * when no other rule references it, else "wireguard-<label>" or the first free
 * "wireguard-<label>-<n>". A user service is never changed; it is only reused when it
 * already accepts exactly udp/`port`. The imported rule is switched to that service;
 * otherwise a rule accepting it from anywhere is appended unless a rule already uses it.
 * An owned service left unused is removed.
 * @returns the updated configuration.
 */
export function addWireguardListenRule(configuration: FirewallConfiguration, port: number, label: string): FirewallConfiguration {
    const builtIn = BUILT_IN_SERVICES.find(service => service.name === "wireguard")!;
    const labelServiceName = `wireguard-${label}`;
    const comment = `WireGuard ${label}`;
    const isLabelService = (name: string) => name === labelServiceName || name.startsWith(`${labelServiceName}-`);
    const isImportedRule = (rule: InputRule) => rule.comment === comment && (rule.service === builtIn.name || isLabelService(rule.service));
    const ownedServiceName = configuration.inputRules.filter(isImportedRule).map(rule => rule.service)
            .find(name => isLabelService(name) &&
                configuration.forwardRules.every(rule => rule.service !== name) &&
                configuration.inputRules.every(rule => rule.service !== name || isImportedRule(rule)));
    const accepts = (service: ServiceDefinition) => service.ports.length === 1 && service.ports[0].protocol === "udp" && service.ports[0].port === String(port);

    let services = configuration.services;
    const builtInOverride = services.find(service => service.name === builtIn.name);
    let serviceName: string;
    if (String(port) === builtIn.ports[0].port && (!builtInOverride || accepts(builtInOverride))) {
        serviceName = builtIn.name;
    } else if (ownedServiceName !== undefined) {
        serviceName = ownedServiceName;
        services = services.map(service => service.name === ownedServiceName ? { name: service.name, ports: [{ protocol: "udp", port: String(port) }] } : service);
    } else {
        const usable = (name: string) => {
            const existing = allServices(configuration).find(service => service.name === name);
            return existing === undefined || accepts(existing);
        };
        let suffix = 1;
        serviceName = labelServiceName;
        while (!usable(serviceName))
            serviceName = `${labelServiceName}-${++suffix}`;
        if (!services.some(service => service.name === serviceName))
            services = [...services, { name: serviceName, ports: [{ protocol: "udp", port: String(port) }] }];
    }

    let inputRules = configuration.inputRules;
    if (inputRules.some(isImportedRule))
        inputRules = inputRules.map(rule => isImportedRule(rule) ? { ...rule, service: serviceName } : rule);
    else if (!inputRules.some(rule => rule.service === serviceName))
        inputRules = [...inputRules, { from: {}, service: serviceName, action: "accept", enabled: true, comment }];

    if (ownedServiceName !== undefined && ownedServiceName !== serviceName)
        services = services.filter(service => service.name !== ownedServiceName);
    return { ...configuration, services, inputRules };
}

/**
 * Converts the JSON configuration of earlier versions (/etc/cockpit-firewall/config.json)
 * into a configuration. Values are not validated here; see validateConfiguration.
 * Its WireGuard listen ports, accepted before any input rule there, become input
 * rules placed first. Imported hosts without a stored public key become manual hosts.
 */
export function convertLegacyConfiguration(value: unknown): FirewallConfiguration {
    const empty = createEmptyConfiguration();
    if (typeof value !== "object" || value === null)
        return empty;
    const source = value as Partial<FirewallConfiguration> & { wireguardListenPorts?: unknown };
    const arrayOrEmpty = <T, >(candidate: T[] | undefined): T[] => Array.isArray(candidate) ? candidate : [];
    const hosts = arrayOrEmpty(source.hosts).map(host =>
        host && typeof host === "object" && host.origin === "wireguard" && !host.wireguardPublicKey
            ? { name: host.name, addresses: host.addresses, origin: "manual" as const }
            : host);
    let listenPortRules: FirewallConfiguration = { ...empty, services: arrayOrEmpty(source.services) };
    for (const port of arrayOrEmpty(source.wireguardListenPorts as number[] | undefined))
        if (Number.isInteger(port) && port >= 1 && port <= 65535)
            listenPortRules = addWireguardListenRule(listenPortRules, port, String(port));
    return {
        version: 1,
        zones: arrayOrEmpty(source.zones),
        hosts,
        services: listenPortRules.services,
        forwardRules: arrayOrEmpty(source.forwardRules),
        natRules: arrayOrEmpty(source.natRules),
        inputRules: [...listenPortRules.inputRules, ...arrayOrEmpty(source.inputRules)],
        allowManagementAccess: source.allowManagementAccess !== false,
    };
}

/** @returns a human readable description of an endpoint. */
export function describeEndpoint(endpoint: Endpoint): string {
    if (endpoint.zone && endpoint.host)
        return `${endpoint.zone}:${endpoint.host}`;
    return endpoint.zone || endpoint.host || "any";
}
