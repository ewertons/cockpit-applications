/**
 * Read-only import of WireGuard peers as hosts. Parses wg-quick configuration
 * text; never writes WireGuard files.
 */

import { HostEntry } from './model.js';
import { isValidInterfaceName, isValidObjectName, parseAddress } from './validation.js';

export interface WireguardInterfaceSummary {
    interfaceName: string;
    listenPort?: number;
    /** Interface addresses converted to their networks, e.g. 10.99.0.1/24 -> 10.99.0.0/24. */
    networks: string[];
    hosts: HostEntry[];
    /** Peers skipped because they have no PublicKey or no usable AllowedIPs. */
    skippedPeers: string[];
}

/** Turns a free-form peer name into a valid object name, or "" when impossible. */
export function sanitizeHostName(name: string): string {
    const replaced = name.trim().replace(/[^A-Za-z0-9_.-]+/g, "-")
            .replace(/^[^A-Za-z]+/, "")
            .replace(/-+$/, "")
            .slice(0, 63);
    return isValidObjectName(replaced) ? replaced : "";
}

function ipv4Network(address: string): string | null {
    const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(address);
    if (!match)
        return null;
    const prefixLength = Number(match[5]);
    if (prefixLength > 32 || match.slice(1, 5).some(octet => Number(octet) > 255))
        return null;
    const value = match.slice(1, 5).reduce((accumulated, octet) => accumulated * 256 + Number(octet), 0);
    const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
    const network = (value & mask) >>> 0;
    return `${[24, 16, 8, 0].map(shift => (network >>> shift) & 255).join(".")}/${prefixLength}`;
}

/**
 * @returns a name derived from the peer's PublicKey, `<interface>-peer-<key prefix>`,
 * so it stays with the same peer when others are added or removed. A numeric
 * suffix is added only if it is already in usedNames.
 */
function publicKeyFallbackName(interfaceName: string, publicKey: string, usedNames: Set<string>): string {
    const prefix = interfaceName.replace(/[^A-Za-z0-9_.-]/g, "");
    const keyTag = publicKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
    let base = `${prefix}-peer-${keyTag}`;
    if (!isValidObjectName(base))
        base = `peer-${keyTag}`;
    for (let suffix = 1; ; suffix++) {
        const name = suffix === 1 ? base : `${base}-${suffix}`;
        if (!usedNames.has(name))
            return name;
    }
}

/**
 * Parses one wg-quick configuration file into hosts (one per peer).
 * Peer names come from the `# Name = ...` comment inside the peer section or,
 * failing that, a `# <name> (access: ...)` comment on the last non-blank line
 * above `[Peer]`; unnamed peers are named
 * after their PublicKey (`<interface>-peer-<key prefix>`). Peers without a
 * PublicKey are skipped. Only valid AllowedIPs are kept.
 */
