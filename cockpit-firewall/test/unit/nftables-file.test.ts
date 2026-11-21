import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { deriveState, isUpToDate, planApply } from "../../src/firewall-state.ts";
import { FirewallConfiguration, addWireguardListenRule, convertLegacyConfiguration, createEmptyConfiguration } from "../../src/model.ts";
import { foreignPartOfFile, hasFlushRuleset, managedPartOfFile, replaceManagedBlock, stockFilterTableState } from "../../src/nftables-file.ts";
import { generateRuleset } from "../../src/ruleset.ts";
import { parseWireguardConfiguration } from "../../src/wireguard-import.ts";

const DEBIAN_STOCK_FILE = `#!/usr/sbin/nft -f

flush ruleset

table inet filter {
\tchain input {
\t\ttype filter hook input priority filter;
\t}
\tchain forward {
\t\ttype filter hook forward priority filter;
\t}
\tchain output {
\t\ttype filter hook output priority filter;
\t}
}
`;

const FOREIGN_TABLE = `table inet f2b-table {
\tset addr-set-sshd {
\t\ttype ipv4_addr
\t\telements = { 203.0.113.9 }
\t}
\tchain f2b-chain {
\t\ttype filter hook input priority filter - 1; policy accept;
\t\ttcp dport 22 ip saddr @addr-set-sshd reject
\t}
}
`;

function sampleConfiguration(): FirewallConfiguration {
    return {
        ...createEmptyConfiguration(),
        zones: [{ name: "vpn", interfaces: ["wg0"], forwardPolicy: "drop", inputPolicy: "accept" }],
        natRules: [{ sourceAddress: "10.99.0.0/24", egressZone: "vpn", enabled: true }],
    };
}

const block = generateRuleset(sampleConfiguration()).text;

describe("/etc/nftables.conf editing", () => {
    test("appends the block and keeps everything else byte for byte", () => {
        const original = DEBIAN_STOCK_FILE + "\n" + FOREIGN_TABLE + "# my note\n";
        const result = replaceManagedBlock(original, block, false);
        assert.ok(result.startsWith(original));
        assert.equal(managedPartOfFile(result), block);
        assert.equal(foreignPartOfFile(result).trimEnd(), original.trimEnd());
        assert.ok(hasFlushRuleset(result));
    });

    test("replaces an existing block in place", () => {
        const first = replaceManagedBlock(DEBIAN_STOCK_FILE, block, false) + FOREIGN_TABLE;
        const otherBlock = generateRuleset(createEmptyConfiguration()).text;
        const second = replaceManagedBlock(first, otherBlock, false);
        assert.equal(second, DEBIAN_STOCK_FILE + "\n" + otherBlock + FOREIGN_TABLE);
    });

    test("replaces own tables written without markers and the legacy NAT table", () => {
        const handWritten = DEBIAN_STOCK_FILE + "table inet cockpit_fw {\n\tchain forward {\n\t\ttype filter hook forward priority filter; policy accept;\n\t}\n}\n" +
            FOREIGN_TABLE + "table ip cockpit_fw_nat {\n}\n";
        const result = replaceManagedBlock(handWritten, block, false);
        assert.equal(result, DEBIAN_STOCK_FILE + block + FOREIGN_TABLE);
    });

    test("removes the stock table only when asked", () => {
        const withBlock = replaceManagedBlock(DEBIAN_STOCK_FILE, block, false);
        assert.match(withBlock, /table inet filter/);
        const removed = replaceManagedBlock(DEBIAN_STOCK_FILE + FOREIGN_TABLE, block, true);
        assert.doesNotMatch(removed, /table inet filter/);
        assert.match(removed, /flush ruleset/);
        assert.ok(removed.includes(FOREIGN_TABLE));
        assert.ok(removed.includes(block));
    });

    test("creates a new file without flush ruleset", () => {
        const created = replaceManagedBlock("", block, false);
        assert.ok(created.startsWith("#!/usr/sbin/nft -f\n"));
        assert.ok(!hasFlushRuleset(created));
        assert.ok(created.endsWith(block));
    });

    test("removing the block restores the rest", () => {
        const original = DEBIAN_STOCK_FILE + FOREIGN_TABLE;
        const withBlock = replaceManagedBlock(original, block, false);
        assert.equal(replaceManagedBlock(withBlock, "", false).trimEnd(), original.trimEnd());
    });

    test("refuses unbalanced markers", () => {
        assert.throws(() => replaceManagedBlock(DEBIAN_STOCK_FILE + "# BEGIN cockpit-firewall\n", block, false));
        assert.throws(() => replaceManagedBlock("# END cockpit-firewall\n" + DEBIAN_STOCK_FILE, block, false));
    });

    test("a table name in a comment or string is not a table", () => {
        const tricky = DEBIAN_STOCK_FILE + "# table inet cockpit_fw { }\n" + FOREIGN_TABLE.replace("reject", 'reject comment "table inet cockpit_fw"');
        assert.equal(replaceManagedBlock(tricky, block, false), tricky + "\n" + block);
    });
});

