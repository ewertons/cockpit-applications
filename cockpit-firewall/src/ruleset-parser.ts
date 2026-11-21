/**
 * Reads this app's configuration back from nftables text: the managed table
 * in /etc/nftables.conf or `nft list table inet cockpit_fw` output. The
 * inverse of ruleset.ts; whatever it does not understand is reported, because
 * the next apply rewrites the table without it.
 */

import {
    Endpoint,
    FirewallConfiguration,
    ForwardRule,
    HostEntry,
    INET_TABLE_NAME,
    InputRule,
    NatRule,
    PortSpecification,
    ServiceDefinition,
    Verdict,
    Zone,
    createEmptyConfiguration,
} from './model.js';
import { Statement, Token, blockBody, bodyStatements, topLevelTables, words } from './nft-syntax.js';
import {
    BASELINE_COMMENT,
    DISABLED_CHAIN_SUFFIX,
    HOST_SET_PREFIXES,
    MANAGEMENT_COMMENT,
    SERVICE_SET_PREFIX,
    WIREGUARD_HOST_COMMENT_PREFIX,
    ZONE_POLICY_COMMENT,
    ZONE_SET_PREFIX,
    isUnchangedBuiltInService,
} from './ruleset.js';
import { AddressFamily, isValidInterfaceName, isValidObjectName, isValidPort, isValidPublicKey, parseAddress } from './validation.js';

export interface ParsedRuleset {
    configuration: FirewallConfiguration;
    /** Parts of the table this app does not understand; the next apply drops them. */
    unrecognized: string[];
}

/** Address operand of a rule: a host set or a literal address. */
interface AddressOperand {
    family: AddressFamily;
    host?: string;
    literal?: string;
}

/** Matches and verdict of one nftables rule, in this app's vocabulary. */
interface RuleMatch {
    inputZone?: string;
    outputZone?: string;
    source?: AddressOperand;
    destination?: AddressOperand;
    service?: string;
    ipv4Only?: boolean;
    verdict?: string;
    comment?: string;
}

const PROTOCOL_NUMBERS: Record<string, PortSpecification["protocol"]> = { tcp: "tcp", udp: "udp", 6: "tcp", 17: "udp" };

function stripPrefix(text: string, prefix: string): string | undefined {
    return text.startsWith(prefix) && isValidObjectName(text.slice(prefix.length)) ? text.slice(prefix.length) : undefined;
}

/** @returns the rule's matches, or null when it uses anything this app does not generate. */
function parseRule(tokens: Token[]): RuleMatch | null {
    const match: RuleMatch = {};
    const text = (index: number) => tokens[index]?.text;
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index];
        if (token.kind !== "word" && !(token.kind === "string" && text(index - 1) === "comment"))
            return null;
        if (match.verdict !== undefined && token.text !== "comment")
            return null;
        if (token.text === "iifname" || token.text === "oifname") {
            const zone = stripPrefix(text(index + 1) ?? "", `@${ZONE_SET_PREFIX}`);
            if (!zone || tokens[index + 1].kind !== "word")
                return null;
            if (token.text === "iifname")
                match.inputZone = zone;
            else
                match.outputZone = zone;
            index += 2;
        } else if ((token.text === "ip" || token.text === "ip6") && (text(index + 1) === "saddr" || text(index + 1) === "daddr")) {
            const family: AddressFamily = token.text === "ip" ? "ipv4" : "ipv6";
            const operandText = text(index + 2) ?? "";
            const host = stripPrefix(operandText, `@${HOST_SET_PREFIXES[family]}`);
            const literal = parseAddress(operandText);
            let operand: AddressOperand;
            if (host)
                operand = { family, host };
            else if (!operandText.startsWith("@") && literal?.family === family)
                operand = { family, literal: literal.text };
            else
                return null;
            if (text(index + 1) === "saddr")
                match.source = operand;
            else
                match.destination = operand;
            index += 3;
        } else if (token.text === "meta" && text(index + 1) === "l4proto" && text(index + 2) === "." &&
                   text(index + 3) === "th" && text(index + 4) === "dport") {
            const service = stripPrefix(text(index + 5) ?? "", `@${SERVICE_SET_PREFIX}`);
            if (!service)
                return null;
            match.service = service;
            index += 6;
        } else if (token.text === "meta" && text(index + 1) === "nfproto" && text(index + 2) === "ipv4") {
            match.ipv4Only = true;
            index += 3;
        } else if (token.text === "counter") {
            index++;
            if (text(index) === "packets" && text(index + 2) === "bytes")
                index += 4;
        } else if (token.text === "accept" || token.text === "drop" || token.text === "masquerade") {
            match.verdict = token.text;
            index++;
        } else if (token.text === "comment" && tokens[index + 1]?.kind === "string") {
            match.comment = tokens[index + 1].text;
            index += 2;
        } else {
            return null;
        }
    }
    return match.verdict === undefined ? null : match;
}