export function parseWireguardConfiguration(interfaceName: string, text: string): WireguardInterfaceSummary {
    const summary: WireguardInterfaceSummary = { interfaceName, networks: [], hosts: [], skippedPeers: [] };
    if (!isValidInterfaceName(interfaceName) || interfaceName.endsWith("*"))
        return summary;

    interface PeerDraft { name?: string; headerName?: string; publicKey?: string; allowedAddresses: string[] }
    const peers: PeerDraft[] = [];
    let section: "interface" | "peer" | null = null;
    let previousLine = "";

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        const lineAbove = previousLine;
        // Blank lines are skipped: writers such as cockpit-wireguard put one before [Peer].
        if (line !== "")
            previousLine = line;
        // Like wg-quick, drop inline comments: everything after '#'. "# Name =" is read from the full line.
        const content = line.replace(/#.*$/, "").trim();
        const sectionMatch = /^\[(\w+)\]$/.exec(content);
        if (sectionMatch) {
            const sectionName = sectionMatch[1].toLowerCase();
            section = sectionName === "interface" || sectionName === "peer" ? sectionName : null;
            if (section === "peer") {
                const header = /^#\s*(\S+)\s+\(access:[^)]*\)$/i.exec(lineAbove);
                peers.push({ allowedAddresses: [], ...header ? { headerName: header[1] } : {} });
            }
            continue;
        }
        const currentPeer = section === "peer" ? peers[peers.length - 1] : undefined;
        const nameMatch = /^[#;]\s*Name\s*=\s*(.*)$/i.exec(line);
        if (nameMatch && currentPeer) {
            currentPeer.name = nameMatch[1].trim();
            continue;
        }
        if (line.startsWith("#") || line.startsWith(";"))
            continue;
        const separatorIndex = content.indexOf("=");
        if (separatorIndex === -1)
            continue;
        const key = content.slice(0, separatorIndex).trim()
                .toLowerCase();
        const values = content.slice(separatorIndex + 1).split(",")
                .map(value => value.trim())
                .filter(Boolean);
        if (currentPeer && key === "publickey") {
            currentPeer.publicKey = values[0];
        } else if (currentPeer && key === "allowedips") {
            currentPeer.allowedAddresses.push(...values);
        } else if (section === "interface" && key === "listenport") {
            const port = Number(values[0]);
            if (Number.isInteger(port) && port >= 1 && port <= 65535)
                summary.listenPort = port;
        } else if (section === "interface" && key === "address") {
            for (const value of values) {
                const network = ipv4Network(value);
                if (network)
                    summary.networks.push(network);
            }
        }
    }

    const usedNames = new Set<string>();
    for (const peer of peers) {
        if (!peer.publicKey) {
            summary.skippedPeers.push(peer.name || peer.headerName || "(no PublicKey)");
            continue;
        }
        const label = peer.name || peer.headerName;
        let name = label ? sanitizeHostName(label) : "";
        if (!name || usedNames.has(name))
            name = publicKeyFallbackName(interfaceName, peer.publicKey, usedNames);
        const addresses = [...new Set(peer.allowedAddresses
                .map(address => parseAddress(address)?.text)
                .filter((address): address is string => address !== undefined))];
        // A peer routing everything (any /0, however spelled) is a gateway, not a host to name in rules.
        const usable = addresses.filter(address => !address.endsWith("/0"));
        if (usable.length === 0) {
            summary.skippedPeers.push(peer.name || peer.headerName || name);
            continue;
        }
        usedNames.add(name);
        summary.hosts.push({ name, addresses: usable, origin: "wireguard", wireguardInterface: interfaceName, wireguardPublicKey: peer.publicKey });
    }
    return summary;
}

/**
 * Merges imported hosts into an existing host list. Hosts previously imported
 * from the same interface are replaced; manual hosts with the same name win
 * and are reported as conflicts.
 * @returns also `removed`: earlier imports whose name is gone (rules naming them
 * fail validation until edited), and `reassigned`: names now held by a different
 * peer than before, or by any peer when the earlier import stored no PublicKey.
 */
export function mergeImportedHosts(existing: HostEntry[], summary: WireguardInterfaceSummary): { hosts: HostEntry[]; conflicts: string[]; removed: string[]; reassigned: string[] } {
    const isPreviousImport = (host: HostEntry) => host.origin === "wireguard" && host.wireguardInterface === summary.interfaceName;
    const previousImports = existing.filter(isPreviousImport);
    const removed = previousImports.filter(previous => !summary.hosts.some(imported => imported.name === previous.name)).map(previous => previous.name);
    const reassigned = previousImports.filter(previous => summary.hosts.some(imported => imported.name === previous.name && imported.wireguardPublicKey !== previous.wireguardPublicKey))
            .map(previous => previous.name);
    const kept = existing.filter(host => !isPreviousImport(host));
    const conflicts: string[] = [];
    const hosts = [...kept];
    for (const imported of summary.hosts) {
        if (hosts.some(host => host.name === imported.name)) {
            conflicts.push(imported.name);
            continue;
        }
        hosts.push(imported);
    }
    return { hosts, conflicts, removed, reassigned };
}
