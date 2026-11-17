import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
    addSambaUserCommand,
    createSystemUserCommand,
    deleteSambaUserCommand,
    parseGetent,
    parsePdbeditVerbose,
    passwordInput,
    setSambaUserEnabledCommand,
} from "../../src/accounts.ts";
import {
    createDirectoryCommand,
    journalCommand,
    parseLogFiles,
    parsePathInformation,
    parseUnitStates,
    pathInformationCommand,
    tailLogFileCommand,
    unitActionCommand,
} from "../../src/services.ts";
import { disconnectSessionCommand, parseSambaStatus } from "../../src/status.ts";

// esbuild bundles tests into a temporary directory, so fixtures are found from the working directory (the app folder).
const fixture = (name: string) => fs.readFileSync(path.join("test", "fixtures", name), "utf8");

describe("smbstatus", () => {
    test("sessions show the negotiated dialect, so SMB1 clients stand out", () => {
        const status = parseSambaStatus(fixture("status.json"));
        assert.match(status.version, /^4\.\d+/);
        const byDialect = Object.fromEntries(status.sessions.map(session => [session.dialect, session]));
        assert.equal(byDialect.NT1.isSmb1, true);
        assert.equal(byDialect.SMB3_11.isSmb1, false);
        assert.equal(byDialect.NT1.userName, "agent");
        assert.equal(byDialect.NT1.clientAddress.startsWith("ipv4:127.0.0.1:"), true);
        assert.ok(byDialect.NT1.processId > 0);
        assert.deepEqual(byDialect.NT1.shares, ["share"]);
    });

    test("open files", () => {
        const [file] = parseSambaStatus(fixture("status-open-files.json")).openFiles;
        assert.equal(file.path, "/srv/samba/share/hello.txt");
        assert.equal(file.fileName, "hello.txt");
        assert.equal(file.access, "RW");
        assert.equal(file.shareMode, "RW");
        assert.ok(file.processId > 0);
    });

    test("byte-range locks and missing sections", () => {
        const status = parseSambaStatus(JSON.stringify({
            byte_range_locks: { "/srv/a": { file_name: "a", locks: [{ server_id: { pid: "77" }, type: "W", flavour: "Posix", start: 0, size: 10 }] } },
        }));
        assert.deepEqual(status.locks, [{ path: "/srv/a", processId: 77, type: "W", flavour: "Posix", start: 0, size: 10 }]);
        assert.deepEqual(status.sessions, []);
        assert.deepEqual(status.openFiles, []);
    });

    test("disconnect targets one smbd process", () => {
        assert.deepEqual(disconnectSessionCommand(1129), ["smbcontrol", "1129", "shutdown"]);
        assert.throws(() => disconnectSessionCommand(0));
        assert.throws(() => disconnectSessionCommand(1.5));
    });
});

describe("accounts", () => {
    test("pdbedit -L -v", () => {
        const users = parsePdbeditVerbose(fixture("pdbedit.txt"));
        assert.deepEqual(users.map(user => [user.userName, user.flags, user.disabled, user.fullName]), [
            ["agent", "U", false, ""],
            ["scanner", "DU", true, "Office scanner"],
        ]);
        assert.match(users[0].passwordLastSet, /20\d\d/);
        assert.deepEqual(parsePdbeditVerbose(""), []);
    });

    test("getent passwd and group", () => {
        const users = parseGetent("root:x:0:0:root:/root:/bin/bash\nscanner:x:999:999::/nonexistent:/usr/sbin/nologin\n", "passwd");
        assert.deepEqual(users.map(user => [user.name, user.id, user.shell]), [["root", 0, "/bin/bash"], ["scanner", 999, "/usr/sbin/nologin"]]);
        const groups = parseGetent("staff:x:1001:alice,bob\nempty:x:1002:\n", "group");
        assert.deepEqual(groups.map(group => [group.name, group.id, group.members]), [["staff", 1001, ["alice", "bob"]], ["empty", 1002, []]]);
    });

    test("commands reject names that could be options", () => {
        assert.deepEqual(createSystemUserCommand("scanner").slice(-2), ["--", "scanner"]);
        assert.throws(() => createSystemUserCommand("-o"));
        assert.throws(() => addSambaUserCommand("--help"));
        assert.throws(() => deleteSambaUserCommand("a b"));
        assert.deepEqual(setSambaUserEnabledCommand("bob", false), ["smbpasswd", "-d", "bob"]);
        assert.equal(passwordInput("pw"), "pw\npw\n");
    });
});

describe("services and files", () => {
    test("systemctl show output", () => {
        const states = parseUnitStates(`Id=smbd.service
LoadState=loaded
ActiveState=active
SubState=running
UnitFileState=enabled

Id=nmbd.service
LoadState=loaded
ActiveState=inactive
SubState=dead
UnitFileState=disabled

Id=samba-ad-dc.service
LoadState=not-found
ActiveState=inactive
SubState=dead
UnitFileState=
`);
        assert.deepEqual(states.map(state => [state.unit, state.installed, state.activeState, state.unitFileState]), [
            ["smbd.service", true, "active", "enabled"],
            ["nmbd.service", true, "inactive", "disabled"],
            ["samba-ad-dc.service", false, "inactive", ""],
        ]);
    });

    test("unit actions are limited to Samba units", () => {
        assert.deepEqual(unitActionCommand("smbd.service", "restart"), ["systemctl", "restart", "--", "smbd.service"]);
        assert.throws(() => unitActionCommand("sshd.service", "stop"));
        assert.throws(() => unitActionCommand("smbd.service", "mask" as never));
    });

    test("log files", () => {
        const files = parseLogFiles("log.smbd\t100\t1700000000.5\nlog.192.168.1.50\t20\t1700000100\ncores\t0\t1\nlog.nmbd.old\t5\t1600000000\n");
        assert.deepEqual(files.map(file => file.name), ["log.192.168.1.50", "log.smbd", "log.nmbd.old"]);
        assert.deepEqual(tailLogFileCommand("log.smbd", 100), ["tail", "-n", "100", "--", "/var/log/samba/log.smbd"]);
        assert.throws(() => tailLogFileCommand("../../etc/shadow", 10));
        assert.throws(() => tailLogFileCommand("log..", 10));
        assert.equal(journalCommand(1e9)[4], "5000");
    });

    test("share path information", () => {
        assert.deepEqual(parsePathInformation("root\tstaff\t2775\tdirectory\n"), { exists: true, owner: "root", group: "staff", mode: "2775", isDirectory: true });
        assert.deepEqual(parsePathInformation("root\troot\t644\tregular file"), { exists: true, owner: "root", group: "root", mode: "0644", isDirectory: false });
        assert.equal(parsePathInformation(null).exists, false);
        assert.throws(() => pathInformationCommand("relative"));
        assert.deepEqual(createDirectoryCommand("/srv/scans"), ["mkdir", "-p", "--", "/srv/scans"]);
        assert.throws(() => createDirectoryCommand("/srv/../etc"));
    });
});
