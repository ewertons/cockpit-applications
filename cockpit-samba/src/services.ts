/** Host commands for services, logs and paths: argv builders and output parsing. */

import { PathInformation } from './warnings.js';

/** Units shown on the overview; samba-ad-dc is listed to detect a domain controller setup. */
export const SAMBA_UNITS = ["smbd.service", "nmbd.service", "samba-ad-dc.service"] as const;

export type SambaUnit = typeof SAMBA_UNITS[number];

export type UnitAction = "start" | "stop" | "restart" | "enable" | "disable";

export interface UnitState {
    unit: string;
    /** False when systemd does not know the unit (not installed). */
    installed: boolean;
    /** e.g. "active", "inactive", "failed". */
    activeState: string;
    subState: string;
    /** e.g. "enabled", "disabled", "masked". */
    unitFileState: string;
}

export const UNIT_PROPERTIES = ["Id", "LoadState", "ActiveState", "SubState", "UnitFileState"];

/** @returns argv printing the state of the Samba units, parsed by parseUnitStates. */
export function unitStatesCommand(): string[] {
    return ["systemctl", "show", `--property=${UNIT_PROPERTIES.join(",")}`, "--", ...SAMBA_UNITS];
}

/** @returns states from `systemctl show` output (blocks separated by blank lines). */
export function parseUnitStates(output: string): UnitState[] {
    const states: UnitState[] = [];
    for (const block of output.split(/\n\s*\n/)) {
        const properties: Record<string, string> = {};
        for (const line of block.split("\n")) {
            const separator = line.indexOf("=");
            if (separator > 0)
                properties[line.slice(0, separator)] = line.slice(separator + 1).trim();
        }
        if (!properties.Id)
            continue;
        states.push({
            unit: properties.Id,
            installed: properties.LoadState === "loaded",
            activeState: properties.ActiveState ?? "",
            subState: properties.SubState ?? "",
            unitFileState: properties.UnitFileState ?? "",
        });
    }
    return states;
}

/** @returns argv running a systemctl action on one of the Samba units. */
export function unitActionCommand(unit: string, action: UnitAction): string[] {
    if (!(SAMBA_UNITS as readonly string[]).includes(unit))
        throw new Error(`Unknown unit: ${unit}`);
    if (!["start", "stop", "restart", "enable", "disable"].includes(action))
        throw new Error(`Unknown action: ${action}`);
    return ["systemctl", action, "--", unit];
}

/** @returns argv reading the latest journal lines of smbd and nmbd. */
export function journalCommand(lineCount: number): string[] {
    const count = Math.max(1, Math.min(Math.trunc(lineCount) || 200, 5000));
    return ["journalctl", "--no-pager", "--output=short-iso", "--lines", String(count), "--unit", "smbd.service", "--unit", "nmbd.service"];
}

export const SAMBA_LOG_DIRECTORY = "/var/log/samba";

/** @returns argv listing log files in /var/log/samba as "<name>\t<size>\t<mtime>" lines. */
export function listLogFilesCommand(): string[] {
    return ["find", SAMBA_LOG_DIRECTORY, "-maxdepth", "1", "-type", "f", "-printf", "%f\\t%s\\t%T@\\n"];
}

export interface LogFile {
    name: string;
    size: number;
    modifiedAt: Date;
}

/** Log file names written by Samba (log.smbd, log.192.168.1.5, log.nmbd.1, cores excluded). */
const LOG_FILE_PATTERN = /^log\.[A-Za-z0-9_.:-]+$/;

/** @returns log files from listLogFilesCommand output, most recently modified first. */
export function parseLogFiles(output: string): LogFile[] {
    return output.split("\n").map(line => line.split("\t"))
            .filter(([name]) => name && LOG_FILE_PATTERN.test(name))
            .map(([name, size, modified]) => ({ name, size: Number(size) || 0, modifiedAt: new Date(Number(modified) * 1000) }))
            .sort((first, second) => second.modifiedAt.getTime() - first.modifiedAt.getTime());
}

/** @returns argv printing the end of one Samba log file. */
export function tailLogFileCommand(name: string, lineCount: number): string[] {
    if (!LOG_FILE_PATTERN.test(name) || name.includes(".."))
        throw new Error(`Invalid log file name: ${name}`);
    const count = Math.max(1, Math.min(Math.trunc(lineCount) || 200, 5000));
    return ["tail", "-n", String(count), "--", `${SAMBA_LOG_DIRECTORY}/${name}`];
}

/** @returns argv printing owner, group, octal mode and type of a share path. */
export function pathInformationCommand(path: string): string[] {
    if (!path.startsWith("/"))
        throw new Error(`Not an absolute path: ${path}`);
    return ["stat", "--format=%U\t%G\t%a\t%F", "--", path];
}

/** @returns argv creating a share directory (and missing parents). */
export function createDirectoryCommand(path: string): string[] {
    if (!path.startsWith("/") || path.split("/").includes(".."))
        throw new Error(`Not an absolute path: ${path}`);
    return ["mkdir", "-p", "--", path];
}

/** @returns path information from pathInformationCommand output, or a non-existing entry. */
export function parsePathInformation(output: string | null): PathInformation {
    const [owner, group, mode, type] = (output ?? "").trim().split("\t");
    if (!owner || !mode || !/^[0-7]{3,4}$/.test(mode))
        return { exists: false, owner: "", group: "", mode: "", isDirectory: false };
    return { exists: true, owner, group, mode: mode.padStart(4, "0"), isDirectory: type === "directory" };
}
