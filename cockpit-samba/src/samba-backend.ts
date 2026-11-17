/**
 * Privileged host operations. Every command is a fixed argv array built in
 * accounts.ts, services.ts or status.ts, or a constant script from
 * transaction.ts; user data only travels as validated arguments after "--",
 * or on stdin (configuration text, passwords), never as shell text.
 */

import cockpit from 'cockpit';

import {
    LinuxAccount,
    SambaUser,
    addSambaUserCommand,
    createSystemUserCommand,
    deleteSambaUserCommand,
    parseGetent,
    parsePdbeditVerbose,
    passwordInput,
    setSambaPasswordCommand,
    setSambaUserEnabledCommand,
} from './accounts.js';
import {
    LogFile,
    UnitAction,
    UnitState,
    createDirectoryCommand,
    journalCommand,
    listLogFilesCommand,
    parseLogFiles,
    parsePathInformation,
    parseUnitStates,
    pathInformationCommand,
    tailLogFileCommand,
    unitActionCommand,
    unitStatesCommand,
} from './services.js';
import { SambaStatus, disconnectSessionCommand, parseSambaStatus, sambaStatusCommand } from './status.js';
import {
    ApplyResult,
    BACKUP_NAME_PATTERN,
    BackupEntry,
    ConfigurationSnapshot,
    DEFAULT_PATHS,
    ExitCode,
    TestparmResult,
    applyScriptText,
    checkScriptText,
    listBackupsScriptText,
    parseApplyOutput,
    parseBackupList,
    parseCheckOutput,
    parseSnapshot,
    parseTestparmDiagnostics,
    snapshotScriptText,
} from './transaction.js';
import { PathInformation } from './warnings.js';

const PRIVILEGED = { superuser: "require", err: "message" } as const;

/** @returns a readable message from a cockpit error or exception. */
export function errorMessage(error: unknown): string {
    if (error && typeof error === "object" && "message" in error)
        return String((error as { message: unknown }).message);
    return String(error);
}

async function run(command: string[], input?: string): Promise<string> {
    try {
        const process = cockpit.spawn(command, PRIVILEGED);
        return await (input === undefined ? process : process.input(input));
    } catch (error) {
        throw new Error(errorMessage(error));
    }
}

/** @returns the current smb.conf with its hash (for change detection on apply). */
export async function readConfiguration(): Promise<ConfigurationSnapshot> {
    return parseSnapshot(await cockpit.script(snapshotScriptText(), [], PRIVILEGED));
}

/** @returns testparm's verdict on candidate text, without changing anything. */
export async function checkConfiguration(candidate: string): Promise<TestparmResult> {
    return parseCheckOutput(await cockpit.script(checkScriptText(), [], PRIVILEGED).input(candidate));
}

/** Raised when apply is refused; `kind` tells why. */
export class ApplyError extends Error {
    kind: "rejected" | "changed" | "failed";
    testparm: TestparmResult | null;

    constructor(kind: "rejected" | "changed" | "failed", message: string, testparm: TestparmResult | null = null) {
        super(message);
        this.kind = kind;
        this.testparm = testparm;
    }
}

/**
 * Validates `candidate` with testparm, backs up the current file, replaces it
 * and reloads smbd/nmbd.
 * @param expectedHash hash of the snapshot the user edited.
 * @throws ApplyError when testparm rejects the file, the file changed meanwhile, or writing failed.
 */
export async function applyConfiguration(candidate: string, expectedHash: string): Promise<ApplyResult> {
    try {
        return parseApplyOutput(await cockpit.script(applyScriptText(), [expectedHash], PRIVILEGED).input(candidate));
    } catch (error) {
        const status = (error as { exit_status?: number | null })?.exit_status;
        const message = errorMessage(error);
        if (status === ExitCode.testparmFailed)
            throw new ApplyError("rejected", "testparm rejected the new configuration; nothing was changed.", parseTestparmDiagnostics(message, false));
        if (status === ExitCode.changedElsewhere)
            throw new ApplyError("changed", message);
        throw new ApplyError("failed", message);
    }
}

