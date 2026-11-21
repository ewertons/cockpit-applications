/**
 * Generates the block of /etc/nftables.conf owned by this application.
 *
 * The block only ever defines `table inet cockpit_fw` and starts with the
 * declare-then-delete idiom, so loading it with `nft -f` atomically replaces
 * that table and nothing else. All configuration is native nftables:
 * zones, hosts and services are named sets, rule descriptions are rule
 * comments and disabled rules live in chains no hook reaches. ruleset-parser.ts
 * reads the block back.
 */

import {
    ANY_SERVICE,
    BUILT_IN_SERVICES,
    Endpoint,
    FirewallConfiguration,
    HostEntry,
    INET_TABLE_NAME,
    LEGACY_NAT_TABLE_NAME,
    MANAGEMENT_TCP_PORTS,
    Verdict,
    allServices,
    describeEndpoint,
} from './model.js';
import { AddressFamily, addressRange, parseAddress, validateConfiguration } from './validation.js';

export const BLOCK_BEGIN_MARKER = "# BEGIN cockpit-firewall";
export const BLOCK_END_MARKER = "# END cockpit-firewall";
export const BASELINE_COMMENT = "cockpit-firewall: baseline";
export const MANAGEMENT_COMMENT = "cockpit-firewall: management access";
export const ZONE_POLICY_COMMENT = "cockpit-firewall: zone policy";
/** Suffix of the chains holding disabled rules; nothing jumps to them. */
export const DISABLED_CHAIN_SUFFIX = "_disabled";
/** Set comment marking a host imported from WireGuard: "wireguard <interface> <public key>". */
export const WIREGUARD_HOST_COMMENT_PREFIX = "wireguard ";

export const ZONE_SET_PREFIX = "zone_";
export const SERVICE_SET_PREFIX = "service_";
export const HOST_SET_PREFIXES: Record<AddressFamily, string> = { ipv4: "host4_", ipv6: "host6_" };

export interface GeneratedRuleset {
    /** The managed block, markers included, as written to /etc/nftables.conf. */
    text: string;
    warnings: string[];
}

export class ConfigurationError extends Error {
    readonly problems: string[];

    constructor(problems: string[]) {
        super(problems.join("\n"));
        this.name = "ConfigurationError";
        this.problems = problems;
    }
}

/** A list of alternative match fragments; a rule is emitted for every combination. */
type MatchAlternatives = string[][];

const NO_MATCH: MatchAlternatives = [[]];

const FAMILY_KEYWORDS: Record<AddressFamily, string> = { ipv4: "ip", ipv6: "ip6" };

function combine(...dimensions: MatchAlternatives[]): MatchAlternatives {
    return dimensions.reduce<MatchAlternatives>(
        (accumulated, dimension) => accumulated.flatMap(prefix => dimension.map(fragment => [...prefix, ...fragment])),
        NO_MATCH);
}

/** Quotes a validated value. Validation guarantees no quotes or backslashes. */
function quote(text: string): string {
    return `"${text}"`;
}

/** @returns the host's canonical addresses of one family, sorted numerically and de-duplicated. */
export function hostAddressesOfFamily(host: HostEntry, family: AddressFamily): string[] {
    const unique = new Map<string, bigint>();
    for (const address of host.addresses) {
        const parsed = parseAddress(address);
        const range = addressRange(address);
        if (parsed && range && parsed.family === family)
            unique.set(parsed.text, range.low);
    }
    return [...unique.entries()].sort((first, second) => (first[1] < second[1] ? -1 : first[1] > second[1] ? 1 : 0))
            .map(([text]) => text);
}

function portSortKey(port: string): number {
    return Number(port.split("-")[0]);
}

export interface ChainRule {
    fragments: string[];
    verdict: string;
    comment?: string;
}

export function renderRule(rule: ChainRule): string {
    return [...rule.fragments, rule.verdict, ...rule.comment ? [`comment ${quote(rule.comment)}`] : []].join(" ");
}

/** Accepts replies; first rule of the forward and input chains. */
export const ESTABLISHED: ChainRule = { fragments: ["ct state established,related"], verdict: "accept", comment: BASELINE_COMMENT };

