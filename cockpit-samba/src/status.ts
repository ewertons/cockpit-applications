/** Parsing of `smbstatus --json` (Samba 4.16+): sessions, share connections, open files and byte-range locks. */

import { isSmb1OrOlder } from './parameters.js';

export interface SambaSession {
    sessionId: string;
    /** smbd process serving the client; disconnecting stops it. */
    processId: number;
    userName: string;
    groupName: string;
    remoteMachine: string;
    /** Client address and port as reported, e.g. "ipv4:192.168.1.5:50432". */
    clientAddress: string;
    /** Negotiated dialect, e.g. "SMB3_11" or "NT1". */
    dialect: string;
    isSmb1: boolean;
    encryption: string;
    signing: string;
    /** Shares this session is connected to. */
    shares: string[];
}

export interface OpenFile {
    path: string;
    sharePath: string;
    fileName: string;
    processId: number;
    userId: number;
    /** e.g. "RW". */
    access: string;
    /** Share mode allowed to others, e.g. "RW". */
    shareMode: string;
    oplock: string;
    openedAt: string;
}

export interface ByteRangeLock {
    path: string;
    processId: number;
    /** "R" or "W". */
    type: string;
    flavour: string;
    start: number;
    size: number;
}

export interface SambaStatus {
    version: string;
    sessions: SambaSession[];
    openFiles: OpenFile[];
    locks: ByteRangeLock[];
}

type JsonObject = Record<string, any>;

function objectValues(value: unknown): JsonObject[] {
    return value && typeof value === "object" ? Object.values(value as JsonObject).filter(item => item && typeof item === "object") : [];
}

function processIdOf(item: JsonObject): number {
    return Number(item?.server_id?.pid ?? 0) || 0;
}

/** @returns the cipher and degree as one label, e.g. "AES-128-GMAC (partial)" or "-". */
function protectionLabel(protection: JsonObject | undefined): string {
    if (!protection || !protection.cipher || protection.cipher === "-")
        return "-";
    return protection.degree ? `${protection.cipher} (${protection.degree})` : String(protection.cipher);
}

function oplockLabel(open: JsonObject): string {
    const lease = open.lease && typeof open.lease === "object" ? open.lease : {};
    if (lease.text)
        return `lease ${lease.text}`;
    const oplock = open.oplock && typeof open.oplock === "object" ? open.oplock : {};
    return oplock.text ? String(oplock.text) : "none";
}

/**
 * @returns the parsed status. Accepts output of `smbstatus --json` with or
 * without -B; missing sections give empty lists.
 * @throws SyntaxError when the text is not JSON.
 */
export function parseSambaStatus(text: string): SambaStatus {
    const root = JSON.parse(text) as JsonObject;
    const connections = objectValues(root.tcons);

    const sessions: SambaSession[] = objectValues(root.sessions).map(session => {
        const sessionId = String(session.session_id ?? "");
        const dialect = String(session.session_dialect ?? "");
        return {
            sessionId,
            processId: processIdOf(session),
            userName: String(session.username ?? ""),
            groupName: String(session.groupname ?? ""),
            remoteMachine: String(session.remote_machine ?? ""),
            clientAddress: String(session.hostname ?? ""),
            dialect,
            isSmb1: isSmb1OrOlder(dialect),
            encryption: protectionLabel(session.encryption),
            signing: protectionLabel(session.signing),
            shares: connections.filter(connection => String(connection.session_id) === sessionId)
                    .map(connection => String(connection.service ?? "")),
        };
    });

    const openFiles: OpenFile[] = [];
    for (const [path, file] of Object.entries((root.open_files ?? {}) as JsonObject)) {
        for (const open of objectValues(file?.opens)) {
            openFiles.push({
                path,
                sharePath: String(file.service_path ?? ""),
                fileName: String(file.filename ?? ""),
                processId: processIdOf(open),
                userId: Number(open.uid ?? -1),
                access: String(open.access_mask?.text ?? ""),
                shareMode: String(open.sharemode?.text ?? ""),
                oplock: oplockLabel(open),
                openedAt: String(open.opened_at ?? ""),
            });
        }
    }

    const locks: ByteRangeLock[] = [];
    for (const [path, file] of Object.entries((root.byte_range_locks ?? {}) as JsonObject)) {
        for (const lock of Array.isArray(file?.locks) ? file.locks : []) {
            locks.push({
                path,
                processId: processIdOf(lock),
                type: String(lock.type ?? ""),
                flavour: String(lock.flavour ?? ""),
                start: Number(lock.start ?? 0),
                size: Number(lock.size ?? 0),
            });
        }
    }

    return { version: String(root.version ?? ""), sessions, openFiles, locks };
}

/** @returns argv of the smbstatus call parsed by parseSambaStatus. */
export function sambaStatusCommand(): string[] {
    return ["smbstatus", "--json", "-B"];
}

/** @returns argv stopping the smbd process serving one client, which disconnects it. */
export function disconnectSessionCommand(processId: number): string[] {
    if (!Number.isInteger(processId) || processId <= 1)
        throw new Error(`Invalid process ID: ${processId}`);
    return ["smbcontrol", String(processId), "shutdown"];
}