/** @returns the comment of a rule statement, whatever its matches. */
function ruleComment(tokens: Token[]): string | undefined {
    const index = tokens.findIndex((token, position) => token.text === "comment" && tokens[position + 1]?.kind === "string");
    return index === -1 ? undefined : tokens[index + 1].text;
}

/** @returns the comma-separated elements of `elements = { ... }`, each as its token texts joined by spaces. */
function setElements(statement: Statement): string[] {
    const body = blockBody(statement) ?? [];
    const elements: string[] = [];
    let current: string[] = [];
    for (const token of body) {
        if (token.kind === "punctuation" && token.text === ",") {
            elements.push(current.join(" "));
            current = [];
        } else if (token.kind !== "newline") {
            current.push(token.text);
        }
    }
    if (current.length > 0)
        elements.push(current.join(" "));
    return elements.filter(Boolean);
}

interface ChainContent {
    rules: { statement: Statement; tokens: Token[] }[];
    hook?: string;
}

class TableReader {
    readonly configuration = createEmptyConfiguration();
    readonly unrecognized: string[] = [];
    private readonly source: string;
    private readonly chains = new Map<string, ChainContent>();
    private readonly hostsByName = new Map<string, HostEntry>();
    private readonly zonesByName = new Map<string, Zone>();

    constructor(source: string) {
        this.source = source;
    }

    private describe(context: string, statement: Statement): string {
        return `${context}: ${this.source.slice(statement.start, statement.end).replace(/\s+/g, " ")}`;
    }

    readTable(body: Token[]): void {
        for (const statement of bodyStatements(this.source, body)) {
            const texts = words(statement);
            if (texts[0] === "set" && texts.length >= 2)
                this.readSet(texts[1], statement);
            else if (texts[0] === "chain" && texts.length >= 2)
                this.readChain(texts[1], statement);
            else if (texts[0] !== "comment" && texts[0] !== "flags")
                this.unrecognized.push(this.describe("table", statement));
        }
    }

    private readSet(name: string, statement: Statement): void {
        let type = "";
        let comment: string | undefined;
        let elements: string[] = [];
        for (const inner of bodyStatements(this.source, blockBody(statement) ?? [])) {
            const texts = words(inner);
            if (texts[0] === "type")
                type = texts.slice(1).join(" ");
            else if (texts[0] === "comment")
                comment = texts[1];
            else if (texts[0] === "elements")
                elements = setElements(inner);
        }
        const zoneName = stripPrefix(name, ZONE_SET_PREFIX);
        const serviceName = stripPrefix(name, SERVICE_SET_PREFIX);
        const hostFamily = (Object.keys(HOST_SET_PREFIXES) as AddressFamily[]).find(family => stripPrefix(name, HOST_SET_PREFIXES[family]));
        if (zoneName && type === "ifname") {
            const interfaces = elements.map(element => element.replace(/^"|"$/g, ""));
            if (interfaces.every(isValidInterfaceName)) {
                const zone: Zone = { name: zoneName, interfaces, forwardPolicy: "accept", inputPolicy: "accept" };
                this.zonesByName.set(zoneName, zone);
                this.configuration.zones.push(zone);
                return;
            }
        } else if (serviceName && type === "inet_proto . inet_service") {
            const ports: PortSpecification[] = [];
            for (const element of elements) {
                const [protocolText, separator, port] = element.split(" ");
                const protocol = PROTOCOL_NUMBERS[protocolText];
                if (separator !== "." || !protocol || !isValidPort(port)) {
                    this.unrecognized.push(this.describe("set", statement));
                    return;
                }
                ports.push({ protocol, port });
            }
            if (ports.length > 0 && !isUnchangedBuiltInService(serviceName, ports))
                this.configuration.services.push({ name: serviceName, ports } satisfies ServiceDefinition);
            return;
        } else if (hostFamily && type === (hostFamily === "ipv4" ? "ipv4_addr" : "ipv6_addr")) {
            const hostName = stripPrefix(name, HOST_SET_PREFIXES[hostFamily])!;
            const addresses = elements.map(element => parseAddress(element));
            if (addresses.every(address => address?.family === hostFamily)) {
                this.addHostAddresses(hostName, addresses.map(address => address!.text), comment);
                return;
            }
        }
        this.unrecognized.push(this.describe("set", statement));
    }