/** Input rules every input chain starts with, after ESTABLISHED. */
export const INPUT_BASELINE_RULES: readonly ChainRule[] = [
    "iifname \"lo\"",
    "icmp type echo-request",
    "meta l4proto ipv6-icmp",
    "udp sport 67 udp dport 68",
    "ip6 saddr fe80::/10 udp sport 547 udp dport 546",
].map(fragment => ({ fragments: [fragment], verdict: "accept", comment: BASELINE_COMMENT }));

/** Keeps SSH and Cockpit reachable unless the user turns it off. */
export const MANAGEMENT_RULE: ChainRule = {
    fragments: [`tcp dport { ${MANAGEMENT_TCP_PORTS.join(", ")} }`], verdict: "accept", comment: MANAGEMENT_COMMENT,
};

class RulesetBuilder {
    readonly problems: string[] = [];
    private readonly configuration: FirewallConfiguration;

    constructor(configuration: FirewallConfiguration) {
        this.configuration = configuration;
    }

    private host(name: string): HostEntry | undefined {
        return this.configuration.hosts.find(candidate => candidate.name === name);
    }

    private zoneMatch(keyword: "iifname" | "oifname", zone: string | undefined): MatchAlternatives {
        return zone === undefined ? NO_MATCH : [[`${keyword} @${ZONE_SET_PREFIX}${zone}`]];
    }

    private addressMatch(sourceHost: string | undefined, destinationHost: string | undefined): MatchAlternatives {
        if (sourceHost === undefined && destinationHost === undefined)
            return NO_MATCH;
        const alternatives: MatchAlternatives = [];
        for (const family of ["ipv4", "ipv6"] as const) {
            const hasFamily = (name: string | undefined) => name === undefined || hostAddressesOfFamily(this.host(name)!, family).length > 0;
            if (!hasFamily(sourceHost) || !hasFamily(destinationHost))
                continue;
            const fragments: string[] = [];
            if (sourceHost !== undefined)
                fragments.push(`${FAMILY_KEYWORDS[family]} saddr @${HOST_SET_PREFIXES[family]}${sourceHost}`);
            if (destinationHost !== undefined)
                fragments.push(`${FAMILY_KEYWORDS[family]} daddr @${HOST_SET_PREFIXES[family]}${destinationHost}`);
            alternatives.push(fragments);
        }
        return alternatives;
    }

    private serviceMatch(service: string): MatchAlternatives {
        return service === ANY_SERVICE ? NO_MATCH : [[`meta l4proto . th dport @${SERVICE_SET_PREFIX}${service}`]];
    }

    /** Adds the chain rules of one configured rule to `enabled` or, tagged with its position, to `disabled`. */
    private emit(target: { enabled: ChainRule[]; disabled: ChainRule[] }, alternatives: MatchAlternatives, verdict: string,
        rule: { enabled: boolean; comment?: string }, position: number, label: string): void {
        if (alternatives.length === 0) {
            this.problems.push(`${label} matches nothing (its hosts have no address family in common); change or remove it`);
            return;
        }
        for (const fragments of alternatives) {
            if (rule.enabled)
                target.enabled.push({ fragments: [...fragments, "counter"], verdict, ...rule.comment ? { comment: rule.comment } : {} });
            else
                target.disabled.push({ fragments, verdict, comment: rule.comment ? `@${position} ${rule.comment}` : `@${position}` });
        }
    }

    forwardRules(): { enabled: ChainRule[]; disabled: ChainRule[] } {
        const result = { enabled: [] as ChainRule[], disabled: [] as ChainRule[] };
        this.configuration.forwardRules.forEach((rule, index) => {
            const alternatives = combine(
                this.zoneMatch("iifname", rule.from.zone),
                this.zoneMatch("oifname", rule.to.zone),
                this.addressMatch(rule.from.host, rule.to.host),
                this.serviceMatch(rule.service));
            this.emit(result, alternatives, rule.action, rule, index,
                      `Forward rule ${index + 1} (${describeEndpoint(rule.from)} -> ${describeEndpoint(rule.to)})`);
        });
        return result;
    }

