import cockpit from 'cockpit';

const _ = cockpit.gettext;

// --- Types -----------------------------------------------------------------

export interface WgPeer {
    // `# Name = ...` comment convention (ignored by wg-quick, preserved by us)
    name?: string;
    publicKey: string;
    presharedKey?: string;
    allowedIps: string[];
    endpoint?: string;
    persistentKeepalive?: number;
    // Dashboard-managed client metadata, stored as `#` comments (ignored by
    // wg-quick). Lets us re-display a client's config/QR and edit it later.
    // privateKey is only present for clients created through this app.
    privateKey?: string;
    clientAllowedIps?: string; // AllowedIPs to place in the CLIENT's config
    clientEndpoint?: string; // optional per-client Endpoint override (host:port)
    // Any [Peer] lines we do not manage, preserved verbatim on round-trip
    extraLines?: string[];
    // Runtime status (from `wg show <iface> dump`); not persisted
    latestHandshake?: number; // unix seconds, 0 = never
    transferRx?: number;
    transferTx?: number;
}

export interface WgInterface {
    name: string; // interface name == file name without .conf (e.g. "wg0")
    privateKey: string;
    address: string[];
    listenPort?: number;
    dns?: string[];
    mtu?: number;
    // `# PublicEndpoint = host` — the host clients dial (comment convention)
    publicEndpoint?: string;
    // `# ClientDNS = ip` — DNS pushed into generated client configs
    clientDns?: string;
    peers: WgPeer[];
    // Any [Interface] lines we do not manage (PostUp/PostDown/Table/etc.),
    // preserved verbatim so hand-written configs are never clobbered
    extraInterfaceLines?: string[];
    // Runtime / derived; not persisted
    up?: boolean;
    enabled?: boolean; // enabled at boot via wg-quick@ unit
    publicKey?: string; // derived from privateKey
}

const WG_DIR = "/etc/wireguard";

// --- Parsing / serialization ----------------------------------------------

function splitList(val: string): string[] {
    return val.split(",").map(s => s.trim())
            .filter(Boolean);
}

export function parseConfig(name: string, text: string): WgInterface {
    const iface: WgInterface = {
        name,
        privateKey: "",
        address: [],
        peers: [],
        extraInterfaceLines: [],
    };

    let section: "interface" | "peer" | null = null;
    let peer: WgPeer | null = null;

    const flushPeer = () => {
        if (peer) {
            iface.peers.push(peer);
            peer = null;
        }
    };

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "")
            continue;

        const sectionMatch = line.match(/^\[(\w+)\]$/);
        if (sectionMatch) {
            const s = sectionMatch[1].toLowerCase();
            if (s === "interface") {
                flushPeer();
                section = "interface";
            } else if (s === "peer") {
                flushPeer();
                section = "peer";
                peer = { publicKey: "", allowedIps: [], extraLines: [] };
            } else {
                section = null;
            }
            continue;
        }

        // Comments — check for our managed comment conventions first
        if (line.startsWith("#") || line.startsWith(";")) {
            const m = line.match(/^[#;]\s*(Name|PrivateKey|ClientAllowedIPs|ClientEndpoint|PublicEndpoint|ClientDNS)\s*=\s*(.*)$/i);
            if (m) {
                const key = m[1].toLowerCase();
                const val = m[2].trim();
                if (section === "peer" && peer && key === "name") { peer.name = val; continue }
                if (section === "peer" && peer && key === "privatekey") { peer.privateKey = val; continue }
                if (section === "peer" && peer && key === "clientallowedips") { peer.clientAllowedIps = val; continue }
                if (section === "peer" && peer && key === "clientendpoint") { peer.clientEndpoint = val; continue }
                if (section === "interface" && key === "publicendpoint") { iface.publicEndpoint = val; continue }
                if (section === "interface" && key === "clientdns") { iface.clientDns = val; continue }
            }
            // Generic comment — preserve verbatim
            if (section === "peer" && peer)
                peer.extraLines!.push(line);
            else if (section === "interface")
                iface.extraInterfaceLines!.push(line);
            continue;
        }

        // Key = Value (split on first '=' only; WireGuard keys end with '=')
        const eq = line.indexOf("=");
        if (eq === -1) {
            if (section === "peer" && peer)
                peer.extraLines!.push(line);
            else if (section === "interface")
                iface.extraInterfaceLines!.push(line);
            continue;
        }
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        const keyL = key.toLowerCase();

        if (section === "interface") {
            switch (keyL) {
            case "privatekey": iface.privateKey = val; break;
            case "address": iface.address.push(...splitList(val)); break;
            case "listenport": iface.listenPort = parseInt(val, 10) || undefined; break;
            case "dns": iface.dns = [...(iface.dns || []), ...splitList(val)]; break;
            case "mtu": iface.mtu = parseInt(val, 10) || undefined; break;
            default: iface.extraInterfaceLines!.push(`${key} = ${val}`); break;
            }
        } else if (section === "peer" && peer) {
            switch (keyL) {
            case "publickey": peer.publicKey = val; break;
            case "presharedkey": peer.presharedKey = val; break;
            case "allowedips": peer.allowedIps.push(...splitList(val)); break;
            case "endpoint": peer.endpoint = val; break;
            case "persistentkeepalive": peer.persistentKeepalive = parseInt(val, 10) || undefined; break;
            default: peer.extraLines!.push(`${key} = ${val}`); break;
            }
        }
    }
    flushPeer();
    return iface;
}