describe("stock filter table detection", () => {
    test("stock, modified and absent", () => {
        assert.equal(stockFilterTableState(DEBIAN_STOCK_FILE), "stock");
        assert.equal(stockFilterTableState(DEBIAN_STOCK_FILE.replace("priority filter;\n\t}\n\tchain forward", "priority filter;\n\t\ttcp dport 22 accept\n\t}\n\tchain forward")), "modified");
        assert.equal(stockFilterTableState(DEBIAN_STOCK_FILE.replace("priority filter;\n\t}\n\tchain forward", "priority filter; policy drop;\n\t}\n\tchain forward")), "modified");
        assert.equal(stockFilterTableState(FOREIGN_TABLE), "absent");
        assert.equal(stockFilterTableState("table inet filter {\n\tchain input {\n\t\ttype filter hook input priority filter; policy accept;\n\t}\n}\n"), "stock");
    });
});

describe("host state", () => {
    const fileWithBlock = replaceManagedBlock(DEBIAN_STOCK_FILE, block, false);
    const liveTable = block.slice(block.indexOf("table inet cockpit_fw {"), block.indexOf("# END"));

    test("the file is the source of truth; a matching live table is no drift", () => {
        const state = deriveState({ fileText: fileWithBlock, liveOwnTable: liveTable, liveRuleset: liveTable, legacyConfiguration: null, legacyFilesPresent: false });
        assert.equal(state.source, "file");
        assert.deepEqual(state.initialConfiguration, sampleConfiguration());
        assert.equal(state.drift, false);
        assert.equal(state.stockFilterTableRemovable, true);
        assert.ok(isUpToDate({ fileText: fileWithBlock, liveOwnTable: liveTable, liveRuleset: "", legacyConfiguration: null, legacyFilesPresent: false },
                             state, planApply(fileWithBlock, state.initialConfiguration, false)));
    });

    test("a live table that differs from the file is drift; live is used when the file has none", () => {
        const otherLive = generateRuleset(createEmptyConfiguration()).text;
        assert.equal(deriveState({ fileText: fileWithBlock, liveOwnTable: otherLive, liveRuleset: "", legacyConfiguration: null, legacyFilesPresent: false }).drift, true);
        const liveOnly = deriveState({ fileText: DEBIAN_STOCK_FILE, liveOwnTable: liveTable, liveRuleset: "", legacyConfiguration: null, legacyFilesPresent: false });
        assert.equal(liveOnly.source, "live");
        assert.equal(liveOnly.drift, true);
        assert.equal(deriveState({ fileText: null, liveOwnTable: "", liveRuleset: "", legacyConfiguration: null, legacyFilesPresent: false }).source, "empty");
    });

    test("an unknown rule in the live table is drift", () => {
        const withExtraRule = liveTable.replace("\t\tiifname @zone_vpn counter drop", "\t\ttcp dport 22 counter packets 4 bytes 240 drop\n\t\tiifname @zone_vpn counter drop");
        assert.equal(deriveState({ fileText: fileWithBlock, liveOwnTable: withExtraRule, liveRuleset: "", legacyConfiguration: null, legacyFilesPresent: false }).drift, true);
        const counted = liveTable.replace("counter drop", "counter packets 9 bytes 540 drop");
        assert.equal(deriveState({ fileText: fileWithBlock, liveOwnTable: counted, liveRuleset: "", legacyConfiguration: null, legacyFilesPresent: false }).drift, false);
    });

    test("a legacy configuration wins until migrated, and the legacy NAT table is noticed", () => {
        const legacy = convertLegacyConfiguration({ zones: [], wireguardListenPorts: [51820] });
        const state = deriveState({ fileText: fileWithBlock, liveOwnTable: liveTable, liveRuleset: "table ip cockpit_fw_nat {\n}\n", legacyConfiguration: legacy, legacyFilesPresent: true });
        assert.equal(state.source, "legacy");
        assert.equal(state.legacyNatTableLoaded, true);
        assert.equal(state.stockFilterTableRemovable, true);
    });

    test("apply plan: live text holds only own tables, candidate keeps the rest of the file", () => {
        const plan = planApply(DEBIAN_STOCK_FILE + FOREIGN_TABLE, sampleConfiguration(), false);
        assert.equal(plan.enableForwarding, true);
        assert.doesNotMatch(plan.liveText, /f2b-table|flush ruleset|inet filter/);
        assert.ok(plan.candidateFile.startsWith(DEBIAN_STOCK_FILE + FOREIGN_TABLE));
        assert.match(planApply(DEBIAN_STOCK_FILE, sampleConfiguration(), true).liveText, /^table inet filter\ndelete table inet filter$/m);
        assert.equal(planApply(null, createEmptyConfiguration(), false).enableForwarding, false);
    });
});

