/**
 * Typed view of smb.conf for the forms: which parameters the UI offers, their
 * widgets and Samba defaults, and share-level helpers on top of smb-conf.ts.
 */

import {
    ConfigurationDocument,
    GLOBAL_SECTION,
    getParameter,
    listSectionNames,
    sameSectionName,
    setParameter,
} from './smb-conf.js';
import { PROTOCOL_LEVELS, parseBoolean, resolveParameter } from './parameters.js';

export type FieldKind = "text" | "boolean" | "choice" | "mask" | "users" | "hosts" | "path" | "number";

export interface ParameterField {
    /** Canonical parameter name written to smb.conf. */
    parameter: string;
    label: string;
    kind: FieldKind;
    /** Samba's built-in default, shown when the parameter is not set. */
    defaultValue: string;
    choices?: string[];
    help?: string;
}

const PROTOCOL_CHOICES = [...PROTOCOL_LEVELS.filter(level => !["CORE", "COREPLUS"].includes(level)), "SMB2", "SMB3"];

export const GLOBAL_FIELDS: ParameterField[] = [
    { parameter: "workgroup", label: "Workgroup", kind: "text", defaultValue: "WORKGROUP" },
    { parameter: "server string", label: "Server string", kind: "text", defaultValue: "Samba %v" },
    { parameter: "netbios name", label: "NetBIOS name", kind: "text", defaultValue: "host name, up to 15 characters" },
    { parameter: "interfaces", label: "Interfaces", kind: "text", defaultValue: "all", help: "Interface names or addresses, e.g. \"lo eth0\" or \"192.168.1.0/24\"" },
    { parameter: "bind interfaces only", label: "Bind interfaces only", kind: "boolean", defaultValue: "no" },
    { parameter: "hosts allow", label: "Hosts allow", kind: "hosts", defaultValue: "all", help: "Applies to every share. Addresses, networks (192.168.1. or 192.168.1.0/24) or EXCEPT" },
    { parameter: "hosts deny", label: "Hosts deny", kind: "hosts", defaultValue: "none" },
    { parameter: "server min protocol", label: "Server min protocol", kind: "choice", defaultValue: "SMB2_02", choices: PROTOCOL_CHOICES, help: "NT1 or lower enables SMB1" },
    { parameter: "server max protocol", label: "Server max protocol", kind: "choice", defaultValue: "SMB3", choices: PROTOCOL_CHOICES },
    { parameter: "server signing", label: "Server signing", kind: "choice", defaultValue: "default", choices: ["default", "auto", "mandatory", "disabled"] },
    { parameter: "server smb encrypt", label: "SMB encryption", kind: "choice", defaultValue: "default", choices: ["default", "off", "if_required", "desired", "required"] },
    { parameter: "ntlm auth", label: "NTLM authentication", kind: "choice", defaultValue: "ntlmv2-only", choices: ["ntlmv2-only", "ntlmv1-permitted", "mschapv2-and-ntlmv2-only", "disabled", "yes", "no"] },
    { parameter: "lanman auth", label: "LANMAN authentication", kind: "boolean", defaultValue: "no" },
    { parameter: "map to guest", label: "Map to guest", kind: "choice", defaultValue: "Never", choices: ["Never", "Bad User", "Bad Password", "Bad Uid"] },
    { parameter: "guest account", label: "Guest account", kind: "text", defaultValue: "nobody" },
    { parameter: "log level", label: "Log level", kind: "text", defaultValue: "0", help: "0-10, optionally per class, e.g. \"1 auth:3\"" },
    { parameter: "max log size", label: "Max log size (KiB)", kind: "number", defaultValue: "5000" },
    { parameter: "usershare max shares", label: "Usershares (max, 0 disables)", kind: "number", defaultValue: "0" },
    { parameter: "usershare allow guests", label: "Usershares may allow guests", kind: "boolean", defaultValue: "no" },
    { parameter: "usershare owner only", label: "Usershares of owned paths only", kind: "boolean", defaultValue: "yes" },
];