export function serializeConfig(iface: WgInterface): string {
    const lines: string[] = [];
    lines.push("[Interface]");
    if (iface.publicEndpoint)
        lines.push(`# PublicEndpoint = ${iface.publicEndpoint}`);
    if (iface.clientDns)
        lines.push(`# ClientDNS = ${iface.clientDns}`);
    if (iface.privateKey)
        lines.push(`PrivateKey = ${iface.privateKey}`);
    if (iface.address.length)
        lines.push(`Address = ${iface.address.join(", ")}`);
    if (iface.listenPort)
        lines.push(`ListenPort = ${iface.listenPort}`);
    if (iface.dns && iface.dns.length)
        lines.push(`DNS = ${iface.dns.join(", ")}`);
    if (iface.mtu)
        lines.push(`MTU = ${iface.mtu}`);
    for (const extra of iface.extraInterfaceLines || [])
        lines.push(extra);

    for (const peer of iface.peers) {
        lines.push("");
        lines.push("[Peer]");
        if (peer.name)
            lines.push(`# Name = ${peer.name}`);
        if (peer.privateKey)
            lines.push(`# PrivateKey = ${peer.privateKey}`);
        if (peer.clientAllowedIps)
            lines.push(`# ClientAllowedIPs = ${peer.clientAllowedIps}`);
        if (peer.clientEndpoint)
            lines.push(`# ClientEndpoint = ${peer.clientEndpoint}`);
        if (peer.publicKey)
            lines.push(`PublicKey = ${peer.publicKey}`);
        if (peer.presharedKey)
            lines.push(`PresharedKey = ${peer.presharedKey}`);
        if (peer.allowedIps.length)
            lines.push(`AllowedIPs = ${peer.allowedIps.join(", ")}`);
        if (peer.endpoint)
            lines.push(`Endpoint = ${peer.endpoint}`);
        if (peer.persistentKeepalive != null)
            lines.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
        for (const extra of peer.extraLines || [])
            lines.push(extra);
    }
    return lines.join("\n") + "\n";
}

// --- Key generation (pure compute — no elevated privileges needed) ---------

export async function genPrivateKey(): Promise<string> {
    return (await cockpit.spawn(["wg", "genkey"], { err: "message" })).trim();
}

export async function genPresharedKey(): Promise<string> {
    return (await cockpit.spawn(["wg", "genpsk"], { err: "message" })).trim();
}

export async function pubkeyFromPrivate(privateKey: string): Promise<string> {
    const proc = cockpit.spawn(["wg", "pubkey"], { err: "message" });
    proc.input(privateKey.trim() + "\n");
    return (await proc).trim();
}

export async function genKeypair(): Promise<{ privateKey: string; publicKey: string }> {
    const privateKey = await genPrivateKey();
    const publicKey = await pubkeyFromPrivate(privateKey);
    return { privateKey, publicKey };
}

// --- Filesystem: list / load / save ---------------------------------------

