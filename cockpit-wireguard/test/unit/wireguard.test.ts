import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    WgInterface,
    accessChainRuleSpecs,
    clientAllowedIpsFor,
    convertLegacyFirewall,
    isLoopbackHost,
    legacyNatRules,
    liveFirewallScript,
    managedFirewallLines,
    parseConfig,
    parseLanAccessEntry,
    parseLanAccessList,
    resolveClientEndpoint,
    serializeConfig,
} from "../../src/wireguard.ts";

const EGRESS = "$(ip -4 route list default | awk '{print $5; exit}')";

function hubConfig(firewallLines: string[], secondPeerComments: string[] = []): string {
    return [
        "[Interface]",
        "# PublicEndpoint = 50.125.86.239:51821",
        "PrivateKey = SERVERPRIVATE=",
        "Address = 10.10.20.1/24",
        "ListenPort = 51820",
        ...firewallLines,
        "",
        "[Peer]",
        "# Name = phone",
        "# ClientAllowedIPs = 0.0.0.0/0, ::/0",
        "PublicKey = PHONE=",
        "AllowedIPs = 10.10.20.2/32",
        "",
        "[Peer]",
        "# Name = laptop",
        ...secondPeerComments,
        "PublicKey = LAPTOP=",
        "AllowedIPs = 10.10.20.3/32",
        "",
    ].join("\n");
}

function withLaptopAccess(iface: WgInterface, lanAccess: string[]): WgInterface {
    return {
        ...iface,
        peers: iface.peers.map(peer => (peer.name === "laptop"
            ? { ...peer, clientAllowedIps: clientAllowedIpsFor(iface, false, lanAccess), lanAccess }
            : peer)),
    };
}

// Tiny model of iptables state: enough to check that PostDown undoes PostUp.
type Tables = Record<string, Record<string, string[]>>;

function runIptables(tables: Tables, argumentsText: string): boolean {
    const words = argumentsText.trim().split(/\s+/);
    let table = "filter";
    if (words[0] === "-t") {
        table = words[1];
        words.splice(0, 2);
    }
    const [operation, chain, ...rest] = words;
    const chains = tables[table] ??= {};
    const rule = rest.join(" ");
    switch (operation) {
    case "-N":
        if (chains[chain])
            return false;
        chains[chain] = [];
        return true;
    case "-F":
        if (!chains[chain])
            return false;
        chains[chain] = [];
        return true;
    case "-X":
        if (!chains[chain] || chains[chain].length ||
            Object.values(chains).some(rules => rules.some(r => r.endsWith(`-j ${chain}`))))
            return false;
        delete chains[chain];
        return true;
    case "-A":
        if (!chains[chain])
            return false;
        chains[chain].push(rule);
        return true;
    case "-I": {
        if (!chains[chain])
            return false;
        const [position, ...insertedRule] = rest;
        chains[chain].splice(Number(position) - 1, 0, insertedRule.join(" "));
        return true;
    }
    case "-C":
        return chains[chain]?.includes(rule) ?? false;
    case "-D": {
        const index = chains[chain]?.indexOf(rule) ?? -1;
        if (index === -1)
            return false;
        chains[chain].splice(index, 1);
        return true;
    }
    default:
        throw new Error(`unexpected iptables operation: ${argumentsText}`);
    }
}

