import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FirewallConfiguration, createEmptyConfiguration } from "../../src/model.ts";
import { ConfigurationError, generateRuleset, liveApplyText } from "../../src/ruleset.ts";
import { parseManagedTable } from "../../src/ruleset-parser.ts";
import { parseWireguardConfiguration } from "../../src/wireguard-import.ts";

const WG0_CONFIGURATION = `[Interface]
Address = 10.99.0.1/24
ListenPort = 51820
PrivateKey = cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5MDA=

[Peer]
# Name = vpn-laptop
PublicKey = cHVibGlja2V5cHVibGlja2V5cHVibGlja2V5cHViMDE=
AllowedIPs = 10.99.0.3/32
`;

/** Acceptance scenario: VPN client vpn-laptop may reach only lan-server on tcp/22. */
function scenarioConfiguration(): FirewallConfiguration {
    const imported = parseWireguardConfiguration("wg0", WG0_CONFIGURATION);
    return {
        ...createEmptyConfiguration(),
        zones: [
            { name: "vpn", interfaces: ["wg0"], forwardPolicy: "drop", inputPolicy: "accept" },
            { name: "lan", interfaces: ["eth0"], forwardPolicy: "accept", inputPolicy: "accept" },
        ],
        hosts: [
            ...imported.hosts,
            { name: "lan-server", addresses: ["192.168.1.30"], origin: "manual" },
        ],
        forwardRules: [
            { from: { zone: "vpn", host: "vpn-laptop" }, to: { host: "lan-server" }, service: "ssh", action: "accept", enabled: true },
        ],
        natRules: [
            { sourceAddress: "10.99.0.0/24", egressZone: "lan", enabled: true },
        ],
    };
}

describe("acceptance scenario", () => {
    test("generates the expected block", () => {
        const { text, warnings } = generateRuleset(scenarioConfiguration());
        assert.deepEqual(warnings, []);
        assert.equal(text, [
            "# BEGIN cockpit-firewall",
            "# Managed by Cockpit (Firewall rules); read back by it. Zones, hosts and services are named sets.",
            "table inet cockpit_fw",
            "delete table inet cockpit_fw",
            "table inet cockpit_fw {",
            "\tset zone_vpn {",
            "\t\ttype ifname",
            "\t\telements = { \"wg0\" }",
            "\t}",
            "\tset zone_lan {",
            "\t\ttype ifname",
            "\t\telements = { \"eth0\" }",
            "\t}",
            "\tset host4_vpn-laptop {",
            "\t\ttype ipv4_addr",
            "\t\tflags interval",
            "\t\tcomment \"wireguard wg0 cHVibGlja2V5cHVibGlja2V5cHVibGlja2V5cHViMDE=\"",
            "\t\telements = { 10.99.0.3 }",
            "\t}",
            "\tset host4_lan-server {",
            "\t\ttype ipv4_addr",
            "\t\tflags interval",
            "\t\telements = { 192.168.1.30 }",
            "\t}",
            "\tset service_ssh {",
            "\t\ttype inet_proto . inet_service",
            "\t\tflags interval",
            "\t\telements = { tcp . 22 }",
            "\t}",
            "",
            "\tchain forward {",
            "\t\ttype filter hook forward priority filter; policy accept;",
            "\t\tct state established,related accept comment \"cockpit-firewall: baseline\"",
            "\t\tiifname @zone_vpn ip saddr @host4_vpn-laptop ip daddr @host4_lan-server meta l4proto . th dport @service_ssh counter accept",
            "\t\tiifname @zone_vpn counter drop comment \"cockpit-firewall: zone policy\"",
            "\t}",
            "",
            "\tchain postrouting {",
            "\t\ttype nat hook postrouting priority srcnat; policy accept;",
            "\t\tip saddr 10.99.0.0/24 oifname @zone_lan counter masquerade",
            "\t}",
            "}",
            "# END cockpit-firewall",
            "",
        ].join("\n"));
    });

    test("is read back unchanged", () => {
        const parsed = parseManagedTable(generateRuleset(scenarioConfiguration()).text);
        assert.ok(parsed);
        assert.deepEqual(parsed.unrecognized, []);
        assert.deepEqual(parsed.configuration, scenarioConfiguration());
    });
});

