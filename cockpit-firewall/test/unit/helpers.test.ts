import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseForeignTables, foreignTableWarnings } from "../../src/coexistence.ts";
import { diffLines } from "../../src/text-diff.ts";
import {
    applyScriptText,
    confirmScriptText,
    parseTransactionStatus,
    revertScriptText,
    rollbackScriptText,
} from "../../src/transaction.ts";
import { isValidInterfaceName, parseAddress, parseServicePorts } from "../../src/validation.ts";
import { mergeImportedHosts, parseWireguardConfiguration, sanitizeHostName } from "../../src/wireguard-import.ts";

describe("WireGuard peer import", () => {
    const configuration = `[Interface]
Address = 10.10.20.1/24, fd10::1/64
ListenPort = 51820
PostUp = nft -f /etc/host-setup/vpn/firewall.nft

[Peer]
# Name = ewertons-msft
PublicKey = a
AllowedIPs = 10.10.20.3/32, fd10::3/128

[Peer]
PublicKey = b
AllowedIPs = 10.10.20.4/32

[Peer]
# Name = My Phone (old)
PublicKey = c
AllowedIPs = 10.10.20.5/32,  bogus, 10.10.20.6/24

[Peer]
# Name = upstream
PublicKey = d
AllowedIPs = 0.0.0.0/0
`;

    test("parses names, addresses, listen port and network", () => {
        const summary = parseWireguardConfiguration("wg0", configuration);
        assert.equal(summary.listenPort, 51820);
        assert.deepEqual(summary.networks, ["10.10.20.0/24"]);
        assert.deepEqual(summary.hosts, [
            { name: "ewertons-msft", addresses: ["10.10.20.3", "fd10::3"], origin: "wireguard", wireguardInterface: "wg0" },
            { name: "wg0-peer-2", addresses: ["10.10.20.4"], origin: "wireguard", wireguardInterface: "wg0" },
            { name: "My-Phone-old", addresses: ["10.10.20.5"], origin: "wireguard", wireguardInterface: "wg0" },
        ]);
        assert.deepEqual(summary.skippedPeers, ["upstream"]);
    });

    test("sanitizes hostile names", () => {
        assert.equal(sanitizeHostName('x"; flush ruleset'), "x-flush-ruleset");
        assert.equal(sanitizeHostName("123"), "");
        assert.equal(sanitizeHostName("  ünïcode name "), "n-code-name");
    });

    test("rejects invalid interface names", () => {
        assert.deepEqual(parseWireguardConfiguration("../etc", configuration).hosts, []);
    });

    test("merge replaces earlier imports from the same interface and keeps manual hosts", () => {
        const summary = parseWireguardConfiguration("wg0", configuration);
        const existing = [
            { name: "old-peer", addresses: ["10.10.20.9"], origin: "wireguard" as const, wireguardInterface: "wg0" },
            { name: "ewertons-msft", addresses: ["192.0.2.1"], origin: "manual" as const },
        ];
        const { hosts, conflicts } = mergeImportedHosts(existing, summary);
        assert.deepEqual(conflicts, ["ewertons-msft"]);
        assert.deepEqual(hosts.map(host => host.name), ["ewertons-msft", "wg0-peer-2", "My-Phone-old"]);
        assert.equal(hosts[0].origin, "manual");
    });
});

describe("validation helpers", () => {
    test("addresses are canonicalized", () => {
        assert.deepEqual(parseAddress("10.10.20.3/32"), { family: "ipv4", text: "10.10.20.3" });
        assert.deepEqual(parseAddress("10.10.20.0/24"), { family: "ipv4", text: "10.10.20.0/24" });
        assert.deepEqual(parseAddress("FD00::/8"), { family: "ipv6", text: "fd00::/8" });
        assert.equal(parseAddress("fd00::1/8"), null);
        assert.equal(parseAddress("10.1.1.1/024"), null);
    });

    test("service ports", () => {
        assert.deepEqual(parseServicePorts("tcp/22, udp/53,tcp/8000-8100"), [
            { protocol: "tcp", port: "22" }, { protocol: "udp", port: "53" }, { protocol: "tcp", port: "8000-8100" },
        ]);
        assert.equal(typeof parseServicePorts("sctp/22"), "string");
        assert.equal(typeof parseServicePorts(""), "string");
    });

    test("interface names", () => {
        assert.ok(isValidInterfaceName("wg0"));
        assert.ok(isValidInterfaceName("enp3s0.100"));
        assert.ok(isValidInterfaceName("wg*"));
        assert.ok(!isValidInterfaceName("*"));
        assert.ok(!isValidInterfaceName("w*g"));
        assert.ok(!isValidInterfaceName('wg0"'));
    });
});