export async function listInterfaceNames(): Promise<string[]> {
    try {
        const out = await cockpit.spawn(
            ["sh", "-c", "ls -1 /etc/wireguard/*.conf 2>/dev/null || true"],
            { superuser: "try", err: "message" }
        );
        return out.split("\n")
                .map(l => l.trim())
                .filter(Boolean)
                .map(p => p.replace(/^.*\//, "").replace(/\.conf$/, ""));
    } catch {
        return [];
    }
}

export async function loadInterface(name: string): Promise<WgInterface | null> {
    const text = await cockpit.file(`${WG_DIR}/${name}.conf`, { superuser: "try" }).read();
    if (text == null)
        return null;
    return parseConfig(name, text);
}

export async function saveInterface(iface: WgInterface): Promise<void> {
    const path = `${WG_DIR}/${iface.name}.conf`;
    await cockpit.spawn(["mkdir", "-p", WG_DIR], { superuser: "try", err: "message" });
    await cockpit.file(path, { superuser: "try" }).replace(serializeConfig(iface));
    await cockpit.spawn(["chmod", "600", path], { superuser: "try", err: "message" });
}

// Load all interfaces and attach live status
export async function loadInterfaces(): Promise<WgInterface[]> {
    const names = await listInterfaceNames();
    const upSet = await getUpInterfaces();
    const result: WgInterface[] = [];
    for (const name of names) {
        const iface = await loadInterface(name);
        if (!iface)
            continue;
        iface.up = upSet.has(name);
        iface.enabled = await isEnabledAtBoot(name);
        if (iface.privateKey) {
            try {
                iface.publicKey = await pubkeyFromPrivate(iface.privateKey);
            } catch { /* invalid key — leave undefined */ }
        }
        if (iface.up)
            await attachRuntime(iface);
        result.push(iface);
    }
    return result;
}

// --- Runtime status --------------------------------------------------------

export async function getUpInterfaces(): Promise<Set<string>> {
    try {
        const out = await cockpit.spawn(["wg", "show", "interfaces"], { superuser: "try", err: "message" });
        return new Set(out.split(/\s+/).map(s => s.trim())
                .filter(Boolean));
    } catch {
        return new Set();
    }
}

export async function isEnabledAtBoot(name: string): Promise<boolean> {
    try {
        const out = await cockpit.spawn(
            ["systemctl", "is-enabled", `wg-quick@${name}`],
            { superuser: "try", err: "message" }
        );
        return out.trim() === "enabled";
    } catch {
        return false;
    }
}

async function attachRuntime(iface: WgInterface): Promise<void> {
    try {
        const out = await cockpit.spawn(["wg", "show", iface.name, "dump"], { superuser: "try", err: "message" });
        const lines = out.split("\n").filter(Boolean);
        // Line 0 is the interface itself; the rest are peers.
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split("\t");
            // cols: publicKey, presharedKey, endpoint, allowedIps,
            //       latestHandshake, rx, tx, persistentKeepalive
            const peer = iface.peers.find(p => p.publicKey === cols[0]);
            if (!peer)
                continue;
            peer.latestHandshake = parseInt(cols[4], 10) || 0;
            peer.transferRx = parseInt(cols[5], 10) || 0;
            peer.transferTx = parseInt(cols[6], 10) || 0;
            if (cols[2] && cols[2] !== "(none)" && !peer.endpoint)
                peer.endpoint = cols[2];
        }
    } catch {
        /* interface is not up — no runtime data */
    }
}

// --- Interface lifecycle ---------------------------------------------------

export async function bringUp(name: string): Promise<void> {
    await cockpit.spawn(["wg-quick", "up", name], { superuser: "try", err: "message" });
}

export async function bringDown(name: string): Promise<void> {
    await cockpit.spawn(["wg-quick", "down", name], { superuser: "try", err: "message" });
}

export async function setEnabledAtBoot(name: string, enabled: boolean): Promise<void> {
    await cockpit.spawn(
        ["systemctl", enabled ? "enable" : "disable", `wg-quick@${name}`],
        { superuser: "try", err: "message" }
    );
}

// Apply on-disk config to a running interface without dropping active peers.
export async function applyLive(name: string): Promise<void> {
    await cockpit.spawn(
        ["bash", "-c", `wg syncconf ${name} <(wg-quick strip ${name})`],
        { superuser: "try", err: "message" }
    );
}

export async function deleteInterface(name: string): Promise<void> {
    try { await bringDown(name) } catch { /* may already be down */ }
    try { await setEnabledAtBoot(name, false) } catch { /* may not be enabled */ }
    await cockpit.spawn(["rm", "-f", `${WG_DIR}/${name}.conf`], { superuser: "try", err: "message" });
}

export async function eraseAllConfig(): Promise<void> {
    const names = await listInterfaceNames();
    for (const name of names) {
        try { await bringDown(name) } catch { /* */ }
        try { await setEnabledAtBoot(name, false) } catch { /* */ }
    }
    await cockpit.spawn(["sh", "-c", "rm -f /etc/wireguard/*.conf"], { superuser: "try", err: "message" });
}

// --- Firewall (best-effort, firewalld only) --------------------------------

export async function firewalldActive(): Promise<boolean> {
    try {
        const out = await cockpit.spawn(["systemctl", "is-active", "firewalld"], { superuser: "try", err: "message" });
        return out.trim() === "active";
    } catch {
        return false;
    }
}

export async function openFirewallPort(port: number): Promise<void> {
    await cockpit.spawn(["firewall-cmd", "--permanent", `--add-port=${port}/udp`], { superuser: "try", err: "message" });
    await cockpit.spawn(["firewall-cmd", "--reload"], { superuser: "try", err: "message" });
}

// --- Client routes ---------------------------------------------------------

const FULL_TUNNEL_ALLOWED_IPS = "0.0.0.0/0, ::/0";

/** True if the client's own config routes everything through the tunnel. */
export function isFullTunnelPeer(peer: WgPeer): boolean {
    return !!peer.clientAllowedIps && splitList(peer.clientAllowedIps).includes("0.0.0.0/0");
}

/** True if another peer (not exceptPublicKey) already uses this client address. */
export function isClientAddressInUse(iface: WgInterface, address: string, exceptPublicKey?: string): boolean {
    const source = normalizeIpv4Cidr(address.trim());
    return source !== null && iface.peers.some(peer => peer.publicKey !== exceptPublicKey &&
        peer.allowedIps.some(allowedIp => normalizeIpv4Cidr(allowedIp) === source));
}

/**
 * Parse one extra route: an IPv4 address or network CIDR. IPv6 is rejected
 * because clients are only given an IPv4 tunnel address.
 * @returns the route as a CIDR, or an error message.
 */
export function parseExtraRoute(text: string): { route?: string; error?: string } {
    const trimmed = text.trim();
    if (trimmed.includes(":"))
        return { error: cockpit.format(_("\"$0\": only IPv4 routes are supported"), trimmed) };
    const match = trimmed.match(/^([0-9.]+)(?:\/(\d{1,2}))?$/);
    const address = match ? ipToInt(match[1]) : NaN;
    const prefix = match?.[2] === undefined ? 32 : parseInt(match[2], 10);
    if (!match || isNaN(address) || prefix > 32)
        return { error: cockpit.format(_("\"$0\" is not a valid IPv4 address or CIDR"), trimmed) };
    if (prefix === 0)
        return { error: _("Use full tunnel instead of a /0 route") };
    const network = (address & prefixMask(prefix)) >>> 0;
    if (network !== address)
        return { error: cockpit.format(_("\"$0\" has host bits set; did you mean $1/$2?"), trimmed, intToIp(network), prefix) };
    return { route: `${intToIp(network)}/${prefix}` };
}

/**
 * Parse user input (one route per line, or comma-separated) into
 * de-duplicated CIDRs plus one message per invalid entry.
 */
export function parseExtraRouteList(text: string): { routes: string[]; errors: string[] } {
    const routes: string[] = [];
    const errors: string[] = [];
    const items = text.split(/[\n,]/).map(item => item.trim())
            .filter(Boolean);
    for (const item of items) {
        const parsed = parseExtraRoute(item);
        if (!parsed.route)
            errors.push(parsed.error!);
        else if (!routes.includes(parsed.route))
            routes.push(parsed.route);
    }
    return { routes, errors };
}

/**
 * AllowedIPs for the client's own config: everything for full tunnel, else the
 * VPN subnet plus each extra route.
 */
export function clientAllowedIpsFor(iface: WgInterface, fullTunnel: boolean, extraRoutes: string[]): string {
    if (fullTunnel)
        return FULL_TUNNEL_ALLOWED_IPS;
    const routes = [serverSubnetCidr(iface)];
    for (const route of extraRoutes) {
        if (!routes.includes(route))
            routes.push(route);
    }
    return routes.join(", ");
}

/** Routes a split-tunnel client has besides the VPN subnet (from `# ClientAllowedIPs`). */
export function extraRoutesOf(iface: WgInterface, peer: WgPeer): string[] {
    if (!peer.clientAllowedIps || isFullTunnelPeer(peer))
        return [];
    const vpnSubnet = serverSubnetCidr(iface);
    return splitList(peer.clientAllowedIps).filter(route => route !== vpnSubnet);
}

// --- IP helpers ------------------------------------------------------------

function ipToInt(ip: string): number {
    const parts = ip.split(".");
    if (parts.length !== 4)
        return NaN;
    let n = 0;
    for (const part of parts) {
        const o = /^\d{1,3}$/.test(part) ? parseInt(part, 10) : NaN;
        if (isNaN(o) || o < 0 || o > 255)
            return NaN;
        n = (n << 8) + o;
    }
    return n >>> 0;
}

function prefixMask(prefix: number): number {
    return prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
}

// "a.b.c.d[/n]" to "a.b.c.d/n", or null if not IPv4.
function normalizeIpv4Cidr(text: string): string | null {
    const match = text.trim().match(/^([0-9.]+)(?:\/(\d{1,2}))?$/);
    if (!match || isNaN(ipToInt(match[1])))
        return null;
    const prefix = match[2] === undefined ? 32 : parseInt(match[2], 10);
    if (prefix > 32)
        return null;
    // Host bits are cleared, as WireGuard and iptables do.
    return `${intToIp((ipToInt(match[1]) & prefixMask(prefix)) >>> 0)}/${prefix}`;
}

function intToIp(n: number): string {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

// Find the next free IPv4 host address within the interface's subnet.
export function nextClientIp(iface: WgInterface): string | null {
    const addr = iface.address.find(a => a.includes("."));
    if (!addr)
        return null;
    const [ip, prefixStr] = addr.split("/");
    const prefix = parseInt(prefixStr || "32", 10);
    const ipInt = ipToInt(ip);
    if (isNaN(ipInt))
        return null;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const network = (ipInt & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;

    const used = new Set<number>();
    used.add(ipInt);
    for (const p of iface.peers) {
        for (const a of p.allowedIps) {
            const host = a.split("/")[0];
            const n = ipToInt(host);
            if (!isNaN(n))
                used.add(n);
        }
    }

    for (let candidate = network + 1; candidate < broadcast; candidate++) {
        if (!used.has(candidate))
            return intToIp(candidate);
    }
    return null;
}

// Network CIDR of the interface's IPv4 subnet, e.g. "10.8.0.0/24".
export function serverSubnetCidr(iface: WgInterface): string {
    const addr = iface.address.find(a => a.includes(".")) || "10.8.0.1/24";
    const [ip, prefixStr] = addr.split("/");
    const prefix = parseInt(prefixStr || "24", 10);
    const n = ipToInt(ip);
    if (isNaN(n))
        return addr;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const net = (n & mask) >>> 0;
    return `${intToIp(net)}/${prefix}`;
}

// True if an endpoint string already includes a ":port" suffix.
export function endpointHasPort(ep: string): boolean {
    return /\]:\d+$/.test(ep) || /^[^:]+:\d+$/.test(ep);
}

// Host part of "host", "host:port", "[v6]" or "[v6]:port".
export function endpointHost(endpoint: string): string {
    const text = endpoint.trim();
    const bracketed = text.match(/^\[([^\]]*)\](?::\d+)?$/);
    if (bracketed)
        return bracketed[1];
    if (/^[^:]+:\d+$/.test(text))
        return text.slice(0, text.lastIndexOf(":"));
    return text;
}

/** True for names and addresses that only reach the local machine. */
export function isLoopbackHost(host: string): boolean {
    const name = host.trim().toLowerCase()
            .replace(/^\[|\]$/g, "")
            .replace(/\.$/, "");
    if (name === "localhost" || name.endsWith(".localhost") || name === "localhost.localdomain" ||
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name))
        return true;
    const groups = expandIpv6(name);
    if (!groups)
        return false;
    const leadingZeros = groups.slice(0, 5).every(group => group === 0);
    // ::1, or an IPv4-mapped address in 127.0.0.0/8 (::ffff:7f00:1 or ::ffff:127.0.0.1).
    return (leadingZeros && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) ||
        (leadingZeros && groups[5] === 0xffff && (groups[6] >> 8) === 127);
}

