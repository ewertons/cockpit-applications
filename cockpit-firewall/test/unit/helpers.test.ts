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
    statusScriptText,
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
PublicKey = bKey+/xyz123=
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
            { name: "ewertons-msft", addresses: ["10.10.20.3", "fd10::3"], origin: "wireguard", wireguardInterface: "wg0", wireguardPublicKey: "a" },
            { name: "wg0-peer-bKeyxyz1", addresses: ["10.10.20.4"], origin: "wireguard", wireguardInterface: "wg0", wireguardPublicKey: "bKey+/xyz123=" },
            { name: "My-Phone-old", addresses: ["10.10.20.5"], origin: "wireguard", wireguardInterface: "wg0", wireguardPublicKey: "c" },
        ]);
        assert.deepEqual(summary.skippedPeers, ["upstream"]);
    });

    test("skips peers routing everything, however /0 is spelled", () => {
        const summary = parseWireguardConfiguration("wg0", "[Peer]\n# Name = gw6\nPublicKey = g6\nAllowedIPs = 0::/0, 0:0:0:0:0:0:0:0/0\n[Peer]\n# Name = gw4\nPublicKey = g4\nAllowedIPs = 0.0.0.0/0\n");
        assert.deepEqual(summary.hosts, []);
        assert.deepEqual(summary.skippedPeers, ["gw6", "gw4"]);
    });

    test("ignores inline comments", () => {
        const summary = parseWireguardConfiguration("wg0", "[Interface]\nListenPort = 51820 # VPN\nAddress = 10.10.20.1/24 # hub\n[Peer] # laptop\nPublicKey = l\nAllowedIPs = 10.10.20.2/32\n[Peer]   # phone\n# Name = phone\nPublicKey = p # key\nAllowedIPs = 10.10.20.3/32 # phone\n");
        assert.equal(summary.listenPort, 51820);
        assert.deepEqual(summary.networks, ["10.10.20.0/24"]);
        assert.deepEqual(summary.hosts.map(host => [host.name, host.addresses]), [["wg0-peer-l", ["10.10.20.2"]], ["phone", ["10.10.20.3"]]]);
        assert.equal(summary.hosts[1].wireguardPublicKey, "p");
    });

    test("fallback names follow the PublicKey, not the position", () => {
        const both = parseWireguardConfiguration("wg0", "[Peer]\nPublicKey = first\nAllowedIPs = 10.10.20.7/32\n[Peer]\nPublicKey = second\nAllowedIPs = 10.10.20.8/32\n");
        const secondOnly = parseWireguardConfiguration("wg0", "[Peer]\nPublicKey = second\nAllowedIPs = 10.10.20.8/32\n");
        assert.deepEqual(both.hosts.map(host => host.name), ["wg0-peer-first", "wg0-peer-second"]);
        assert.deepEqual(secondOnly.hosts.map(host => [host.name, host.addresses]), [["wg0-peer-second", ["10.10.20.8"]]]);
        const merged = mergeImportedHosts(both.hosts, secondOnly);
        assert.deepEqual(merged.removed, ["wg0-peer-first"]);
        assert.deepEqual(merged.reassigned, []);
    });

    test("fallback names never collide; peers without PublicKey are skipped", () => {
        const summary = parseWireguardConfiguration("wg0", "[Peer]\n# Name = wg0-peer-k\nPublicKey = j\nAllowedIPs = 10.10.20.7/32\n[Peer]\nPublicKey = k\nAllowedIPs = 10.10.20.8/32\n[Peer]\n# Name = keyless\nAllowedIPs = 10.10.20.9/32\n");
        assert.deepEqual(summary.hosts.map(host => host.name), ["wg0-peer-k", "wg0-peer-k-2"]);
        assert.deepEqual(summary.skippedPeers, ["keyless"]);
    });

    test("merge reports names now held by another peer or by an import without a stored key", () => {
        const summary = parseWireguardConfiguration("wg0", "[Peer]\n# Name = laptop\nPublicKey = new\nAllowedIPs = 10.10.20.7/32\n[Peer]\n# Name = phone\nPublicKey = same\nAllowedIPs = 10.10.20.8/32\n");
        const existing = [
            { name: "laptop", addresses: ["10.10.20.7"], origin: "wireguard" as const, wireguardInterface: "wg0", wireguardPublicKey: "old" },
            { name: "phone", addresses: ["10.10.20.8"], origin: "wireguard" as const, wireguardInterface: "wg0", wireguardPublicKey: "same" },
            { name: "wg0-peer-1", addresses: ["10.10.20.9"], origin: "wireguard" as const, wireguardInterface: "wg0" },
        ];
        const merged = mergeImportedHosts(existing, summary);
        assert.deepEqual(merged.reassigned, ["laptop"]);
        assert.deepEqual(merged.removed, ["wg0-peer-1"]);
        const legacy = mergeImportedHosts([{ name: "phone", addresses: [], origin: "wireguard" as const, wireguardInterface: "wg0" }], summary);
        assert.deepEqual(legacy.reassigned, ["phone"]);
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
        assert.deepEqual(hosts.map(host => host.name), ["ewertons-msft", "wg0-peer-bKeyxyz1", "My-Phone-old"]);
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

    test("apply checks before snapshotting, arms rollback before loading, forwards only after loading", () => {
        const order = [
            'nft -c -f "$state_directory/pending.nft"',
            "nft list table inet cockpit_fw",
            "systemd-run --quiet",
            'if ! nft -f "$state_directory/pending.nft"',
            "exit 5\nfi\necho 1 > /proc/sys/net/ipv4/ip_forward",
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

    test("every script except status serializes on the transaction lock", () => {
        for (const script of [apply, confirmScriptText(), revertScriptText(), rollbackScriptText()])
            assert.match(script, /exec 9>"\/run\/cockpit-firewall\/lock"\n\s*flock 9/);
        assert.doesNotMatch(statusScriptText(), /flock/);
        // Detached rollback must not inherit the lock descriptor.
        assert.match(apply, /systemd-run [^\n]*"\$token" 9>&-/);
        assert.match(apply, /setsid [^\n]* 9>&- &/);
    });

    test("rollback ignores a stale token and loses to an earlier decision", () => {
        const rollback = rollbackScriptText();
        const tokenCheck = rollback.indexOf('[ "$(cat "/run/cockpit-firewall/token" 2>/dev/null)" = "${1:-}" ] || exit 0');
        const decision = rollback.indexOf('mkdir "/run/cockpit-firewall/decision" 2>/dev/null || exit 0');
        assert.ok(tokenCheck > 0 && decision > tokenCheck, String([tokenCheck, decision]));
        assert.match(rollback, /previous-ip-forward" > \/proc\/sys\/net\/ipv4\/ip_forward/);
        assert.match(apply, /token=\$\(cat \/proc\/sys\/kernel\/random\/uuid\)/);
    });

    test("apply records whether confirm must persist forwarding", () => {
        assert.match(apply, /echo 1 > "\$state_directory\/forwarding"/);
        assert.match(applyScriptText(false), /echo 0 > "\$state_directory\/forwarding"/);
        assert.match(confirmScriptText(), /if \[ "\$\(cat "\$state_directory\/forwarding" 2>\/dev\/null\)" = 1 \]/);
    });

    test("confirm persists and starts the unit before cancelling rollback", () => {
        const confirm = confirmScriptText();
        const order = [
            'install -m 600 "$state_directory/pending.nft" "/etc/nftables.d/cockpit-fw.nft.new"',
            "net.ipv4.ip_forward = 1",
            "WantedBy=sysinit.target nftables.service",
            'systemctl enable "cockpit-firewall.service"',
            'systemctl start "cockpit-firewall.service"',
            'mkdir "$state_directory/decision"',
            'systemctl stop "$rollback_unit.timer"',
            'rm -f "$state_directory/armed"',
        ].map(fragment => confirm.indexOf(fragment));
        assert.ok(order.every(index => index >= 0), String(order));
        assert.deepEqual([...order].sort((first, second) => first - second), order);
    });

    test("failed persistence restores previous files and keeps the change pending", () => {
        const confirm = confirmScriptText();
        const failure = confirm.slice(confirm.indexOf("if ! persist; then"), confirm.indexOf('mkdir "$state_directory/decision"'));
        assert.match(failure, /restore_previous_files/);
        assert.match(failure, /exit 8/);
        assert.doesNotMatch(failure, /armed|decision/);
        assert.match(confirm, /cp -p "\/etc\/nftables.d\/cockpit-fw.nft" "\$state_directory\/backup"\/cockpit-fw.nft/);
    });

    test("rollback reports a failed restore through its exit status", () => {
        const rollback = rollbackScriptText();
        const failure = rollback.slice(rollback.indexOf("echo rollback-failed"));
        assert.match(failure, /^echo rollback-failed > "[^"]+"\n\s*exit 1\n/);
    });

    test("confirm and revert act only on the change the caller reviewed", () => {
        for (const script of [confirmScriptText(), revertScriptText()]) {
            const check = script.indexOf('if [ "$(cat "$state_directory/token" 2>/dev/null)" != "${1:-}" ]; then');
            assert.ok(check > script.indexOf("flock 9"), "token check runs under the lock");
            assert.match(script.slice(check), /^[^\n]+\n[^\n]+\n\s*exit 9\n/);
        }
        assert.ok(confirmScriptText().indexOf("!= \"${1:-}\"") < confirmScriptText().indexOf("install -m 600"));
    });

    test("revert runs rollback immediately", () => {
        assert.match(revertScriptText(), /COCKPIT_FIREWALL_LOCK_HELD=1 \/bin\/sh "\$state_directory\/rollback.sh" "\$\(cat "\$state_directory\/token"\)"/);
    });

    test("status parsing", () => {
        const token = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert.deepEqual(parseTransactionStatus(`pending 42 ${token}\n`), { state: "pending", secondsLeft: 42, token });
        assert.deepEqual(parseTransactionStatus("pending 42 $(reboot)"), { state: "none" });
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
