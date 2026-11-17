/** Samba user accounts (pdbedit/smbpasswd) and Linux users and groups (getent): parsing and command lines. */

import { isValidLinuxName, validateNewUserName } from './validation.js';

export interface SambaUser {
    userName: string;
    fullName: string;
    /** Account flags without brackets, e.g. "U" or "DU". */
    flags: string;
    disabled: boolean;
    passwordLastSet: string;
}

/** @returns users from `pdbedit -L -v` output. */
export function parsePdbeditVerbose(output: string): SambaUser[] {
    const users: SambaUser[] = [];
    for (const block of output.split(/^-{3,}\s*$/m)) {
        const fields: Record<string, string> = {};
        for (const line of block.split("\n")) {
            const separator = line.indexOf(":");
            if (separator > 0)
                fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
        }
        const userName = fields["Unix username"];
        if (!userName)
            continue;
        const flags = (fields["Account Flags"] ?? "").replace(/[[\]\s]/g, "");
        users.push({
            userName,
            fullName: fields["Full Name"] ?? "",
            flags,
            disabled: flags.includes("D"),
            passwordLastSet: fields["Password last set"] ?? "",
        });
    }
    return users;
}

export interface LinuxAccount {
    name: string;
    id: number;
    /** Group members (groups only). */
    members: string[];
    /** Login shell (users only). */
    shell: string;
}

/** @returns entries of `getent passwd` or `getent group` output. */
export function parseGetent(output: string, database: "passwd" | "group"): LinuxAccount[] {
    const accounts: LinuxAccount[] = [];
    for (const line of output.split("\n")) {
        const fields = line.split(":");
        if (fields.length < 4 || !fields[0])
            continue;
        accounts.push({
            name: fields[0],
            id: Number(fields[2]),
            members: database === "group" ? fields[3].split(",").filter(Boolean) : [],
            shell: database === "passwd" ? (fields[6] ?? "") : "",
        });
    }
    return accounts;
}

function requireExistingName(userName: string): void {
    if (!isValidLinuxName(userName))
        throw new Error(`Invalid user name: ${userName}`);
}

/** @returns argv creating a Linux system user that cannot log in, for Samba-only accounts. */
export function createSystemUserCommand(userName: string): string[] {
    const problem = validateNewUserName(userName);
    if (problem)
        throw new Error(problem);
    return ["useradd", "--system", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", "--", userName];
}

/** @returns argv adding a Samba account; the password is written twice on stdin (see passwordInput). */
export function addSambaUserCommand(userName: string): string[] {
    requireExistingName(userName);
    return ["smbpasswd", "-s", "-a", userName];
}

/** @returns argv setting a Samba password as root (no old password needed); input as for addSambaUserCommand. */
export function setSambaPasswordCommand(userName: string): string[] {
    requireExistingName(userName);
    return ["smbpasswd", "-s", userName];
}

/** @returns argv enabling or disabling a Samba account. */
export function setSambaUserEnabledCommand(userName: string, enabled: boolean): string[] {
    requireExistingName(userName);
    return ["smbpasswd", enabled ? "-e" : "-d", userName];
}

/** @returns argv deleting a Samba account (the Linux user is kept). */
export function deleteSambaUserCommand(userName: string): string[] {
    requireExistingName(userName);
    return ["smbpasswd", "-x", userName];
}

/** @returns the stdin for smbpasswd -s: the new password twice. */
export function passwordInput(password: string): string {
    return `${password}\n${password}\n`;
}