    private addHostAddresses(name: string, addresses: string[], comment: string | undefined): void {
        let host = this.hostsByName.get(name);
        if (!host) {
            host = { name, addresses: [], origin: "manual" };
            const [prefix, interfaceName, publicKey] = (comment ?? "").split(" ");
            if (`${prefix} ` === WIREGUARD_HOST_COMMENT_PREFIX && isValidInterfaceName(interfaceName ?? "") && isValidPublicKey(publicKey ?? ""))
                Object.assign(host, { origin: "wireguard", wireguardInterface: interfaceName, wireguardPublicKey: publicKey });
            this.hostsByName.set(name, host);
            this.configuration.hosts.push(host);
        }
        host.addresses.push(...addresses);
    }

    private readChain(name: string, statement: Statement): void {
        const content: ChainContent = this.chains.get(name) ?? { rules: [] };
        this.chains.set(name, content);
        for (const inner of bodyStatements(this.source, blockBody(statement) ?? [])) {
            const texts = words(inner);
            if (texts[0] === "type") {
                const hookIndex = texts.indexOf("hook");
                content.hook = `${texts[1]} ${texts[hookIndex + 1]}`;
            } else if (texts[0] === "policy") {
                if (texts[1] !== "accept")
                    this.unrecognized.push(this.describe(`chain ${name}`, inner));
            } else if (texts[0] !== "comment" || inner.tokens.length > 2) {
                content.rules.push({ statement: inner, tokens: inner.tokens });
            }
        }
    }

    /** Converts the collected chains into rules. Call after every table body was read. */
    finish(): ParsedRuleset {
        const expectedHooks: Record<string, string | undefined> = {
            forward: "filter forward", input: "filter input", postrouting: "nat postrouting",
        };
        let inputChainSeen = false;
        let managementSeen = false;
        const enabled = { forward: [] as ForwardRule[], input: [] as InputRule[], postrouting: [] as NatRule[] };
        const disabled = { forward: [] as [number, ForwardRule][], input: [] as [number, InputRule][], postrouting: [] as [number, NatRule][] };

        for (const [chainName, content] of this.chains) {
            const baseName = chainName.endsWith(DISABLED_CHAIN_SUFFIX) ? chainName.slice(0, -DISABLED_CHAIN_SUFFIX.length) : chainName;
            const isDisabled = baseName !== chainName;
            if (!(baseName in expectedHooks) || (isDisabled ? content.hook !== undefined : content.hook !== expectedHooks[baseName])) {
                this.unrecognized.push(`chain ${chainName} (${content.rules.length} rules)`);
                continue;
            }
            const kind = baseName as "forward" | "input" | "postrouting";
            if (kind === "input" && !isDisabled)
                inputChainSeen = true;
            let previousKey: string | null = null;
            for (const { statement, tokens } of content.rules) {
                const comment = ruleComment(tokens);
                if (!isDisabled && comment === BASELINE_COMMENT)
                    continue;
                if (!isDisabled && kind === "input" && comment === MANAGEMENT_COMMENT) {
                    managementSeen = true;
                    continue;
                }
                const match = parseRule(tokens);
                const converted = match && this.convertRule(kind, match, isDisabled);
                if (!converted) {
                    this.unrecognized.push(this.describe(`chain ${chainName}`, statement));
                    previousKey = null;
                    continue;
                }
                if (converted === "policy")
                    continue;
                // One configured rule becomes one nftables rule per address family; merge them back.
                const key = JSON.stringify(converted);
                if (key === previousKey)
                    continue;
                previousKey = key;
                if (isDisabled)
                    (disabled[kind] as [number, unknown][]).push([converted.position, converted.rule]);
                else
                    (enabled[kind] as unknown[]).push(converted.rule);
            }
        }

        const merge = <T, >(rules: T[], disabledRules: [number, T][]): T[] => {
            const result = [...rules];
            for (const [position, rule] of [...disabledRules].sort((first, second) => first[0] - second[0]))
                result.splice(Math.min(position, result.length), 0, rule);
            return result;
        };
        this.configuration.forwardRules = merge(enabled.forward, disabled.forward);
        this.configuration.inputRules = merge(enabled.input, disabled.input);
        this.configuration.natRules = merge(enabled.postrouting, disabled.postrouting);
        this.configuration.allowManagementAccess = !inputChainSeen || managementSeen;
        return { configuration: this.configuration, unrecognized: this.unrecognized };
    }

