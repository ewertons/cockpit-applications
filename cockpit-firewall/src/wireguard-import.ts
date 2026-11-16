/**
 * Read-only import of WireGuard peers as hosts. Parses wg-quick configuration
 * text; never writes WireGuard files.
 */

import { HostEntry } from './model.js';
import { isValidInterfaceName, isValidObjectName, parseAddress } from './validation.js';

export interface WireguardInterfaceSummary {
    interfaceName: string;
    listenPort?: number;
    /** Interface addresses converted to their networks, e.g. 10.10.20.1/24 -> 10.10.20.0/24. */
    networks: string[];
    hosts: HostEntry[];
    /** Peers skipped because they have no usable AllowedIPs. */
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

/** @returns the first `<interface>-peer-<n>` (or `peer-<n>`) name, n >= start, not in usedNames. */
function unusedFallbackName(interfaceName: string, start: number, usedNames: Set<string>): string {
    const prefix = interfaceName.replace(/[^A-Za-z0-9_.-]/g, "");
    for (let number = start; ; number++) {
        let name = `${prefix}-peer-${number}`;
        if (!isValidObjectName(name))
            name = `peer-${number}`;
        if (!usedNames.has(name))
            return name;
    }
}

/**
 * Parses one wg-quick configuration file into hosts (one per peer).
 * Peer names come from the `# Name = ...` comment; unnamed peers are named
 * `<interface>-peer-<n>`. Only valid AllowedIPs are kept.
 */
export function parseWireguardConfiguration(interfaceName: string, text: string): WireguardInterfaceSummary {
    const summary: WireguardInterfaceSummary = { interfaceName, networks: [], hosts: [], skippedPeers: [] };
    if (!isValidInterfaceName(interfaceName) || interfaceName.endsWith("*"))
        return summary;

    interface PeerDraft { name?: string; allowedAddresses: string[] }
    const peers: PeerDraft[] = [];
    let section: "interface" | "peer" | null = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        const sectionMatch = /^\[(\w+)\]$/.exec(line);
        if (sectionMatch) {
            const sectionName = sectionMatch[1].toLowerCase();
            section = sectionName === "interface" || sectionName === "peer" ? sectionName : null;
            if (section === "peer")
                peers.push({ allowedAddresses: [] });
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
        const separatorIndex = line.indexOf("=");
        if (separatorIndex === -1)
            continue;
        const key = line.slice(0, separatorIndex).trim()
                .toLowerCase();
        const values = line.slice(separatorIndex + 1).split(",")
                .map(value => value.trim())
                .filter(Boolean);
        if (currentPeer && key === "allowedips") {
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
    peers.forEach((peer, index) => {
        let name = peer.name ? sanitizeHostName(peer.name) : "";
        if (!name || usedNames.has(name))
            name = unusedFallbackName(interfaceName, index + 1, usedNames);
        const addresses = [...new Set(peer.allowedAddresses
                .map(address => parseAddress(address)?.text)
                .filter((address): address is string => address !== undefined))];
        // A peer routing everything (any /0, however spelled) is a gateway, not a host to name in rules.
        const usable = addresses.filter(address => !address.endsWith("/0"));
        if (usable.length === 0) {
            summary.skippedPeers.push(peer.name || name);
            return;
        }
        usedNames.add(name);
        summary.hosts.push({ name, addresses: usable, origin: "wireguard", wireguardInterface: interfaceName });
    });
    return summary;
}

/**
 * Merges imported hosts into an existing host list. Hosts previously imported
 * from the same interface are replaced; manual hosts with the same name win
 * and are reported as conflicts.
 */
export function mergeImportedHosts(existing: HostEntry[], summary: WireguardInterfaceSummary): { hosts: HostEntry[]; conflicts: string[] } {
    const kept = existing.filter(host => !(host.origin === "wireguard" && host.wireguardInterface === summary.interfaceName));
    const conflicts: string[] = [];
    const hosts = [...kept];
    for (const imported of summary.hosts) {
        if (hosts.some(host => host.name === imported.name)) {
            conflicts.push(imported.name);
            continue;
        }
        hosts.push(imported);
    }
    return { hosts, conflicts };
}
