import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    buildSftpCommandOption,
    escapeSystemdText,
    parseSftpRepository,
    quoteSystemdExecArgument,
    systemdEnvironmentLine,
    validateAbsolutePath,
    validateKeyPath,
    validateRepository,
} from "../../src/command-arguments.ts";

describe("parseSftpRepository", () => {
    test("short form", () => {
        assert.deepEqual(parseSftpRepository("sftp:backup@nas.local:/srv/restic"), { user: "backup", host: "nas.local" });
        assert.deepEqual(parseSftpRepository("sftp:nas:/srv/restic"), { host: "nas" });
        assert.deepEqual(parseSftpRepository("sftp:user@[fd00::1]:/srv/restic"), { user: "user", host: "fd00::1" });
        assert.deepEqual(parseSftpRepository("sftp:backup_nas:/srv/restic"), { host: "backup_nas" });
        assert.deepEqual(parseSftpRepository("sftp:backup@nas.example.com.:/srv/restic"), { user: "backup", host: "nas.example.com." });
        assert.deepEqual(parseSftpRepository("sftp:backup@nas:/srv/@[archive]/restic"), { user: "backup", host: "nas" });
    });

    test("URL form with port", () => {
        assert.deepEqual(parseSftpRepository("sftp://backup@192.168.1.10:2222//srv/restic"),
                         { user: "backup", host: "192.168.1.10", port: 2222 });
        assert.deepEqual(parseSftpRepository("sftp://[fd00::1]:22/restic"), { host: "fd00::1", port: 22 });
    });

    test("non-sftp repositories", () => {
        assert.equal(parseSftpRepository("/mnt/backup"), null);
        assert.equal(parseSftpRepository("s3:s3.amazonaws.com/bucket"), null);
    });

    test("rejects option-like and malformed hosts", () => {
        assert.throws(() => parseSftpRepository("sftp:-oProxyCommand=x:/repo"));
        assert.throws(() => parseSftpRepository("sftp:user@-oProxyCommand=x:/repo"));
        assert.throws(() => parseSftpRepository("sftp:-l@host:/repo"));
        assert.throws(() => parseSftpRepository("sftp:host name:/repo"));
        assert.throws(() => parseSftpRepository("sftp://host:0/repo"));
        assert.throws(() => parseSftpRepository("sftp://host:70000/repo"));
        assert.throws(() => parseSftpRepository("sftp://host:22 -oX/repo"));
        assert.throws(() => parseSftpRepository("sftp:[fd00::1/repo"));
        assert.throws(() => parseSftpRepository("sftp:.:/repo"));
    });
});

describe("validateRepository", () => {
    test("accepts common repositories", () => {
        for (const repository of ["/mnt/backup", "local:/mnt/backup", "sftp:u@h:/r", "rest:https://h:8000/", "b2:bucket:path"])
            assert.equal(validateRepository(repository), null, repository);
    });

    test("rejects unsafe repositories", () => {
        for (const repository of ["", "-o", "relative/path", "/mnt/a\nExecStart=/bin/x", "sftp:-oX=y:/r"])
            assert.notEqual(validateRepository(repository), null, JSON.stringify(repository));
    });
});

describe("validateKeyPath and validateAbsolutePath", () => {
    test("key path", () => {
        assert.equal(validateKeyPath("/etc/cockpit-backup/ssh-keys/backup-1"), null);
        for (const keyPath of ["key", "/a b", "/a\"b", "/a/../b", "/a\nb", "/a;b"])
            assert.notEqual(validateKeyPath(keyPath), null, keyPath);
    });

    test("absolute path", () => {
        assert.equal(validateAbsolutePath("/home/user/My Documents"), null);
        assert.notEqual(validateAbsolutePath("-home"), null);
        assert.notEqual(validateAbsolutePath("/home\n/etc"), null);
    });
});

describe("buildSftpCommandOption", () => {
    test("builds ssh command with port and option terminator", () => {
        assert.deepEqual(buildSftpCommandOption("sftp://backup@nas:2222//restic", "/etc/k"), [
            "-o", "sftp.command=ssh -i /etc/k -o StrictHostKeyChecking=accept-new -p 2222 -s -- backup@nas sftp",
        ]);
        assert.deepEqual(buildSftpCommandOption("sftp:nas:/restic", "/etc/k"), [
            "-o", "sftp.command=ssh -i /etc/k -o StrictHostKeyChecking=accept-new -s -- nas sftp",
        ]);
    });

    test("other repositories get no option", () => {
        assert.deepEqual(buildSftpCommandOption("/mnt/backup", "/etc/k"), []);
    });

    test("rejects unsafe key paths", () => {
        assert.throws(() => buildSftpCommandOption("sftp:nas:/restic", "/etc/k -oProxyCommand=x"));
    });
});

describe("systemd quoting", () => {
    test("exec arguments are quoted literally", () => {
        assert.equal(quoteSystemdExecArgument("/home/a b"), '"/home/a b"');
        assert.equal(quoteSystemdExecArgument('a"b\\c'), '"a\\"b\\\\c"');
        assert.equal(quoteSystemdExecArgument("100%$HOME${X}"), '"100%%$$HOME$${X}"');
        assert.throws(() => quoteSystemdExecArgument("a\nExecStart=/bin/x"));
    });

    test("environment lines do not double dollar signs", () => {
        assert.equal(systemdEnvironmentLine("B2_ACCOUNT_KEY", 'p$a"s%s'), 'Environment="B2_ACCOUNT_KEY=p$a\\"s%%s"');
        assert.throws(() => systemdEnvironmentLine("BAD NAME", "x"));
        assert.throws(() => systemdEnvironmentLine("KEY", "a\nb"));
    });

    test("free text stays on one line", () => {
        assert.equal(escapeSystemdText("Nightly 100%\n[Service]"), "Nightly 100%% [Service]");
        assert.equal(escapeSystemdText("Nightly\\"), "Nightly");
        assert.equal(escapeSystemdText("Nightly \\ \\\n"), "Nightly");
        assert.equal(escapeSystemdText("C:\\backup\\daily"), "C:\\backup\\daily");
    });
});