describe("only own tables", () => {
    const configurations: [string, FirewallConfiguration][] = [
        ["empty", createEmptyConfiguration()],
        ["scenario", scenarioConfiguration()],
        ["with input rules", { ...scenarioConfiguration(), inputRules: [{ from: { zone: "lan" }, service: "https", action: "accept", enabled: true }] }],
    ];
    for (const [label, configuration] of configurations)
        test(label, () => {
            for (const removeStockFilterTable of [false, true]) {
                const text = liveApplyText(generateRuleset(configuration).text, removeStockFilterTable);
                const tableReferences = [...text.matchAll(/^\s*(?:delete |flush |destroy )?table (\S+) (\S+)/gm)].map(match => `${match[1]} ${match[2]}`);
                const allowed = ["inet cockpit_fw", "ip cockpit_fw_nat", ...removeStockFilterTable ? ["inet filter"] : []];
                for (const reference of tableReferences)
                    assert.ok(allowed.includes(reference), reference);
                assert.equal(tableReferences.includes("inet filter"), removeStockFilterTable);
                assert.doesNotMatch(text, /flush ruleset|^\s*flush table|include/m);
                assert.match(text, /^table inet cockpit_fw\ndelete table inet cockpit_fw\ntable inet cockpit_fw \{$/m);
                assert.match(text, /^table ip cockpit_fw_nat\ndelete table ip cockpit_fw_nat$/m);
            }
        });

    test("empty configuration leaves an empty table", () => {
        assert.match(generateRuleset(createEmptyConfiguration()).text, /table inet cockpit_fw \{\n\}/);
    });
});

/** Every feature at once, to check that parsing a generated block gives the configuration back. */
function richConfiguration(): FirewallConfiguration {
    const configuration = scenarioConfiguration();
    configuration.zones.push({ name: "tunnels", interfaces: ["tun*", "wg1"], forwardPolicy: "accept", inputPolicy: "drop" });
    configuration.zones[1].inputPolicy = "drop";
    configuration.hosts.push(
        { name: "dual", addresses: ["192.168.1.10", "192.168.2.0/24", "fd00::10"], origin: "manual" },
        { name: "hub", addresses: ["10.99.0.1"], origin: "manual" },
    );
    configuration.services.push({ name: "web-dev", ports: [{ protocol: "tcp", port: "8000-8100" }, { protocol: "udp", port: "8443" }] },
                                { name: "ssh", ports: [{ protocol: "tcp", port: "2222" }] });
    configuration.forwardRules = [
        { from: { zone: "lan" }, to: { zone: "vpn", host: "dual" }, service: "dns", action: "accept", enabled: true, comment: "dns both families" },
        { from: { zone: "vpn" }, to: {}, service: "https", action: "accept", enabled: false, comment: "later" },
        ...configuration.forwardRules,
        { from: {}, to: { host: "dual" }, service: "web-dev", action: "drop", enabled: false },
    ];
    configuration.inputRules = [
        { from: { zone: "vpn" }, destinationHost: "hub", service: "dns", action: "accept", enabled: true },
        { from: { zone: "lan" }, service: "ssh", action: "accept", enabled: true, comment: "ssh on 2222" },
        { from: {}, service: "wireguard", action: "accept", enabled: true, comment: "WireGuard wg0" },
        { from: { host: "dual" }, service: "any", action: "drop", enabled: false },
    ];
    configuration.natRules.push({ sourceZone: "tunnels", egressZone: "lan", enabled: true },
                                { sourceAddress: "hub", egressZone: "lan", enabled: false, comment: "off" });
    configuration.allowManagementAccess = false;
    return configuration;
}

describe("reading the table back", () => {
    const cases: [string, FirewallConfiguration][] = [
        ["empty", createEmptyConfiguration()],
        ["scenario", scenarioConfiguration()],
        ["management off, no rules", { ...createEmptyConfiguration(), allowManagementAccess: false }],
        ["every feature", richConfiguration()],
    ];
    for (const [label, configuration] of cases)
        test(`${label}: from the file`, () => {
            const parsed = parseManagedTable(generateRuleset(configuration).text);
            assert.ok(parsed);
            assert.deepEqual(parsed.unrecognized, []);
            assert.deepEqual(parsed.configuration, configuration);
        });

    test("from `nft list table` output (counters, multi-line elements, no markers)", () => {
        const listed = `table inet cockpit_fw {
	set zone_vpn {
		type ifname
		elements = { "wg0" }
	}
	set zone_lan {
		type ifname
		elements = { "eth0" }
	}
	set host4_vpn-laptop {
		type ipv4_addr
		flags interval
		comment "wireguard wg0 cHVibGlja2V5cHVibGlja2V5cHVibGlja2V5cHViMDE="
		elements = { 10.99.0.3 }
	}
	set host4_lan-server {
		type ipv4_addr
		flags interval
		elements = { 192.168.1.30,
			     192.168.1.31 }
	}
	set service_ssh {
		type inet_proto . inet_service
		flags interval
		elements = { tcp . 22 }
	}

	chain forward {
		type filter hook forward priority filter; policy accept;
		ct state established,related accept comment "cockpit-firewall: baseline"
		iifname @zone_vpn ip saddr @host4_vpn-laptop ip daddr @host4_lan-server meta l4proto . th dport @service_ssh counter packets 12 bytes 720 accept
		iifname @zone_vpn counter packets 3 bytes 180 drop comment "cockpit-firewall: zone policy"
	}

	chain postrouting {
		type nat hook postrouting priority srcnat; policy accept;
		ip saddr 10.99.0.0/24 oifname @zone_lan counter packets 5 bytes 300 masquerade
	}
}
`;
        const parsed = parseManagedTable(listed);
        assert.ok(parsed);
        assert.deepEqual(parsed.unrecognized, []);
        const expected = scenarioConfiguration();
        expected.hosts[1].addresses = ["192.168.1.30", "192.168.1.31"];
        assert.deepEqual(parsed.configuration, expected);
    });

    test("reports what it does not understand", () => {
        const text = generateRuleset(scenarioConfiguration()).text
                .replace("\tchain forward {", "\tchain extra {\n\t\tip saddr 1.2.3.4 drop\n\t}\n\tchain forward {")
                .replace("counter drop comment", "tcp dport 25 counter drop comment")
                .replace("\t\tiifname @zone_vpn ip saddr", "\t\tip saddr 10.0.0.1 log accept\n\t\tiifname @zone_vpn ip saddr");
        const parsed = parseManagedTable(text);
        assert.ok(parsed);
        assert.equal(parsed.unrecognized.length, 3, parsed.unrecognized.join("\n"));
        assert.equal(parsed.configuration.forwardRules.length, 1);
        assert.equal(parsed.configuration.zones[0].forwardPolicy, "accept");
    });

    test("only an IPv4/IPv6 pair is merged; repeated rules stay separate", () => {
        const configuration = scenarioConfiguration();
        configuration.hosts.push({ name: "dual", addresses: ["192.168.1.10", "fd00::10"], origin: "manual" });
        const dualRule = { from: { zone: "lan" }, to: { host: "dual" }, service: "dns", action: "accept" as const, enabled: true };
        configuration.forwardRules = [{ ...configuration.forwardRules[0] }, { ...configuration.forwardRules[0] }, { ...dualRule }, { ...dualRule },
            { ...configuration.forwardRules[0], enabled: false }];
        const parsed = parseManagedTable(generateRuleset(configuration).text);
        assert.deepEqual(parsed?.configuration.forwardRules, configuration.forwardRules);
    });

    test("an unchanged built-in service set is not a user service", () => {
        assert.deepEqual(parseManagedTable(generateRuleset(scenarioConfiguration()).text)?.configuration.services, []);
    });

    test("no table, no configuration", () => {
        assert.equal(parseManagedTable("table inet filter {\n}\n"), null);
    });
});

describe("rule generation", () => {
    test("input chain: baseline, management access, user rules, then zone policies", () => {
        const configuration = scenarioConfiguration();
        configuration.zones[1].inputPolicy = "drop";
        configuration.inputRules = [{ from: { zone: "lan" }, service: "ssh", action: "drop", enabled: true }];
        const { text } = generateRuleset(configuration);
        const input = text.slice(text.indexOf("chain input"));
        const order = [
            'iifname "lo" accept',
            "icmp type echo-request accept",
            'tcp dport { 22, 9090 } accept comment "cockpit-firewall: management access"',
            "iifname @zone_lan meta l4proto . th dport @service_ssh counter drop",
            'iifname @zone_lan counter drop comment "cockpit-firewall: zone policy"',
        ].map(fragment => input.indexOf(fragment));
        assert.ok(order.every(index => index >= 0), String(order));
        assert.deepEqual([...order].sort((first, second) => first - second), order);
    });

    test("management access off is kept as an input chain without the SSH/Cockpit accept", () => {
        const configuration = { ...createEmptyConfiguration(), allowManagementAccess: false };
        const { text } = generateRuleset(configuration);
        assert.match(text, /chain input/);
        assert.doesNotMatch(text, /9090/);
    });

    test("no input chain unless needed", () => {
        assert.doesNotMatch(generateRuleset(scenarioConfiguration()).text, /chain input/);
    });

    test("dual-stack hosts get one rule per family", () => {
        const configuration = scenarioConfiguration();
        configuration.hosts.push({ name: "dual", addresses: ["192.168.1.10", "fd00::10"], origin: "manual" });
        configuration.forwardRules = [{ from: { zone: "lan" }, to: { host: "dual" }, service: "dns", action: "accept", enabled: true }];
        const { text } = generateRuleset(configuration);
        assert.match(text, /iifname @zone_lan ip daddr @host4_dual meta l4proto \. th dport @service_dns counter accept/);
        assert.match(text, /iifname @zone_lan ip6 daddr @host6_dual meta l4proto \. th dport @service_dns counter accept/);
        assert.match(text, /elements = \{ tcp \. 53, udp \. 53 \}/);
    });

    test("hosts without a common address family are an error", () => {
        const configuration = scenarioConfiguration();
        configuration.hosts.push({ name: "only6", addresses: ["fd00::1"], origin: "manual" });
        configuration.forwardRules.push({ from: { host: "vpn-laptop" }, to: { host: "only6" }, service: "any", action: "accept", enabled: true });
        assert.throws(() => generateRuleset(configuration), ConfigurationError);
    });

    test("disabled rules go to unhooked chains, tagged with their position", () => {
        const configuration = scenarioConfiguration();
        configuration.forwardRules[0].enabled = false;
        configuration.forwardRules[0].comment = "paused";
        const { text } = generateRuleset(configuration);
        assert.match(text, /\tchain forward_disabled \{\n\t\tiifname @zone_vpn [^\n]* accept comment "@0 paused"\n\t\}/);
        assert.doesNotMatch(text.slice(text.indexOf("chain forward {"), text.indexOf("chain forward_disabled")), /service_ssh/);
    });

    test("zones with wildcards get an interval set", () => {
        const configuration = scenarioConfiguration();
        configuration.zones[0].interfaces = ["wg0", "tun*"];
        assert.match(generateRuleset(configuration).text, /set zone_vpn \{\n\t\ttype ifname\n\t\tflags interval\n\t\telements = \{ "tun\*", "wg0" \}/);
    });
});

describe("rejects unsafe input", () => {
    const injections = [
        'wg0" accept; flush ruleset; #',
        "wg0\nflush ruleset",
        "eth0 }",
        "$(reboot)",
        "a/b",
        "verylonginterface0",
        "",
    ];
    for (const interfaceName of injections)
        test(`interface ${JSON.stringify(interfaceName)}`, () => {
            const configuration = scenarioConfiguration();
            configuration.zones[0].interfaces = [interfaceName];
            assert.throws(() => generateRuleset(configuration), ConfigurationError);
        });

    for (const address of ["10.99.0.3; flush ruleset", "10.99.0.3/24", "300.1.1.1", "10.0.0.1/33", "fd00::1::2", "1.2.3.4 }", "fe80::1%eth0"])
        test(`address ${JSON.stringify(address)}`, () => {
            const configuration = scenarioConfiguration();
            configuration.hosts[1].addresses = [address];
            assert.throws(() => generateRuleset(configuration), ConfigurationError);
        });

    for (const name of ['lan-server"', "lan server", "1host", "host;drop", "a".repeat(64)])
        test(`host name ${JSON.stringify(name)}`, () => {
            const configuration = scenarioConfiguration();
            configuration.hosts[1].name = name;
            configuration.forwardRules[0].to = { host: name };
            assert.throws(() => generateRuleset(configuration), ConfigurationError);
        });

    for (const port of ["0", "65536", "22;", "22 accept", "100-10", "22-22", "01"])
        test(`service port ${JSON.stringify(port)}`, () => {
            const configuration = scenarioConfiguration();
            configuration.services = [{ name: "custom", ports: [{ protocol: "tcp", port }] }];
            assert.throws(() => generateRuleset(configuration), ConfigurationError);
        });

    for (const comment of ['x" accept; flush ruleset; #', "line\nbreak", "back\\slash", "@3", "cockpit-firewall: baseline", " padded", "é", "a".repeat(101)])
        test(`rule comment ${JSON.stringify(comment)}`, () => {
            const configuration = scenarioConfiguration();
            configuration.forwardRules[0].comment = comment;
            assert.throws(() => generateRuleset(configuration), ConfigurationError);
        });

    test("WireGuard public key in a set comment", () => {
        const configuration = scenarioConfiguration();
        configuration.hosts[0].wireguardPublicKey = 'abc" accept';
        assert.throws(() => generateRuleset(configuration), ConfigurationError);
    });

    test("unknown references", () => {
        const configuration = scenarioConfiguration();
        configuration.forwardRules[0].service = "telnet";
        configuration.forwardRules[0].from.zone = "dmz";
        const error = (() => {
            try {
                generateRuleset(configuration);
            } catch (caught) {
                return caught as ConfigurationError;
            }
            return null;
        })();
        assert.ok(error);
        assert.equal(error.problems.length, 2);
    });

    test("NAT source must be IPv4", () => {
        const configuration = scenarioConfiguration();
        configuration.natRules[0].sourceAddress = "fd00::/64";
        assert.throws(() => generateRuleset(configuration), ConfigurationError);
    });

    test("invalid verdict", () => {
        const configuration = scenarioConfiguration();
        (configuration.forwardRules[0] as { action: string }).action = "accept; flush ruleset";
        assert.throws(() => generateRuleset(configuration), ConfigurationError);
    });
});
