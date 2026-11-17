/**
 * Security warnings for a configuration. They inform; nothing is blocked,
 * because some legitimate setups (e.g. scanners that only speak SMB1) need them.
 */

import { effectiveShareBoolean, effectiveShareValue, isShareEnabled, listShareNames } from './model.js';
import { isSmb1OrOlder, parseBoolean } from './parameters.js';
import { ConfigurationDocument, GLOBAL_SECTION, getParameter } from './smb-conf.js';

export type WarningSeverity = "danger" | "warning" | "info";

export interface SecurityWarning {
    /** Stable identifier, e.g. "smb1" or "guest-share". */
    code: string;
    severity: WarningSeverity;
    /** Share the warning is about, or null for global settings. */
    share: string | null;
    message: string;
    /** Suggested mitigations. */
    mitigations: string[];
}

/** Owner/group/mode of a share path, as read from the host. */
export interface PathInformation {
    exists: boolean;
    /** Octal permission bits, e.g. "2775". */
    mode: string;
    owner: string;
    group: string;
    isDirectory: boolean;
}

function isWorldWritableMask(mask: string): boolean {
    if (!/^0?[0-7]{3,4}$/.test(mask.trim()))
        return false;
    return (parseInt(mask.trim(), 8) & 0o002) !== 0;
}

/** @returns whether the octal mode is writable by others without the sticky bit protecting it. */
export function isWorldWritableMode(mode: string): boolean {
    if (!/^[0-7]{3,4}$/.test(mode))
        return false;
    return (parseInt(mode, 8) & 0o002) !== 0;
}

/** Share names whose access is controlled by Samba itself ([homes] maps to the connecting user). */
const SELF_RESTRICTED_SHARES = ["homes"];

/** Built-in printer shares; a missing valid users list is normal there. */
const PRINTER_SHARES = ["printers", "print$"];

/**
 * @returns the security warnings for the configuration.
 * @param paths share path information keyed by path, when available.
 */
export function securityWarnings(document: ConfigurationDocument, paths: Record<string, PathInformation> = {}): SecurityWarning[] {
    const warnings: SecurityWarning[] = [];
    const global = (parameter: string) => getParameter(document, GLOBAL_SECTION, parameter);
    const globalHostsAllow = global("hosts allow") ?? "";

    const minimumProtocol = global("server min protocol") ?? "SMB2_02";
    if (isSmb1OrOlder(minimumProtocol)) {
        const mitigations = [
            "Allow SMB1 only while a device needs it, and only for that device: set \"hosts allow\" (globally or on its share) to its IP address.",
            "Give the device a dedicated Samba user with a strong password, and a dedicated share only that user can write to.",
            "Keep the server off untrusted networks: \"interfaces\" with \"bind interfaces only = yes\".",
        ];
        if (globalHostsAllow === "")
            mitigations.unshift("No global \"hosts allow\" is set: every host on the network can negotiate SMB1.");
        warnings.push({
            code: "smb1",
            severity: "danger",
            share: null,
            message: `SMB1 is enabled (server min protocol = ${minimumProtocol}). SMB1 is obsolete and has known, actively exploited weaknesses.`,
            mitigations,
        });
    }

    const ntlm = (global("ntlm auth") ?? "ntlmv2-only").toLowerCase();
    if (ntlm === "yes" || ntlm === "ntlmv1-permitted") {
        warnings.push({
            code: "ntlmv1",
            severity: "warning",
            share: null,
            message: `NTLMv1 authentication is allowed (ntlm auth = ${ntlm}). NTLMv1 password hashes are easy to crack.`,
            mitigations: ["Use ntlmv2-only unless a legacy device requires NTLMv1, and restrict that device with \"hosts allow\"."],
        });
    }
    if (parseBoolean(global("lanman auth") ?? "no") === true) {
        warnings.push({
            code: "lanman",
            severity: "danger",
            share: null,
            message: "LANMAN authentication is enabled (lanman auth = yes). LANMAN hashes are trivially cracked.",
            mitigations: ["Set \"lanman auth = no\"."],
        });
    }

    const mapToGuest = (global("map to guest") ?? "Never").toLowerCase();
    if (mapToGuest !== "never") {
        warnings.push({
            code: "map-to-guest",
            severity: "warning",
            share: null,
            message: `Failed logins are mapped to the guest account (map to guest = ${global("map to guest")}).`,
            mitigations: ["Set \"map to guest = Never\" unless guest shares are intended."],
        });
    }
    if (parseBoolean(global("usershare allow guests") ?? "no") === true) {
        warnings.push({
            code: "usershare-guests",
            severity: "warning",
            share: null,
            message: "Users may create shares that allow guest access (usershare allow guests = yes).",
            mitigations: ["Set \"usershare allow guests = no\"."],
        });
    }

    for (const share of listShareNames(document)) {
        if (!isShareEnabled(document, share))
            continue;
        const lowerName = share.toLowerCase();
        const value = (parameter: string, fallback: string) => effectiveShareValue(document, share, parameter, fallback);
        const guest = effectiveShareBoolean(document, share, "guest ok", false);
        const readOnly = effectiveShareBoolean(document, share, "read only", true);

        if (guest) {
            warnings.push({
                code: "guest-share",
                severity: readOnly ? "warning" : "danger",
                share,
                message: readOnly
                    ? "Guest access is allowed: anyone on the network can read this share without a password."
                    : "Guest access is allowed on a writable share: anyone on the network can change its files.",
                mitigations: ["Disable guest access, or restrict the share with \"hosts allow\"."],
            });
        }

        for (const parameter of ["create mask", "directory mask", "force create mode", "force directory mode"]) {
            const mask = value(parameter, "");
            if (isWorldWritableMask(mask)) {
                warnings.push({
                    code: "world-writable-mask",
                    severity: "warning",
                    share,
                    message: `${parameter} = ${mask} makes new files or directories writable by every local user.`,
                    mitigations: ["Use 0660 for files and 0770 for directories, with a shared group."],
                });
            }
        }

        const path = value("path", "");
        const information = path ? paths[path] : undefined;
        if (information?.exists && isWorldWritableMode(information.mode)) {
            const sticky = (parseInt(information.mode, 8) & 0o1000) !== 0;
            warnings.push({
                code: "world-writable-path",
                severity: "warning",
                share,
                message: `The share path ${path} is writable by every local user (mode ${information.mode}${sticky ? ", sticky" : ""}).`,
                mitigations: ["Remove write permission for others (chmod o-w) and grant access through a group."],
            });
        }

        if (!guest && value("valid users", "").trim() === "" && !SELF_RESTRICTED_SHARES.includes(lowerName) && !PRINTER_SHARES.includes(lowerName)) {
            warnings.push({
                code: "no-valid-users",
                severity: "info",
                share,
                message: "No \"valid users\": every Samba user can connect to this share.",
                mitigations: ["Set \"valid users\" to the users or @groups that need it."],
            });
        }
    }
    return warnings;
}