describe("migration and WireGuard helpers", () => {
    test("legacy configuration: listen ports become the first input rules, management access defaults on", () => {
        const converted = convertLegacyConfiguration({
            zones: [{ name: "vpn", interfaces: ["wg0"], forwardPolicy: "drop", inputPolicy: "accept" }],
            inputRules: [{ from: { zone: "vpn" }, service: "wireguard", action: "drop", enabled: false }],
            wireguardListenPorts: [51820, 51821, 0, "x"],
        });
        assert.equal(converted.allowManagementAccess, true);
        assert.deepEqual(converted.inputRules.map(rule => [rule.service, rule.action, rule.comment]),
                         [["wireguard", "accept", "WireGuard 51820"], ["wireguard-51821", "accept", "WireGuard 51821"], ["wireguard", "drop", undefined]]);
        assert.deepEqual(converted.services, [{ name: "wireguard-51821", ports: [{ protocol: "udp", port: "51821" }] }]);
        assert.deepEqual(convertLegacyConfiguration("garbage"), createEmptyConfiguration());
        assert.doesNotThrow(() => generateRuleset(converted));
    });

    test("legacy WireGuard hosts without a public key become manual hosts", () => {
        const converted = convertLegacyConfiguration({
            hosts: [{ name: "old-peer", addresses: ["10.99.0.7"], origin: "wireguard", wireguardInterface: "wg0" }],
            forwardRules: [{ from: { host: "old-peer" }, to: {}, service: "any", action: "accept", enabled: true }],
        });
        assert.deepEqual(converted.hosts, [{ name: "old-peer", addresses: ["10.99.0.7"], origin: "manual" }]);
        assert.doesNotThrow(() => generateRuleset(converted));
    });

    test("adding the WireGuard listen rule twice adds it once", () => {
        const once = addWireguardListenRule(createEmptyConfiguration(), 51820, "wg0");
        assert.deepEqual(addWireguardListenRule(once, 51820, "wg0"), once);
        assert.equal(once.inputRules.length, 1);
    });

    test("re-importing after a ListenPort change updates the imported rule and service", () => {
        const first = addWireguardListenRule(createEmptyConfiguration(), 51821, "wg0");
        const second = addWireguardListenRule(first, 51822, "wg0");
        assert.deepEqual(second.services, [{ name: "wireguard-wg0", ports: [{ protocol: "udp", port: "51822" }] }]);
        assert.deepEqual(second.inputRules.map(rule => rule.service), ["wireguard-wg0"]);
        const backToDefault = addWireguardListenRule(second, 51820, "wg0");
        assert.deepEqual(backToDefault.services, []);
        assert.deepEqual(backToDefault.inputRules.map(rule => [rule.service, rule.comment]), [["wireguard", "WireGuard wg0"]]);
    });

    test("peer names from an `(access: ...)` comment above [Peer]; `# Name =` wins", () => {
        const summary = parseWireguardConfiguration("wg0", "# vpn-laptop (access: ssh only)\n[Peer]\nPublicKey = a\nAllowedIPs = 10.99.0.3/32\n\n# phone (access: full)\n[Peer]\n# Name = my-phone\nPublicKey = b\nAllowedIPs = 10.99.0.4/32\n# not a header\n\n[Peer]\nPublicKey = c\nAllowedIPs = 10.99.0.5/32\n# tablet (access: lan)\n\n[Peer]\nPublicKey = d\nAllowedIPs = 10.99.0.6/32\n");
        assert.deepEqual(summary.hosts.map(host => host.name), ["vpn-laptop", "my-phone", "wg0-peer-c", "tablet"]);
    });
});
