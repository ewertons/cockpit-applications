// Runs the apply flow against the installed Samba: real testparm, and a real
// unprivileged smbd for the reload. Requires samba (smbd, testparm, smbcontrol).
import assert from "node:assert/strict";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { parseConfiguration, serializeConfiguration, setParameter, addSection } from "../../src/smb-conf.ts";
import {
    ExitCode,
    TransactionPaths,
    applyScriptText,
    checkScriptText,
    listBackupsScriptText,
    parseApplyOutput,
    parseBackupList,
    parseCheckOutput,
    parseSnapshot,
    snapshotScriptText,
} from "../../src/transaction.ts";

const PORT = 44551;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-samba-real-"));
const paths: TransactionPaths = {
    configurationPath: path.join(root, "smb.conf"),
    backupDirectory: path.join(root, "backups"),
    stateDirectory: path.join(root, "run"),
};

const INITIAL = `# Test server
[global]
   workgroup = TESTGROUP
   lock directory = ${root}/lock
   state directory = ${root}/state
   cache directory = ${root}/cache
   pid directory = ${root}/pid
   private dir = ${root}/private
   ncalrpc dir = ${root}/ncalrpc
   log file = ${root}/log.%m
   smb ports = ${PORT}
   interfaces = lo
   bind interfaces only = yes
   disable netbios = yes

; data share
[data]
   path = ${root}/data
   writeable = yes
`;

function runScript(script: string, input: string, args: string[] = []) {
    return spawnSync("/bin/sh", ["-c", script, "sh", ...args], { input, encoding: "utf8" });
}

function snapshot() {
    return parseSnapshot(runScript(snapshotScriptText(paths), "").stdout);
}

function effectiveValue(sectionName: string, parameterName: string): string {
    const result = spawnSync("testparm", ["-s", `--section-name=${sectionName}`, `--parameter-name=${parameterName}`, paths.configurationPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function smbdResponds(): boolean {
    return spawnSync("smbcontrol", [`--configfile=${paths.configurationPath}`, "smbd", "ping"], { encoding: "utf8" }).status === 0;
}

let smbd: ChildProcess | undefined;

before(async () => {
    for (const directory of ["lock", "state", "cache", "pid", "private", "ncalrpc", "data"])
        fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(paths.configurationPath, INITIAL);
    // Own process group: smbd signals its whole group when it stops.
    smbd = spawn("smbd", ["-s", paths.configurationPath, "--foreground", "--no-process-group", "--debug-stdout", "-d0"], { stdio: "ignore", detached: true });
    for (let attempt = 0; attempt < 50 && !smbdResponds(); attempt++)
        await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(smbdResponds(), "smbd did not start");
});

after(() => {
    smbd?.kill();
    fs.rmSync(root, { recursive: true, force: true });
});

describe("real Samba", () => {
    test("testparm accepts the unchanged file", () => {
        const result = parseCheckOutput(runScript(checkScriptText(paths), INITIAL).stdout);
        assert.equal(result.passed, true, result.messages.join("\n"));
    });

    test("edits keep synonyms consistent with Samba's own reading", () => {
        const current = snapshot();
        let document = parseConfiguration(current.text);
        document = setParameter(document, "data", "read only", "yes");
        document = setParameter(document, "global", "server min protocol", "NT1");
        document = addSection(document, "scans");
        document = setParameter(document, "scans", "path", path.join(root, "data"));
        document = setParameter(document, "scans", "writable", "yes");
        document = setParameter(document, "scans", "hosts allow", "127.0.0.1");
        const candidate = serializeConfiguration(document);
        assert.match(candidate, /^; data share$/m);
        assert.match(candidate, /^ {3}writeable = no$/m);

        const output = runScript(applyScriptText(paths), candidate, [current.hash]);
        assert.equal(output.status, 0, output.stderr);
        const applied = parseApplyOutput(output.stdout);
        assert.ok(applied.backupName);
        assert.deepEqual(applied.reloads.find(reload => reload.daemon === "smbd")?.state, "ok");

        assert.equal(fs.readFileSync(paths.configurationPath, "utf8"), candidate);
        assert.equal(effectiveValue("data", "read only"), "Yes");
        assert.equal(effectiveValue("scans", "read only"), "No");
        assert.equal(effectiveValue("global", "server min protocol"), "NT1");
        assert.equal(fs.readFileSync(path.join(paths.backupDirectory, applied.backupName), "utf8"), INITIAL);
    });

    for (const [title, mutate] of [
        ["an invalid enum value", (text: string) => text.replace("workgroup = TESTGROUP", "workgroup = TESTGROUP\n   server signing = sometimes")],
        ["a non-boolean value", (text: string) => text.replace("bind interfaces only = yes", "bind interfaces only = perhaps")],
        ["an unclosed section header", (text: string) => text + "[broken\n"],
    ] as const) {
        test(`${title} is rejected and smb.conf stays untouched`, () => {
            const current = snapshot();
            const backupsBefore = parseBackupList(runScript(listBackupsScriptText(paths), "").stdout);
            const candidate = mutate(current.text);

            assert.equal(parseCheckOutput(runScript(checkScriptText(paths), candidate).stdout).passed, false);
            const output = runScript(applyScriptText(paths), candidate, [current.hash]);
            assert.equal(output.status, ExitCode.testparmFailed);
            assert.equal(fs.readFileSync(paths.configurationPath, "utf8"), current.text);
            assert.deepEqual(parseBackupList(runScript(listBackupsScriptText(paths), "").stdout), backupsBefore);
            assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith(".smb.conf")), []);
            assert.ok(smbdResponds());
        });
    }

    test("unknown parameters pass testparm and are reported", () => {
        const result = parseCheckOutput(runScript(checkScriptText(paths), snapshot().text + "   frobnicate level = 3\n").stdout);
        assert.equal(result.passed, true);
        assert.deepEqual(result.unknownParameters, ["frobnicate level"]);
    });

    test("restoring a backup brings back the original file", () => {
        const [backup] = parseBackupList(runScript(listBackupsScriptText(paths), "").stdout);
        const content = fs.readFileSync(path.join(paths.backupDirectory, backup.name), "utf8");
        const output = runScript(applyScriptText(paths), content, [snapshot().hash]);
        assert.equal(output.status, 0, output.stderr);
        assert.equal(fs.readFileSync(paths.configurationPath, "utf8"), INITIAL);
        assert.equal(effectiveValue("data", "read only"), "No");
    });
});
