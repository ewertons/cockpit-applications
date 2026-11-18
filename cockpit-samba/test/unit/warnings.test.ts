import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConfiguration } from "../../src/smb-conf.ts";
import { isWorldWritableMode, securityWarnings } from "../../src/warnings.ts";

const codes = (text: string, paths = {}) => securityWarnings(parseConfiguration(text), paths).map(warning => `${warning.code}${warning.share ? `:${warning.share}` : ""}`);

test("a hardened configuration has no warnings", () => {
    assert.deepEqual(codes(`[global]
   workgroup = HOME
[data]
   path = /srv/data
   valid users = @staff
   create mask = 0660
[homes]
   read only = no
[printers]
   path = /var/tmp
`), []);
});

test("SMB1 is flagged with mitigations, mentioning a missing hosts allow", () => {
    for (const value of ["NT1", "LANMAN2", "core"]) {
        const [warning] = securityWarnings(parseConfiguration(`[global]\n server min protocol = ${value}\n`));
        assert.equal(warning.code, "smb1");
        assert.equal(warning.severity, "danger");
        assert.match(warning.mitigations[0], /No global "hosts allow"/);
    }
    const restricted = securityWarnings(parseConfiguration("[global]\n min protocol = NT1\n hosts allow = 192.168.1.50 127.0.0.1\n"));
    assert.equal(restricted[0].code, "smb1");
    assert.doesNotMatch(restricted[0].mitigations[0], /No global/);
    assert.deepEqual(codes("[global]\n server min protocol = SMB2_02\n"), []);
});

test("legacy authentication and guest mapping", () => {
    assert.deepEqual(codes("[global]\n ntlm auth = yes\n lanman auth = yes\n map to guest = Bad User\n usershare allow guests = yes\n"),
                     ["ntlmv1", "lanman", "map-to-guest", "usershare-guests"]);
    assert.deepEqual(codes("[global]\n ntlm auth = ntlmv1-permitted\n"), ["ntlmv1"]);
    assert.deepEqual(codes("[global]\n ntlm auth = ntlmv2-only\n map to guest = never\n"), []);
});

test("guest shares: writable is more severe; read only via synonyms", () => {
    const warnings = securityWarnings(parseConfiguration("[pub]\n path = /srv/p\n public = yes\n[drop]\n path = /srv/d\n guest ok = yes\n writable = yes\n"));
    assert.deepEqual(warnings.map(warning => [warning.code, warning.share, warning.severity]), [
        ["guest-share", "pub", "warning"],
        ["guest-share", "drop", "danger"],
    ]);
});

test("world-writable masks, also inherited from [global]", () => {
    assert.deepEqual(codes("[global]\n create mask = 0777\n[a]\n path = /a\n valid users = x\n directory mask = 777\n"),
                     ["world-writable-mask:a", "world-writable-mask:a"]);
    assert.deepEqual(codes("[a]\n path = /a\n valid users = x\n create mask = 0775\n"), []);
});

test("world-writable share paths use host information", () => {
    const paths = {
        "/srv/open": { exists: true, mode: "0777", owner: "root", group: "root", isDirectory: true },
        "/srv/closed": { exists: true, mode: "2770", owner: "root", group: "staff", isDirectory: true },
    };
    assert.deepEqual(codes("[a]\n path = /srv/open\n valid users = x\n[b]\n path = /srv/closed\n valid users = x\n[c]\n path = /missing\n valid users = x\n", paths),
                     ["world-writable-path:a"]);
    assert.ok(isWorldWritableMode("1777"));
    assert.ok(!isWorldWritableMode("0775"));
    assert.ok(!isWorldWritableMode(""));
});

test("shares without valid users are informational; disabled shares are skipped", () => {
    const [warning] = securityWarnings(parseConfiguration("[data]\n path = /srv/data\n"));
    assert.equal(warning.code, "no-valid-users");
    assert.equal(warning.severity, "info");
    assert.deepEqual(codes("[data]\n path = /srv/data\n guest ok = yes\n available = no\n"), []);
});
