import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
    ABSENT_HASH,
    BACKUPS_KEPT,
    ExitCode,
    TransactionPaths,
    applyScriptText,
    checkScriptText,
    listBackupsScriptText,
    parseApplyOutput,
    parseBackupList,
    parseCheckOutput,
    parseSnapshot,
    parseTestparmDiagnostics,
    snapshotScriptText,
} from "../../src/transaction.ts";

// testparm stub: rejects files containing "INVALID", reports "bogus" lines as unknown parameters.
const TESTPARM_STUB = `#!/bin/sh
file="$2"
echo "Load smb config files from $file" >&2
if grep -q INVALID "$file"; then
    echo "ERROR: Invalid value for parameter" >&2
    exit 1
fi
if grep -q '^ *bogus' "$file"; then
    echo 'Unknown parameter encountered: "bogus"' >&2
    echo 'Ignoring unknown parameter "bogus"' >&2
fi
echo "Loaded services file OK." >&2
echo "Server role: ROLE_STANDALONE" >&2
cat "$file"
`;

// smbcontrol stub: $SMBCONTROL_MODE is "running", "stopped" or "reload-fails"; calls are logged.
const SMBCONTROL_STUB = `#!/bin/sh
echo "$*" >> "$SMBCONTROL_LOG"
case "$SMBCONTROL_MODE:$3" in
    stopped:*) exit 1 ;;
    reload-fails:reload-config) exit 1 ;;
esac
exit 0
`;

let root: string;
let paths: TransactionPaths;