/** The eight 16-bit groups of an IPv6 address (dotted IPv4 tail allowed), or null. */
function expandIpv6(text: string): number[] | null {
    let address = text;
    const dottedTail = address.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dottedTail) {
        const ipv4 = ipToInt(dottedTail[2]);
        if (isNaN(ipv4))
            return null;
        address = dottedTail[1] + ((ipv4 >>> 16).toString(16)) + ":" + ((ipv4 & 0xffff).toString(16));
    }
    const halves = address.split("::");
    if (halves.length > 2)
        return null;
    const parseGroups = (part: string) => (part === "" ? [] : part.split(":"));
    const head = parseGroups(halves[0]);
    const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
    if (![...head, ...tail].every(group => /^[0-9a-f]{1,4}$/.test(group)))
        return null;
    const missing = 8 - head.length - tail.length;
    if (halves.length === 2 ? missing < 1 : missing !== 0)
        return null;
    return [...head, ...Array(missing).fill("0"), ...tail].map(group => parseInt(group, 16));
}

/** Host the browser used to reach Cockpit, or "" if it is a loopback name. */
export function browserEndpointHost(): string {
    const host = window.location.hostname;
    return isLoopbackHost(host) ? "" : host;
}

/**
 * Build the "host:port" a client should dial from the first non-empty,
 * non-loopback candidate (`base`, then `fallbackHost`). A missing port falls
 * back to the listen port, so DDNS names and routers that forward another
 * external port work.
 * @returns null when no usable host is known.
 */