    inputRules(): { enabled: ChainRule[]; disabled: ChainRule[] } {
        const result = { enabled: [] as ChainRule[], disabled: [] as ChainRule[] };
        this.configuration.inputRules.forEach((rule, index) => {
            const alternatives = combine(
                this.zoneMatch("iifname", rule.from.zone),
                this.addressMatch(rule.from.host, rule.destinationHost),
                this.serviceMatch(rule.service));
            this.emit(result, alternatives, rule.action, rule, index, `Input rule ${index + 1} (${describeEndpoint(rule.from)})`);
        });
        return result;
    }

    natRules(): { enabled: ChainRule[]; disabled: ChainRule[] } {
        const result = { enabled: [] as ChainRule[], disabled: [] as ChainRule[] };
        this.configuration.natRules.forEach((rule, index) => {
            let source: MatchAlternatives = [["meta nfproto ipv4"]];
            if (rule.sourceAddress !== undefined)
                source = this.host(rule.sourceAddress)
                    ? [[`ip saddr @${HOST_SET_PREFIXES.ipv4}${rule.sourceAddress}`]]
                    : [[`ip saddr ${parseAddress(rule.sourceAddress)!.text}`]];
            const alternatives = combine(source, this.zoneMatch("iifname", rule.sourceZone), this.zoneMatch("oifname", rule.egressZone));
            this.emit(result, alternatives, "masquerade", rule, index, `NAT rule ${index + 1}`);
        });
        return result;
    }

    zonePolicyRules(policy: "forwardPolicy" | "inputPolicy"): ChainRule[] {
        return this.configuration.zones.filter(zone => zone[policy] === "drop")
                .map(zone => ({ fragments: [`iifname @${ZONE_SET_PREFIX}${zone.name}`, "counter"], verdict: "drop", comment: ZONE_POLICY_COMMENT }));
    }

    inputBaselineRules(): ChainRule[] {
        return [...INPUT_BASELINE_RULES, ...this.configuration.allowManagementAccess ? [MANAGEMENT_RULE] : []];
    }

    /** @returns the services that need a set: every user service and the built-ins rules use. */
    servicesWithSets(): { name: string; ports: { protocol: string; port: string }[] }[] {
        const referenced = new Set([
            ...this.configuration.forwardRules.map(rule => rule.service),
            ...this.configuration.inputRules.map(rule => rule.service),
        ]);
        const userNames = new Set(this.configuration.services.map(service => service.name));
        return allServices(this.configuration).filter(service => service.name !== ANY_SERVICE &&
            (userNames.has(service.name) || referenced.has(service.name)));
    }
}

function setLines(name: string, type: string, flags: string | null, comment: string | null, elements: string[]): string[] {
    return [
        `\tset ${name} {`,
        `\t\ttype ${type}`,
        ...flags ? [`\t\tflags ${flags}`] : [],
        ...comment ? [`\t\tcomment ${quote(comment)}`] : [],
        ...elements.length > 0 ? [`\t\telements = { ${elements.join(", ")} }`] : [],
        "\t}",
    ];
}

function chainLines(name: string, hookLine: string | null, rules: ChainRule[]): string[] {
    return [
        `\tchain ${name} {`,
        ...hookLine ? [`\t\t${hookLine}`] : [],
        ...rules.map(rule => `\t\t${renderRule(rule)}`),
        "\t}",
    ];
}

/** @returns whether the configuration needs an input chain at all. */
function needsInputChain(configuration: FirewallConfiguration): boolean {
    return !configuration.allowManagementAccess ||
        configuration.inputRules.some(rule => rule.enabled) ||
        configuration.zones.some(zone => zone.inputPolicy === "drop");
}

/**
 * Generates the managed block of /etc/nftables.conf for the configuration.
 * @throws ConfigurationError when the configuration is invalid.
 */