// Runs one hook the way wg-quick does (bash with errexit), for the subset of
// shell used by the generated hooks: "a; b", "a || b" and "2>/dev/null".
function runHook(tables: Tables, hook: string, interfaceName: string): void {
    const commandLine = hook.replace(/^Post(Up|Down) = /, "").replace(/%i/g, interfaceName)
            .replace(new RegExp(EGRESS.replace(/[$()|'{}]/g, "\\$&"), "g"), "eth0");
    for (const sequence of commandLine.split("; ")) {
        let succeeded = false;
        for (const alternative of sequence.split(" || ")) {
            const command = alternative.replace(" 2>/dev/null", "").trim();
            if (command === "true" || command.startsWith("sysctl "))
                succeeded = true;
            else if (command.startsWith("iptables "))
                succeeded = runIptables(tables, command.slice("iptables ".length));
            else
                throw new Error(`unexpected command: ${command}`);
            if (succeeded)
                break;
        }
        if (!succeeded)
            throw new Error(`hook failed: ${sequence}`);
    }
}

// Runs liveFirewallScript output for the shell subset it uses.
function runLiveScript(tables: Tables, script: string, interfaceName: string): void {
    const lines = script.trimEnd().split("\n");
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].replace(/"\$egress"/g, "eth0");
        if (line === "set -e" || line.startsWith("sysctl ") || line.startsWith("egress="))
            continue;
        if (line === "iptables-restore --noflush <<'EOF'") {
            const end = lines.indexOf("EOF", index);
            const body = lines.slice(index + 1, end);
            assert.equal(body[0], "*filter");
            assert.equal(body[body.length - 1], "COMMIT");
            for (const restoreLine of body.slice(1, -1)) {
                if (restoreLine.startsWith(":"))
                    tables.filter[restoreLine.slice(1).split(" ")[0]] = [];
                else if (!runIptables(tables, restoreLine))
                    throw new Error(`restore failed: ${restoreLine}`);
            }
            index = end;
            continue;
        }
        const loop = line.match(/^while iptables (.*) 2>\/dev\/null; do :; done$/);
        if (loop) {
            while (runIptables(tables, loop[1]));
            continue;
        }
        runHook(tables, line, interfaceName);
    }
}

function ipv4ToNumber(address: string): number {
    return address.split(".").reduce((total, octet) => total * 256 + Number(octet), 0);
}

function cidrContains(cidr: string, address: string): boolean {
    const [network, prefix] = cidr.split("/");
    const size = 2 ** (32 - Number(prefix));
    return Math.floor(ipv4ToNumber(address) / size) === Math.floor(ipv4ToNumber(network) / size);
}

// Verdict of the first matching rule for a new (not yet established) packet.
function chainVerdict(rules: string[], packet: { source: string; destination: string; protocol: string; port: number }): string {
    for (const rule of rules) {
        const words = rule.split(" ");
        const option = (name: string) => { const at = words.indexOf(name); return at === -1 ? undefined : words[at + 1] };
        if (option("--ctstate"))
            continue;
        const source = option("-s");
        const destination = option("-d");
        const protocol = option("-p");
        const port = option("--dport");
        if ((source && !cidrContains(source, packet.source)) ||
            (destination && !cidrContains(destination, packet.destination)) ||
            (protocol && protocol !== packet.protocol) ||
            (port && Number(port) !== packet.port))
            continue;
        return option("-j")!;
    }
    return "none";
}

describe("config round-trip", () => {
    test("keeps hand-written lines and LAN access comments unchanged", () => {
        const text = [
            "[Interface]",
            "PrivateKey = SERVERPRIVATE=",
            "Address = 10.10.20.1/24",
            "ListenPort = 51820",
            "# a hand-written note",
            "PostUp = nft -f /etc/host-setup/wg0.nft",
            "PostDown = nft delete table inet wg0",
            "",
            "[Peer]",
            "# Name = laptop",
            "# ClientAllowedIPs = 10.10.20.0/24, 192.168.1.198/32",
            "# ClientLanAccess = 192.168.1.198:22/tcp, 192.168.2.0/24",
            "PublicKey = LAPTOP=",
            "AllowedIPs = 10.10.20.3/32",
            "# keep me",
            "",
            "[Peer]",
            "# Name = tablet",
            "# ClientLanAccess = none",
            "PublicKey = TABLET=",
            "AllowedIPs = 10.10.20.4/32",
            "",
        ].join("\n");
        const iface = parseConfig("wg0", text);
        assert.equal(iface.firewallManagement, "unmanaged");
        assert.deepEqual(iface.peers[0].lanAccess, ["192.168.1.198:22/tcp", "192.168.2.0/24"]);
        assert.deepEqual(iface.peers[1].lanAccess, []);
        assert.equal(serializeConfig(iface), text);
    });

    test("a peer without the comment has no recorded LAN access", () => {
        const iface = parseConfig("wg0", hubConfig(legacyNatRules()));
        assert.equal(iface.peers[1].lanAccess, undefined);
        assert.ok(!serializeConfig(iface).includes("ClientLanAccess"));
    });

    test("tunnels with the original rules are detected and kept as-is until converted", () => {
        const text = hubConfig(legacyNatRules());
        const iface = parseConfig("wg0", text);
        assert.equal(iface.firewallManagement, "legacy");
        assert.equal(serializeConfig(iface), text);
    });

    test("legacy rules mixed with other hooks are not managed", () => {
        const iface = parseConfig("wg0", hubConfig([...legacyNatRules(), "PostUp = echo up"]));
        assert.equal(iface.firewallManagement, "unmanaged");
        assert.equal(convertLegacyFirewall(iface), iface);
    });

    test("managed rules are regenerated from peers and parse back as managed", () => {
        const converted = withLaptopAccess(convertLegacyFirewall(parseConfig("wg0", hubConfig(legacyNatRules()))),
                                           ["192.168.1.198:22/tcp"]);
        const text = serializeConfig(converted);
        for (const line of legacyNatRules().slice(1))
            assert.ok(!text.includes(line));

        const reparsed = parseConfig("wg0", text);
        assert.equal(reparsed.firewallManagement, "managed");
        assert.deepEqual(reparsed.extraInterfaceLines, []);
        assert.equal(serializeConfig(reparsed), text);

        const withoutAccess = serializeConfig(withLaptopAccess(reparsed, []));
        assert.ok(!withoutAccess.includes("192.168.1.198"));
        assert.ok(withoutAccess.includes("# ClientLanAccess = none"));
    });

    test("edited or added hooks make the tunnel unmanaged and are kept verbatim", () => {
        const managed = serializeConfig(withLaptopAccess(
            convertLegacyFirewall(parseConfig("wg0", hubConfig(legacyNatRules()))), ["192.168.1.198:22/tcp"]));
        const edited = managed.replace("--dport 22 -j ACCEPT", "--dport 22 -j DROP");
        const added = managed.replace("ListenPort = 51820\n", "ListenPort = 51820\nPostUp = echo extra\n");
        for (const text of [edited, added]) {
            assert.notEqual(text, managed);
            const iface = parseConfig("wg0", text);
            assert.equal(iface.firewallManagement, "unmanaged");
            assert.equal(serializeConfig(iface), text);
        }
    });
});

describe("client AllowedIPs", () => {
    const iface = parseConfig("wg0", hubConfig([]));

    test("split tunnel adds each LAN destination to the VPN subnet", () => {
        assert.equal(clientAllowedIpsFor(iface, false, ["192.168.1.198:22/tcp"]), "10.10.20.0/24, 192.168.1.198/32");
        assert.equal(clientAllowedIpsFor(iface, false, ["192.168.1.198:22/tcp", "192.168.1.198:80", "192.168.2.0/24"]),
                     "10.10.20.0/24, 192.168.1.198/32, 192.168.2.0/24");
        assert.equal(clientAllowedIpsFor(iface, false, []), "10.10.20.0/24");
    });

    test("full tunnel stays unchanged", () => {
        assert.equal(clientAllowedIpsFor(iface, true, ["192.168.1.198:22/tcp"]), "0.0.0.0/0, ::/0");
    });
});

describe("hub firewall rules", () => {
    const managed = withLaptopAccess(convertLegacyFirewall(parseConfig("wg0", hubConfig(legacyNatRules()))),
                                     ["192.168.1.198:22/tcp", "192.168.1.10:53", "192.168.5.0/24"]);

    test("restrict split-tunnel clients and keep others unrestricted", () => {
        assert.deepEqual(accessChainRuleSpecs(managed), [
            ["-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"],
            ["-s 10.10.20.2/32 -j ACCEPT"],
            [
                "-s 10.10.20.3/32 -d 10.10.20.0/24 -j ACCEPT",
                "-s 10.10.20.3/32 -d 192.168.1.198/32 -p tcp --dport 22 -j ACCEPT",
                "-s 10.10.20.3/32 -d 192.168.1.10/32 -p tcp --dport 53 -j ACCEPT",
                "-s 10.10.20.3/32 -d 192.168.1.10/32 -p udp --dport 53 -j ACCEPT",
                "-s 10.10.20.3/32 -d 192.168.5.0/24 -j ACCEPT",
                "-s 10.10.20.3/32 -j DROP",
            ],
            ["-j DROP"],
        ]);
    });

    test("clients with no recorded LAN access keep unrestricted forwarding", () => {
        const legacyConverted = convertLegacyFirewall(parseConfig("wg0", hubConfig(legacyNatRules())));
        assert.deepEqual(accessChainRuleSpecs(legacyConverted)[2], ["-s 10.10.20.3/32 -j ACCEPT"]);
    });

    test("PostDown removes exactly what PostUp adds", () => {
        const initial: Tables = { filter: { FORWARD: ["-i eth0 -j ACCEPT"] }, nat: { POSTROUTING: [] } };
        const tables: Tables = structuredClone(initial);
        const lines = managedFirewallLines(managed);
        for (const line of lines.filter(line => line.startsWith("PostUp = ")))
            runHook(tables, line, "wg0");

        assert.deepEqual(tables.filter.FORWARD, ["-i wg0 -j wg-access-wg0", "-i eth0 -j ACCEPT", "-o wg0 -j ACCEPT"]);
        assert.deepEqual(tables.nat.POSTROUTING, ["-o eth0 -j MASQUERADE"]);
        assert.deepEqual(tables.filter["wg-access-wg0"], accessChainRuleSpecs(managed).flat());

        for (const line of lines.filter(line => line.startsWith("PostDown = ")))
            runHook(tables, line, "wg0");
        assert.deepEqual(tables, initial);
    });

    test("PostUp replaces a stale chain left behind", () => {
        const tables: Tables = { filter: { FORWARD: [], "wg-access-wg0": ["-j ACCEPT"] }, nat: { POSTROUTING: [] } };
        for (const line of managedFirewallLines(managed).filter(line => line.startsWith("PostUp = ")))
            runHook(tables, line, "wg0");
        assert.deepEqual(tables.filter["wg-access-wg0"], accessChainRuleSpecs(managed).flat());
    });

    test("each tunnel's access chain runs before any tunnel's egress ACCEPT", () => {
        const tables: Tables = { filter: { FORWARD: [] }, nat: { POSTROUTING: [] } };
        for (const interfaceName of ["wg0", "wg1"])
            for (const line of managedFirewallLines(managed).filter(line => line.startsWith("PostUp = ")))
                runHook(tables, line, interfaceName);
        const forward = tables.filter.FORWARD;
        const lastJump = Math.max(forward.indexOf("-i wg0 -j wg-access-wg0"), forward.indexOf("-i wg1 -j wg-access-wg1"));
        const firstEgress = Math.min(forward.indexOf("-o wg0 -j ACCEPT"), forward.indexOf("-o wg1 -j ACCEPT"));
        assert.ok(lastJump >= 0 && lastJump < firstEgress, forward.join(" | "));
    });

    test("overlapping peers are governed by their most specific source", () => {
        const text = hubConfig([], ["# ClientAllowedIPs = 10.10.20.0/24", "# ClientLanAccess = none"])
                .replace("AllowedIPs = 10.10.20.2/32", "AllowedIPs = 10.10.20.0/28");
        const rules = accessChainRuleSpecs(parseConfig("wg0", text)).flat();
        const lanPacket = { destination: "192.168.1.50", protocol: "tcp", port: 80 };
        assert.equal(chainVerdict(rules, { ...lanPacket, source: "10.10.20.3" }), "DROP");
        assert.equal(chainVerdict(rules, { ...lanPacket, source: "10.10.20.5" }), "ACCEPT");
        assert.equal(chainVerdict(rules, { ...lanPacket, source: "10.10.20.3", destination: "10.10.20.9" }), "ACCEPT");
    });

    test("live update reconciles any installed state and is idempotent", () => {
        const script = liveFirewallScript(managed);
        assert.ok(!script.includes("%i"));
        const expectedChain = accessChainRuleSpecs(managed).flat();
        const legacyRunning = (): Tables => {
            const tables: Tables = { filter: { FORWARD: ["-i eth0 -j ACCEPT"] }, nat: { POSTROUTING: [] } };
            for (const line of legacyNatRules().filter(line => line.startsWith("PostUp = ")))
                runHook(tables, line, "wg0");
            return tables;
        };
        const managedRunning = (): Tables => {
            const tables: Tables = { filter: { FORWARD: ["-i eth0 -j ACCEPT"], "wg-access-wg0": ["-j ACCEPT"] }, nat: { POSTROUTING: [] } };
            for (const line of managedFirewallLines(managed).filter(line => line.startsWith("PostUp = ")))
                runHook(tables, line, "wg0");
            tables.filter["wg-access-wg0"] = ["-j ACCEPT"];
            return tables;
        };
        for (const tables of [legacyRunning(), managedRunning()]) {
            runLiveScript(tables, script, "wg0");
            runLiveScript(tables, script, "wg0");
            assert.deepEqual(tables.filter.FORWARD, ["-i wg0 -j wg-access-wg0", "-i eth0 -j ACCEPT", "-o wg0 -j ACCEPT"]);
            assert.deepEqual(tables.filter["wg-access-wg0"], expectedChain);
            assert.deepEqual(tables.nat.POSTROUTING, ["-o eth0 -j MASQUERADE"]);
            for (const line of managedFirewallLines(managed).filter(line => line.startsWith("PostDown = ")))
                runHook(tables, line, "wg0");
            assert.deepEqual(tables, { filter: { FORWARD: ["-i eth0 -j ACCEPT"] }, nat: { POSTROUTING: [] } });
        }
    });
});

describe("LAN access entries", () => {
    test("accepts addresses and networks with optional port and protocol", () => {
        assert.deepEqual(parseLanAccessEntry("192.168.1.198:22/tcp").entry,
                         { destination: "192.168.1.198/32", port: 22, protocol: "tcp" });
        assert.deepEqual(parseLanAccessEntry(" 192.168.1.0/24 ").entry,
                         { destination: "192.168.1.0/24", port: undefined, protocol: undefined });
        assert.deepEqual(parseLanAccessEntry("192.168.1.0/24:53/UDP").entry,
                         { destination: "192.168.1.0/24", port: 53, protocol: "udp" });
    });

    test("rejects malformed entries", () => {
        for (const text of ["192.168.1.256", "192.168.1", "192.168.1.1/33", "192.168.1.1:0", "192.168.1.1:65536",
            "192.168.1.1/tcp", "192.168.1.1:22/icmp", "host.example:22", "0.0.0.0/0", "192.168.1.5/24", "1.2.3.4; reboot"])
            assert.ok(parseLanAccessEntry(text).error, text);
        assert.match(parseLanAccessEntry("192.168.1.5/24").error!, /192\.168\.1\.0\/24/);
    });

    test("lists are canonicalized, de-duplicated and report each error", () => {
        assert.deepEqual(parseLanAccessList("192.168.1.198/32:22/TCP\n192.168.1.198:22/tcp, 10.1.0.0/16\n\nbad"), {
            entries: ["192.168.1.198:22/tcp", "10.1.0.0/16"],
            errors: ["\"bad\" is not in the form address[/prefix][:port[/tcp|udp]]"],
        });
    });
});

describe("client endpoint", () => {
    test("loopback names are recognized", () => {
        for (const host of ["localhost", "LOCALHOST.", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"])
            assert.ok(isLoopbackHost(host), host);
        for (const host of ["50.125.86.239", "vpn.example.com", "localhost.example.com", "128.0.0.1", "::"])
            assert.ok(!isLoopbackHost(host), host);
    });

    test("loopback fallbacks are never used", () => {
        assert.equal(resolveClientEndpoint(undefined, "localhost", 51820), null);
        assert.equal(resolveClientEndpoint("", "127.0.0.1", 51820), null);
        assert.equal(resolveClientEndpoint("localhost:51820", "", 51820), null);
        assert.equal(resolveClientEndpoint("localhost", "vpn.example.com", 51820), "vpn.example.com:51820");
    });

    test("host:port overrides are kept and bare hosts get the listen port", () => {
        assert.equal(resolveClientEndpoint("50.125.86.239:51821", "localhost", 51820), "50.125.86.239:51821");
        assert.equal(resolveClientEndpoint("vpn.example.com", "", 51820), "vpn.example.com:51820");
        assert.equal(resolveClientEndpoint("[2001:db8::1]:51821", "", 51820), "[2001:db8::1]:51821");
    });
});