export function resolveClientEndpoint(base: string | undefined, fallbackHost: string, listenPort: number | undefined): string | null {
    for (const candidate of [base, fallbackHost]) {
        const host = candidate?.trim();
        if (!host || isLoopbackHost(endpointHost(host)))
            continue;
        return endpointHasPort(host) ? host : `${host}:${listenPort ?? 51820}`;
    }
    return null;
}

// --- Client config generation ----------------------------------------------

export interface ClientConfigParams {
    clientPrivateKey: string;
    clientAddress: string; // e.g. "10.8.0.2/32"
    serverPublicKey: string;
    presharedKey?: string;
    endpoint: string; // "host:port"
    dns?: string;
    allowedIps: string; // see clientAllowedIpsFor
    persistentKeepalive?: number;
}

export function buildClientConfig(p: ClientConfigParams): string {
    const lines: string[] = [];
    lines.push("[Interface]");
    lines.push(`PrivateKey = ${p.clientPrivateKey}`);
    lines.push(`Address = ${p.clientAddress}`);
    if (p.dns)
        lines.push(`DNS = ${p.dns}`);
    lines.push("");
    lines.push("[Peer]");
    lines.push(`PublicKey = ${p.serverPublicKey}`);
    if (p.presharedKey)
        lines.push(`PresharedKey = ${p.presharedKey}`);
    lines.push(`AllowedIPs = ${p.allowedIps}`);
    lines.push(`Endpoint = ${p.endpoint}`);
    lines.push(`PersistentKeepalive = ${p.persistentKeepalive ?? 25}`);
    return lines.join("\n") + "\n";
}

