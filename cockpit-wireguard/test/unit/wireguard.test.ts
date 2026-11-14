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

    test("hand-written hooks next to managed rules are preserved", () => {
        const managed = serializeConfig(convertLegacyFirewall(parseConfig("wg0", hubConfig(legacyNatRules()))));
        const text = managed.replace("ListenPort = 51820\n", "ListenPort = 51820\nPostUp = echo extra\n");
        const iface = parseConfig("wg0", text);
        assert.equal(iface.firewallManagement, "managed");
        assert.deepEqual(iface.extraInterfaceLines, ["PostUp = echo extra"]);
        assert.ok(serializeConfig(iface).includes("PostUp = echo extra\n"));
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

        assert.deepEqual(tables.filter.FORWARD, ["-i eth0 -j ACCEPT", "-i wg0 -j wg-access-wg0", "-o wg0 -j ACCEPT"]);
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

    test("live update swaps the chain atomically, or replaces the legacy rules", () => {
        const refresh = liveFirewallScript(managed, "managed");
        assert.ok(refresh.includes("if iptables -C FORWARD -i wg0 -j wg-access-wg0 2>/dev/null; then\niptables-restore --noflush <<'EOF'\n*filter\n:wg-access-wg0 - [0:0]\n"));
        assert.ok(refresh.includes("-A wg-access-wg0 -s 10.10.20.3/32 -d 192.168.1.198/32 -p tcp --dport 22 -j ACCEPT\n"));
        assert.ok(!refresh.includes("-D FORWARD -i wg0 -j ACCEPT"));

        const upgrade = liveFirewallScript(managed, "legacy");
        assert.ok(upgrade.includes("{ iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -j ACCEPT;"));
        assert.ok(upgrade.indexOf("-D FORWARD -i wg0 -j ACCEPT") < upgrade.indexOf("iptables -A FORWARD -i wg0 -j wg-access-wg0"));
        assert.ok(!upgrade.includes("%i"));
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
