/**
 * Validation of values typed in the UI before they are written to smb.conf.
 * Rules are strict enough that a value can never break the file structure
 * (no line breaks, no continuation, no section syntax); semantic checks are
 * left to testparm, which runs on every candidate file before it is applied.
 */

import { FieldKind, ParameterField, splitList } from './model.js';
import { ConfigurationDocument, GLOBAL_SECTION, sameSectionName } from './smb-conf.js';
import { parseBoolean, protocolLevelIndex } from './parameters.js';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** @returns an error message, or null when the share name is acceptable. */
export function validateShareName(name: string, existingNames: string[] = []): string | null {
    const trimmed = name.trim();
    if (trimmed === "")
        return "Share name is required";
    if (trimmed.length > 80)
        return "Share name is longer than 80 characters";
    if (CONTROL_CHARACTERS.test(trimmed) || /[[\]\\/:*?"<>|=;,+%]/.test(trimmed))
        return "Share name contains a character not allowed in share names";
    if (sameSectionName(trimmed, GLOBAL_SECTION))
        return "\"global\" is reserved for global settings";
    if (existingNames.some(existing => sameSectionName(existing, trimmed)))
        return "A share with this name already exists";
    return null;
}

/** @returns an error message, or null when the parameter name can be written. */
export function validateParameterName(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed === "")
        return "Parameter name is required";
    if (!/^[A-Za-z][A-Za-z0-9 _:*.-]*$/.test(trimmed))
        return "Parameter names start with a letter and contain letters, digits, spaces, \"_\", \":\", \"*\", \".\" or \"-\"";
    return null;
}

/** @returns an error message, or null when the value cannot break the file structure. */
export function validateParameterValue(value: string): string | null {
    if (CONTROL_CHARACTERS.test(value.replace(/\t/g, " ")))
        return "Value must be a single line";
    if (value.trim().endsWith("\\"))
        return "Value must not end with \"\\\" (line continuation)";
    return null;
}

/** @returns an error for a NetBIOS-style name (netbios name, workgroup). */
function validateNetbiosName(value: string, allowDot: boolean): string | null {
    if (value.length > 15)
        return "At most 15 characters";
    const pattern = allowDot ? /^[A-Za-z0-9][A-Za-z0-9_.-]*$/ : /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
    if (!pattern.test(value))
        return allowDot ? "Letters, digits, \"_\", \".\" and \"-\" only" : "Letters, digits, \"_\" and \"-\" only";
    return null;
}

/** @returns whether a token is acceptable in hosts allow / hosts deny. */
function isValidHostToken(token: string): boolean {
    if (/^(EXCEPT|ALL|LOCAL)$/i.test(token))
        return true;
    return /^[A-Za-z0-9.:/*@_[\]-]+$/.test(token) && token.length <= 255;
}

/** @returns whether a token is acceptable in user lists (user, @group, +group, &group, DOMAIN\\user, %S). */
function isValidUserToken(token: string): boolean {
    return /^[@+&]{0,2}[A-Za-z0-9._$%\\ -]+$/.test(token) && !/^[@+&]*$/.test(token);
}

/** @returns an error message for a field value, or null when it is valid. Empty means "not set". */
export function validateFieldValue(field: ParameterField, value: string): string | null {
    const structural = validateParameterValue(value);
    if (structural)
        return structural;
    const trimmed = value.trim();
    if (trimmed === "")
        return null;
    return validateByKind(field.kind, field.parameter, trimmed, field.choices);
}

function validateByKind(kind: FieldKind, parameter: string, value: string, choices: string[] | undefined): string | null {
    switch (kind) {
    case "boolean":
        return parseBoolean(value) === null ? "Must be yes or no" : null;
    case "choice":
        if (parameter.endsWith("protocol"))
            return protocolLevelIndex(value) < 0 && value.toLowerCase() !== "default" ? "Unknown protocol level" : null;
        return choices && !choices.some(choice => choice.toLowerCase() === value.toLowerCase()) ? `Must be one of: ${choices.join(", ")}` : null;
    case "mask":
        return /^0?[0-7]{3,4}$/.test(value) ? null : "Octal permission mask, e.g. 0660";
    case "number":
        return /^\d{1,9}$/.test(value) ? null : "Must be a whole number";
    case "path":
        if (!value.startsWith("/"))
            return "Must be an absolute path";
        return /\/\.\.?(\/|$)/.test(value) ? "Must not contain \".\" or \"..\" components" : null;
    case "hosts":
        return splitList(value).every(isValidHostToken) ? null : "Addresses, networks, host names, ALL, LOCAL or EXCEPT, separated by spaces or commas";
    case "users":
        return splitList(value).every(isValidUserToken) ? null : "User names, @group, +group or &group, separated by spaces or commas";
    case "text":
        if (parameter === "netbios name")
            return validateNetbiosName(value, false);
        if (parameter === "workgroup")
            return validateNetbiosName(value, true);
        if (parameter === "force user" || parameter === "force group" || parameter === "guest account")
            return isValidLinuxName(value.replace(/^[+&@]/, "")) ? null : "Must be a Linux user or group name";
        return null;
    }
}

/** @returns whether `name` is a valid Linux user or group name. */
export function isValidLinuxName(name: string): boolean {
    return /^[a-z_][a-z0-9_.-]{0,30}\$?$/i.test(name);
}

/** @returns an error message, or null when `name` can be used for a new Linux system user. */
export function validateNewUserName(name: string): string | null {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name))
        return "Lowercase letters, digits, \"_\" and \"-\", starting with a letter or \"_\", at most 32 characters";
    return null;
}

/** @returns an error message, or null when the password can be passed to smbpasswd. */
export function validatePassword(password: string, confirmation: string): string | null {
    if (password === "")
        return "Password is required";
    if (/[\r\n\u0000]/.test(password)) // eslint-disable-line no-control-regex
        return "Password must be a single line";
    if (password.length > 256)
        return "Password is longer than 256 characters";
    if (password !== confirmation)
        return "Passwords do not match";
    return null;
}

/** @returns problems that make the document unsafe to write (should not happen after parsing; guards generated text). */
export function validateDocument(document: ConfigurationDocument): string[] {
    const problems: string[] = [];
    const all = [...document.preamble, ...document.sections.flatMap(section => [...section.leadingLines, ...section.lines])];
    for (const section of document.sections) {
        if (!section.headerRawLines && (section.name.includes("]") || CONTROL_CHARACTERS.test(section.name)))
            problems.push(`Invalid section name "${section.name}"`);
    }
    for (const line of all) {
        if (line.rawLines || line.kind !== "parameter")
            continue;
        const nameError = validateParameterName(line.name);
        const valueError = validateParameterValue(line.value);
        if (nameError)
            problems.push(`${line.name}: ${nameError}`);
        if (valueError)
            problems.push(`${line.name}: ${valueError}`);
    }
    return problems;
}