describe("transaction scripts", () => {
    const apply = applyScriptText(true);

    test("apply checks before snapshotting, arms rollback before loading", () => {
        const order = [
            'nft -c -f "$state_directory/pending.nft"',
            "nft list table inet cockpit_fw",
            "systemd-run --quiet",
            "echo 1 > /proc/sys/net/ipv4/ip_forward",
            'if ! nft -f "$state_directory/pending.nft"',
        ].map(fragment => apply.indexOf(fragment));
        assert.ok(order.every(index => index >= 0), String(order));
        assert.deepEqual([...order].sort((first, second) => first - second), order);
        assert.match(apply, /--on-active=60/);
        assert.match(apply, /setsid \/bin\/sh -c 'sleep 60;/);
        assert.doesNotMatch(applyScriptText(false), /echo 1 > \/proc\/sys\/net\/ipv4\/ip_forward/);
    });

    test("snapshot restores only own tables", () => {
        assert.match(apply, /printf '%s\\n' 'table inet cockpit_fw' 'delete table inet cockpit_fw' 'table ip cockpit_fw_nat' 'delete table ip cockpit_fw_nat'/);
        assert.doesNotMatch(apply, /list ruleset|flush ruleset/);
    });

    test("rollback and confirm race on an atomic mkdir", () => {
        assert.match(rollbackScriptText(), /^mkdir "\/run\/cockpit-firewall\/decision" 2>\/dev\/null \|\| exit 0$/m);
        assert.match(confirmScriptText(true), /if ! mkdir "\$state_directory\/decision"/);
        assert.match(rollbackScriptText(), /previous-ip-forward" > \/proc\/sys\/net\/ipv4\/ip_forward/);
    });

    test("confirm persists ruleset, sysctl and boot unit", () => {
        const confirm = confirmScriptText(true);
        assert.match(confirm, /install -m 600 "\$state_directory\/pending.nft" "\/etc\/nftables.d\/cockpit-fw.nft"/);
        assert.match(confirm, /net.ipv4.ip_forward = 1/);
        assert.match(confirm, /WantedBy=sysinit.target nftables.service/);
        assert.match(confirm, /systemctl enable "cockpit-firewall.service"/);
        assert.match(confirmScriptText(false), /rm -f "\/etc\/sysctl.d\/90-cockpit-firewall.conf"/);
    });

    test("revert runs rollback immediately", () => {
        assert.match(revertScriptText(), /\/bin\/sh "\$state_directory\/rollback.sh"/);
    });

    test("status parsing", () => {
        assert.deepEqual(parseTransactionStatus("pending 42\n"), { state: "pending", secondsLeft: 42 });
        assert.deepEqual(parseTransactionStatus("rolled-back"), { state: "rolled-back" });
        assert.deepEqual(parseTransactionStatus("garbage"), { state: "none" });
    });
});

describe("coexistence", () => {
    const json = JSON.stringify({
        nftables: [
            { metainfo: { version: "1.0.6" } },
            { chain: { family: "inet", table: "host_setup_vpn", name: "forward", handle: 1, type: "filter", hook: "forward", prio: 0, policy: "drop" } },
            { chain: { family: "inet", table: "host_setup_vpn", name: "helper", handle: 2 } },
            { chain: { family: "inet", table: "cockpit_fw", name: "forward", handle: 1, type: "filter", hook: "forward", prio: 0, policy: "accept" } },
            { chain: { family: "ip", table: "cockpit_fw_nat", name: "postrouting", handle: 1, type: "nat", hook: "postrouting", prio: 100, policy: "accept" } },
            { chain: { family: "ip", table: "nat", name: "DOCKER", handle: 1 } },
        ],
    });

    test("lists foreign tables only and warns about drop policies", () => {
        const tables = parseForeignTables(json);
        assert.deepEqual(tables.map(table => `${table.family} ${table.name} ${table.chainCount}`), ["inet host_setup_vpn 2", "ip nat 1"]);
        assert.equal(foreignTableWarnings(tables).length, 1);
        assert.deepEqual(parseForeignTables("not json"), []);
    });
});

describe("diff", () => {
    test("line diff", () => {
        assert.deepEqual(diffLines("a\nb\nc\n", "a\nc\nd\n"), [
            { kind: "same", text: "a" },
            { kind: "removed", text: "b" },
            { kind: "same", text: "c" },
            { kind: "added", text: "d" },
        ]);
        assert.deepEqual(diffLines("", "x"), [{ kind: "added", text: "x" }]);
    });
});