function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function runScript(script: string, input: string, args: string[] = [], smbcontrolMode = "running") {
    const result = spawnSync("/bin/sh", ["-c", script, "sh", ...args], {
        input,
        encoding: "utf8",
        env: {
            PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
            SMBCONTROL_MODE: smbcontrolMode,
            SMBCONTROL_LOG: path.join(root, "smbcontrol.log"),
        },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeConfiguration(text: string, mode = 0o644) {
    fs.writeFileSync(paths.configurationPath, text);
    fs.chmodSync(paths.configurationPath, mode);
}

function backupNames(): string[] {
    return fs.existsSync(paths.backupDirectory) ? fs.readdirSync(paths.backupDirectory).sort() : [];
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-samba-transaction-"));
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, "etc"));
    fs.writeFileSync(path.join(root, "bin", "testparm"), TESTPARM_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(root, "bin", "smbcontrol"), SMBCONTROL_STUB, { mode: 0o755 });
    paths = {
        configurationPath: path.join(root, "etc", "smb.conf"),
        backupDirectory: path.join(root, "backups"),
        stateDirectory: path.join(root, "run"),
    };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const OLD = "[global]\n\tworkgroup = OLD\n";
const NEW = "# kept comment\n[global]\n\tworkgroup = NEW\n";

describe("snapshot", () => {
    test("absent file", () => {
        const snapshot = parseSnapshot(runScript(snapshotScriptText(paths), "").stdout);
        assert.deepEqual(snapshot, { exists: false, hash: ABSENT_HASH, text: "" });
    });

    test("present file keeps its exact text and hash", () => {
        writeConfiguration("[global]\n\tx = 1\n\n\n");
        const snapshot = parseSnapshot(runScript(snapshotScriptText(paths), "").stdout);
        assert.equal(snapshot.exists, true);
        assert.equal(snapshot.text, "[global]\n\tx = 1\n\n\n");
        assert.equal(snapshot.hash, sha256(snapshot.text));
    });

    test("unexpected output is an error", () => {
        assert.throws(() => parseSnapshot("garbage\n"));
    });
});

describe("check", () => {
    test("accepted candidate with unknown parameter", () => {
        const result = runScript(checkScriptText(paths), "[global]\n bogus = 1\n");
        assert.equal(result.status, 0);
        assert.deepEqual(parseCheckOutput(result.stdout), { passed: true, unknownParameters: ["bogus"], messages: [] });
    });

    test("rejected candidate", () => {
        const check = parseCheckOutput(runScript(checkScriptText(paths), "INVALID\n").stdout);
        assert.equal(check.passed, false);
        assert.deepEqual(check.messages, ["ERROR: Invalid value for parameter"]);
    });

    test("leaves no temporary files and never touches smb.conf", () => {
        writeConfiguration(OLD);
        runScript(checkScriptText(paths), NEW);
        assert.deepEqual(fs.readdirSync(paths.stateDirectory), []);
        assert.equal(fs.readFileSync(paths.configurationPath, "utf8"), OLD);
    });
});

describe("apply", () => {
    test("replaces the file, keeps a backup, preserves the mode and reloads", () => {
        writeConfiguration(OLD, 0o640);
        const result = runScript(applyScriptText(paths), NEW, [sha256(OLD)]);
        assert.equal(result.status, 0, result.stderr);
        const applied = parseApplyOutput(result.stdout);
        assert.equal(fs.readFileSync(paths.configurationPath, "utf8"), NEW);
        assert.equal(fs.statSync(paths.configurationPath).mode & 0o777, 0o640);
        assert.match(applied.backupName!, /^smb\.conf\.\d{8}-\d{6}$/);
        assert.equal(fs.readFileSync(path.join(paths.backupDirectory, applied.backupName!), "utf8"), OLD);
        assert.deepEqual(applied.reloads, [{ daemon: "smbd", state: "ok" }, { daemon: "nmbd", state: "ok" }]);
        assert.deepEqual(fs.readdirSync(path.join(root, "etc")), ["smb.conf"]);
        const calls = fs.readFileSync(path.join(root, "smbcontrol.log"), "utf8");
        assert.match(calls, /smbd reload-config/);
        assert.ok(calls.includes(`--configfile=${paths.configurationPath}`));
    });

    test("rejected candidate leaves the file and backups untouched", () => {
        writeConfiguration(OLD);
        const result = runScript(applyScriptText(paths), "[global]\nINVALID\n", [sha256(OLD)]);
        assert.equal(result.status, ExitCode.testparmFailed);
        assert.match(result.stderr, /ERROR: Invalid value/);
        assert.equal(fs.readFileSync(paths.configurationPath, "utf8"), OLD);
        assert.deepEqual(backupNames(), []);
        assert.deepEqual(fs.readdirSync(path.join(root, "etc")), ["smb.conf"]);
        assert.equal(fs.existsSync(path.join(root, "smbcontrol.log")), false);
    });

    test("refuses when the file changed since it was read", () => {
        writeConfiguration(OLD);
        const result = runScript(applyScriptText(paths), NEW, [sha256("something else")]);
        assert.equal(result.status, ExitCode.changedElsewhere);
        assert.equal(fs.readFileSync(paths.configurationPath, "utf8"), OLD);
        assert.equal(runScript(applyScriptText(paths), NEW, []).status, ExitCode.changedElsewhere);
    });

    test("creates a missing file without a backup", () => {
        const result = runScript(applyScriptText(paths), NEW, [ABSENT_HASH], "stopped");
        assert.equal(result.status, 0, result.stderr);
        const applied = parseApplyOutput(result.stdout);
        assert.equal(applied.backupName, null);
        assert.equal(fs.statSync(paths.configurationPath).mode & 0o777, 0o644);
        assert.deepEqual(applied.reloads, [{ daemon: "smbd", state: "not-running" }, { daemon: "nmbd", state: "not-running" }]);
        assert.equal(runScript(applyScriptText(paths), NEW, [ABSENT_HASH]).status, ExitCode.changedElsewhere);
    });

    test("reports a failed reload but keeps the new file", () => {
        writeConfiguration(OLD);
        const applied = parseApplyOutput(runScript(applyScriptText(paths), NEW, [sha256(OLD)], "reload-fails").stdout);
        assert.deepEqual(applied.reloads.map(reload => reload.state), ["failed", "failed"]);
        assert.equal(fs.readFileSync(paths.configurationPath, "utf8"), NEW);
    });

    test("passes testparm messages through", () => {
        writeConfiguration(OLD);
        const applied = parseApplyOutput(runScript(applyScriptText(paths), "[global]\n bogus = 1\n", [sha256(OLD)]).stdout);
        assert.deepEqual(applied.testparm.unknownParameters, ["bogus"]);
    });

    test("backups in the same second get distinct names", () => {
        writeConfiguration(OLD);
        let text = OLD;
        for (const next of ["[a]\n", "[b]\n", "[c]\n"]) {
            assert.equal(runScript(applyScriptText(paths), next, [sha256(text)]).status, 0);
            text = next;
        }
        assert.equal(backupNames().length, 3);
        assert.equal(new Set(backupNames()).size, 3);
    });

    test(`keeps only the newest ${BACKUPS_KEPT} backups`, () => {
        fs.mkdirSync(paths.backupDirectory);
        for (let index = 0; index < BACKUPS_KEPT + 5; index++)
            fs.writeFileSync(path.join(paths.backupDirectory, `smb.conf.2001010${Math.floor(index / 10)}-0000${String(index % 10).padStart(2, "0")}`), "old");
        fs.writeFileSync(path.join(paths.backupDirectory, "unrelated"), "keep");
        writeConfiguration(OLD);
        const applied = parseApplyOutput(runScript(applyScriptText(paths), NEW, [sha256(OLD)]).stdout);
        const names = backupNames();
        assert.equal(names.filter(name => name.startsWith("smb.conf.")).length, BACKUPS_KEPT);
        assert.ok(names.includes(applied.backupName!));
        assert.ok(names.includes("unrelated"));
        assert.ok(!names.includes("smb.conf.20010100-000000"));
    });
});

describe("backups", () => {
    test("listing is newest first and skips unknown names", () => {
        fs.mkdirSync(paths.backupDirectory);
        for (const name of ["smb.conf.20240101-101010", "smb.conf.20240101-101010-2", "smb.conf.20231231-235959", "notes.txt"])
            fs.writeFileSync(path.join(paths.backupDirectory, name), "abc");
        const entries = parseBackupList(runScript(listBackupsScriptText(paths), "").stdout);
        assert.deepEqual(entries.map(entry => entry.name), ["smb.conf.20240101-101010-2", "smb.conf.20240101-101010", "smb.conf.20231231-235959"]);
        assert.equal(entries[0].size, 3);
        assert.equal(entries[2].createdAt.getUTCFullYear(), 2023);
        assert.equal(entries[2].createdAt.toISOString(), "2023-12-31T23:59:59.000Z");
    });

    test("missing directory lists nothing", () => {
        const result = runScript(listBackupsScriptText(paths), "");
        assert.equal(result.status, 0);
        assert.deepEqual(parseBackupList(result.stdout), []);
    });
});

test("routine testparm lines are dropped", () => {
    const result = parseTestparmDiagnostics("Load smb config files from /x\nWARNING: The \"syslog\" option is deprecated\nLoaded services file OK.\n", true);
    assert.deepEqual(result.messages, ["WARNING: The \"syslog\" option is deprecated"]);
});