/** @returns backups of smb.conf, newest first. */
export async function listBackups(): Promise<BackupEntry[]> {
    return parseBackupList(await cockpit.script(listBackupsScriptText(), [], PRIVILEGED));
}

/** @returns the content of one backup. */
export async function readBackup(name: string): Promise<string> {
    if (!BACKUP_NAME_PATTERN.test(name))
        throw new Error(`Invalid backup name: ${name}`);
    return (await cockpit.file(`${DEFAULT_PATHS.backupDirectory}/${name}`, { superuser: "require" }).read()) ?? "";
}

/** @returns states of smbd, nmbd and samba-ad-dc. */
export async function readUnitStates(): Promise<UnitState[]> {
    return parseUnitStates(await cockpit.spawn(unitStatesCommand(), { err: "message" }));
}

export async function runUnitAction(unit: string, action: UnitAction): Promise<void> {
    await run(unitActionCommand(unit, action));
}

/** @returns the first line of `smbd --version`, or "" when smbd is not installed. */
export async function readSambaVersion(): Promise<string> {
    try {
        return (await cockpit.spawn(["/usr/sbin/smbd", "--version"], { err: "ignore" })).trim();
    } catch {
        return "";
    }
}

export async function readSambaStatus(): Promise<SambaStatus> {
    return parseSambaStatus(await run(sambaStatusCommand()));
}

export async function disconnectSession(processId: number): Promise<void> {
    await run(disconnectSessionCommand(processId));
}

export async function listSambaUsers(): Promise<SambaUser[]> {
    return parsePdbeditVerbose(await run(["pdbedit", "-L", "-v"]));
}

export async function listLinuxUsers(): Promise<LinuxAccount[]> {
    return parseGetent(await cockpit.spawn(["getent", "passwd"], { err: "message" }), "passwd");
}

export async function listLinuxGroups(): Promise<LinuxAccount[]> {
    return parseGetent(await cockpit.spawn(["getent", "group"], { err: "message" }), "group");
}

/** Creates a Linux system user without login shell or home, for Samba-only access. */
export async function createSystemUser(userName: string): Promise<void> {
    await run(createSystemUserCommand(userName));
}

/** Adds a Samba account for an existing Linux user. */
export async function addSambaUser(userName: string, password: string): Promise<void> {
    await run(addSambaUserCommand(userName), passwordInput(password));
}

export async function setSambaPassword(userName: string, password: string): Promise<void> {
    await run(setSambaPasswordCommand(userName), passwordInput(password));
}

export async function setSambaUserEnabled(userName: string, enabled: boolean): Promise<void> {
    await run(setSambaUserEnabledCommand(userName, enabled));
}

export async function deleteSambaUser(userName: string): Promise<void> {
    await run(deleteSambaUserCommand(userName));
}

/** @returns information about a share path; a missing path gives `exists: false`. */
export async function readPathInformation(path: string): Promise<PathInformation> {
    try {
        return parsePathInformation(await cockpit.spawn(pathInformationCommand(path), { superuser: "try", err: "ignore" }));
    } catch {
        return parsePathInformation(null);
    }
}

export async function createDirectory(path: string): Promise<void> {
    await run(createDirectoryCommand(path));
}

/** @returns information for every distinct path, keyed by path. */
export async function readPathsInformation(paths: string[]): Promise<Record<string, PathInformation>> {
    const unique = [...new Set(paths.filter(path => path.startsWith("/")))];
    const entries = await Promise.all(unique.map(async path => [path, await readPathInformation(path)] as const));
    return Object.fromEntries(entries);
}

export async function readJournal(lineCount: number): Promise<string> {
    return await run(journalCommand(lineCount));
}

export async function listLogFiles(): Promise<LogFile[]> {
    try {
        return parseLogFiles(await run(listLogFilesCommand()));
    } catch {
        return [];
    }
}

export async function readLogFile(name: string, lineCount: number): Promise<string> {
    return await run(tailLogFileCommand(name, lineCount));
}