    /** @returns the configured rule for a parsed nftables rule, "policy" for a zone policy rule, or null. */
    private convertRule(kind: "forward" | "input" | "postrouting", match: RuleMatch, isDisabled: boolean):
        { rule: ForwardRule | InputRule | NatRule; position: number } | "policy" | null {
        let comment = match.comment;
        let position = 0;
        if (isDisabled) {
            const tag = /^@(\d{1,5})(?: (.*))?$/.exec(comment ?? "");
            if (!tag)
                return null;
            position = Number(tag[1]);
            comment = tag[2];
        }
        const optionalComment = comment === undefined ? {} : { comment };
        const enabled = !isDisabled;
        const host = (operand: AddressOperand | undefined) => operand?.host;

        if (kind === "postrouting") {
            if (match.verdict !== "masquerade" || !match.outputZone || match.destination || match.service ||
                (match.source && match.source.family !== "ipv4") || (match.ipv4Only && match.source))
                return null;
            const rule: NatRule = { egressZone: match.outputZone, enabled, ...optionalComment };
            if (match.inputZone)
                rule.sourceZone = match.inputZone;
            const sourceAddress = match.source?.host ?? match.source?.literal;
            if (sourceAddress !== undefined)
                rule.sourceAddress = sourceAddress;
            return { rule, position };
        }

        if ((match.verdict !== "accept" && match.verdict !== "drop") || match.ipv4Only ||
            match.source?.literal || match.destination?.literal)
            return null;
        const verdict = match.verdict as Verdict;

        if (!isDisabled && comment === ZONE_POLICY_COMMENT) {
            const zone = this.zonesByName.get(match.inputZone ?? "");
            if (verdict !== "drop" || !zone || match.outputZone || match.source || match.destination || match.service)
                return null;
            zone[kind === "forward" ? "forwardPolicy" : "inputPolicy"] = "drop";
            return "policy";
        }

        const endpoint = (zone: string | undefined, hostName: string | undefined): Endpoint =>
            ({ ...zone ? { zone } : {}, ...hostName ? { host: hostName } : {} });
        const from = endpoint(match.inputZone, host(match.source));
        if (kind === "forward") {
            const to = endpoint(match.outputZone, host(match.destination));
            return { rule: { from, to, service: match.service ?? "any", action: verdict, enabled, ...optionalComment }, position };
        }
        if (match.outputZone)
            return null;
        const rule: InputRule = { from, service: match.service ?? "any", action: verdict, enabled, ...optionalComment };
        if (match.destination?.host)
            rule.destinationHost = match.destination.host;
        return { rule, position };
    }
}

/**
 * Reads the configuration from every `table inet cockpit_fw { ... }` in the text.
 * @returns null when the text defines no such table.
 */
export function parseManagedTable(text: string): ParsedRuleset | null {
    const definitions = topLevelTables(text).filter(table => !table.isDelete && table.family === "inet" &&
        table.name === INET_TABLE_NAME && table.body !== null);
    if (definitions.length === 0)
        return null;
    const reader = new TableReader(text);
    for (const definition of definitions)
        reader.readTable(definition.body!);
    return reader.finish();
}