export const SHARE_FIELDS: ParameterField[] = [
    { parameter: "path", label: "Path", kind: "path", defaultValue: "" },
    { parameter: "comment", label: "Comment", kind: "text", defaultValue: "" },
    { parameter: "browseable", label: "Browseable", kind: "boolean", defaultValue: "yes" },
    { parameter: "read only", label: "Read only", kind: "boolean", defaultValue: "yes", help: "\"writable = yes\" is the same as \"read only = no\"" },
    { parameter: "guest ok", label: "Guest access", kind: "boolean", defaultValue: "no" },
    { parameter: "valid users", label: "Valid users", kind: "users", defaultValue: "", help: "Empty allows every Samba user. Use @group for Linux groups" },
    { parameter: "write list", label: "Write list", kind: "users", defaultValue: "", help: "May write even when the share is read only" },
    { parameter: "read list", label: "Read list", kind: "users", defaultValue: "", help: "Read only even when the share is writable" },
    { parameter: "admin users", label: "Admin users", kind: "users", defaultValue: "", help: "Act as root on this share" },
    { parameter: "force user", label: "Force user", kind: "text", defaultValue: "" },
    { parameter: "force group", label: "Force group", kind: "text", defaultValue: "" },
    { parameter: "create mask", label: "Create mask", kind: "mask", defaultValue: "0744" },
    { parameter: "directory mask", label: "Directory mask", kind: "mask", defaultValue: "0755" },
    { parameter: "hosts allow", label: "Hosts allow", kind: "hosts", defaultValue: "" },
    { parameter: "hosts deny", label: "Hosts deny", kind: "hosts", defaultValue: "" },
    { parameter: "vfs objects", label: "VFS objects", kind: "text", defaultValue: "", help: "e.g. \"recycle\", \"fruit streams_xattr\", \"acl_xattr\"" },
    { parameter: "inherit permissions", label: "Inherit permissions", kind: "boolean", defaultValue: "no" },
];

/** Parameters written by the printing on/off switch. */
const PRINTING_OFF_PARAMETERS: [string, string][] = [
    ["load printers", "no"],
    ["printing", "bsd"],
    ["printcap name", "/dev/null"],
    ["disable spoolss", "yes"],
];

/** Names of the parameters written by the printing switch. */
export const PRINTING_PARAMETER_NAMES = PRINTING_OFF_PARAMETERS.map(([name]) => name);

/** Sections with special meaning in Samba. */
export const SPECIAL_SECTIONS = ["homes", "printers", "print$"];

/** @returns whether `parameter` is edited by one of `fields` (synonyms included). */
export function isFieldParameter(fields: ParameterField[], parameter: string): boolean {
    const key = resolveParameter(parameter).canonicalKey;
    return fields.some(field => resolveParameter(field.parameter).canonicalKey === key);
}

/** @returns share names (every section but [global]) in file order. */
export function listShareNames(document: ConfigurationDocument): string[] {
    return listSectionNames(document).filter(name => !sameSectionName(name, GLOBAL_SECTION));
}

/**
 * @returns the value that applies to a share: set on the share, else in
 * [global] (which provides share defaults), else Samba's default.
 */
export function effectiveShareValue(document: ConfigurationDocument, shareName: string, parameter: string, defaultValue: string): string {
    return getParameter(document, shareName, parameter) ?? getParameter(document, GLOBAL_SECTION, parameter) ?? defaultValue;
}

/** @returns the boolean value that applies to a share (see effectiveShareValue). */
export function effectiveShareBoolean(document: ConfigurationDocument, shareName: string, parameter: string, defaultValue: boolean): boolean {
    return parseBoolean(effectiveShareValue(document, shareName, parameter, defaultValue ? "yes" : "no")) ?? defaultValue;
}

/** @returns whether the share is enabled (`available` is not "no"). */
export function isShareEnabled(document: ConfigurationDocument, shareName: string): boolean {
    return effectiveShareBoolean(document, shareName, "available", true);
}

/** @returns the document with the share enabled (parameter removed) or disabled (`available = no`). */
export function setShareEnabled(document: ConfigurationDocument, shareName: string, enabled: boolean): ConfigurationDocument {
    return setParameter(document, shareName, "available", enabled ? null : "no");
}

/** @returns whether printer shares are loaded (`load printers` not "no"). */
export function isPrintingEnabled(document: ConfigurationDocument): boolean {
    return parseBoolean(getParameter(document, GLOBAL_SECTION, "load printers") ?? "yes") !== false;
}

/** @returns the document with printing turned off (the usual four parameters) or those parameters removed. */
export function setPrintingEnabled(document: ConfigurationDocument, enabled: boolean): ConfigurationDocument {
    let result = document;
    for (const [parameter, value] of PRINTING_OFF_PARAMETERS)
        result = setParameter(result, GLOBAL_SECTION, parameter, enabled ? null : value);
    return result;
}

/** @returns the user/group tokens of a list parameter such as valid users (commas or spaces, quotes kept together). */
export function splitList(value: string): string[] {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|([^\s,]+)/g;
    let match;
    while ((match = pattern.exec(value)) !== null)
        tokens.push(match[1] ?? match[2]);
    return tokens.filter(token => token !== "");
}

/** @returns list tokens joined for smb.conf, quoting tokens with spaces. */
export function joinList(tokens: string[]): string {
    return tokens.map(token => /\s/.test(token) ? `"${token}"` : token).join(" ");
}