export function generateRuleset(configuration: FirewallConfiguration): GeneratedRuleset {
    const problems = validateConfiguration(configuration);
    if (problems.length > 0)
        throw new ConfigurationError(problems);

    const builder = new RulesetBuilder(configuration);
    const forward = builder.forwardRules();
    const input = builder.inputRules();
    const nat = builder.natRules();
    if (builder.problems.length > 0)
        throw new ConfigurationError(builder.problems);

    const sets: string[] = [];
    for (const zone of configuration.zones)
        sets.push(...setLines(`${ZONE_SET_PREFIX}${zone.name}`, "ifname",
                              zone.interfaces.some(name => name.endsWith("*")) ? "interval" : null, null,
                              [...new Set(zone.interfaces)].sort().map(quote)));
    for (const host of configuration.hosts) {
        const comment = host.origin === "wireguard"
            ? `${WIREGUARD_HOST_COMMENT_PREFIX}${host.wireguardInterface} ${host.wireguardPublicKey}`
            : null;
        for (const family of ["ipv4", "ipv6"] as const) {
            const addresses = hostAddressesOfFamily(host, family);
            if (addresses.length > 0)
                sets.push(...setLines(`${HOST_SET_PREFIXES[family]}${host.name}`, family === "ipv4" ? "ipv4_addr" : "ipv6_addr",
                                      "interval", comment, addresses));
        }
    }
    for (const service of builder.servicesWithSets()) {
        const elements = [...new Set(service.ports.map(port => `${port.protocol} . ${port.port}`))]
                .sort((first, second) => {
                    const [firstProtocol, firstPort] = first.split(" . ");
                    const [secondProtocol, secondPort] = second.split(" . ");
                    return firstProtocol.localeCompare(secondProtocol) || portSortKey(firstPort) - portSortKey(secondPort);
                });
        sets.push(...setLines(`${SERVICE_SET_PREFIX}${service.name}`, "inet_proto . inet_service", "interval", null, elements));
    }

    const chains: string[][] = [];
    const forwardBody = [...forward.enabled, ...builder.zonePolicyRules("forwardPolicy")];
    if (forwardBody.length > 0)
        chains.push(chainLines("forward", "type filter hook forward priority filter; policy accept;", [ESTABLISHED, ...forwardBody]));
    if (needsInputChain(configuration))
        chains.push(chainLines("input", "type filter hook input priority filter; policy accept;",
                               [ESTABLISHED, ...builder.inputBaselineRules(), ...input.enabled, ...builder.zonePolicyRules("inputPolicy")]));
    if (nat.enabled.length > 0)
        chains.push(chainLines("postrouting", "type nat hook postrouting priority srcnat; policy accept;", nat.enabled));
    for (const [name, rules] of [["forward", forward.disabled], ["input", input.disabled], ["postrouting", nat.disabled]] as const)
        if (rules.length > 0)
            chains.push(chainLines(`${name}${DISABLED_CHAIN_SUFFIX}`, null, rules));

    const tableBody = [sets, ...chains].filter(section => section.length > 0)
            .map(section => section.join("\n"));
    const lines = [
        BLOCK_BEGIN_MARKER,
        "# Managed by Cockpit (Firewall rules); read back by it. Zones, hosts and services are named sets.",
        `table inet ${INET_TABLE_NAME}`,
        `delete table inet ${INET_TABLE_NAME}`,
        `table inet ${INET_TABLE_NAME} {`,
        tableBody.join("\n\n"),
        "}",
        BLOCK_END_MARKER,
    ].filter(line => line !== "");

    return { text: lines.join("\n") + "\n", warnings: [] };
}

/**
 * @returns the text loaded live on apply: removes the NAT table of earlier
 * versions and, when asked, the stock accept-all `table inet filter`, then the block.
 */
export function liveApplyText(block: string, removeStockFilterTable: boolean): string {
    return [
        `table ip ${LEGACY_NAT_TABLE_NAME}`,
        `delete table ip ${LEGACY_NAT_TABLE_NAME}`,
        ...removeStockFilterTable ? ["table inet filter", "delete table inet filter"] : [],
        block,
    ].join("\n");
}

/** @returns whether built-in service `name` has exactly these ports. */
export function isUnchangedBuiltInService(name: string, ports: { protocol: string; port: string }[]): boolean {
    const builtIn = BUILT_IN_SERVICES.find(service => service.name === name);
    if (!builtIn || name === ANY_SERVICE)
        return false;
    const key = (list: { protocol: string; port: string }[]) => list.map(port => `${port.protocol}/${port.port}`).sort()
            .join(",");
    return key(builtIn.ports) === key(ports);
}

/** @returns the UI label for a verdict. */
export function describeVerdict(verdict: Verdict): string {
    return verdict === "accept" ? "Allow" : "Deny";
}

export type { Endpoint };