// --- Formatting helpers ----------------------------------------------------

export function formatBytes(bytes: number): string {
    if (!bytes)
        return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function handshakeAgo(unixSeconds: number): string {
    if (!unixSeconds)
        return _("Never");
    const secs = Math.floor(Date.now() / 1000) - unixSeconds;
    if (secs < 5)
        return _("Just now");
    if (secs < 60)
        return cockpit.format(_("$0s ago"), secs);
    if (secs < 3600)
        return cockpit.format(_("$0m ago"), Math.floor(secs / 60));
    if (secs < 86400)
        return cockpit.format(_("$0h ago"), Math.floor(secs / 3600));
    return cockpit.format(_("$0d ago"), Math.floor(secs / 86400));
}

// Absolute local timestamp for a handshake, for use in a tooltip.
export function handshakeAbsolute(unixSeconds: number): string {
    if (!unixSeconds)
        return "";
    return new Date(unixSeconds * 1000).toLocaleString();
}

// Whether a peer is considered "connected" (handshake within ~3 minutes).
export function isPeerActive(peer: WgPeer): boolean {
    if (!peer.latestHandshake)
        return false;
    return (Math.floor(Date.now() / 1000) - peer.latestHandshake) < 180;
}

export function isValidInterfaceName(name: string): boolean {
    return /^[a-zA-Z0-9_=+.-]{1,15}$/.test(name);
}
