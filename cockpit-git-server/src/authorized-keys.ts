/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * authorized_keys parsing, validation and editing. Pure functions with no
 * Cockpit dependency, so they can be unit tested under Node.
 */

export const ALLOWED_KEY_TYPES = [
    "ssh-ed25519",
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
];

export interface AuthorizedKeyLine {
    /** The verbatim line; this is the identity used when editing or removing a key. */
    raw: string;
    options: string;
    keyType: string;
    keyBlob: string;
    comment: string;
}

export interface KeyRestrictions {
    restrict: boolean;
    fromAddresses: string;
    expiryTime: string;
    /** Options this page does not manage, kept verbatim. */
    otherOptions: string[];
}

export type ValidationError =
    | "invalid-key-format"
    | "unsupported-key-type"
    | "invalid-key-data"
    | "options-in-key"
    | "invalid-comment"
    | "invalid-from-addresses"
    | "invalid-expiry-time";

// --- Parsing -------------------------------------------------------------

function looksLikeKeyType(token: string): boolean {
    return /^(ssh-|ecdsa-|sk-)[A-Za-z0-9@.-]+$/.test(token);
}

/** Index of the first whitespace outside double quotes, or -1. */
function endOfOptions(line: string): number {
    let inQuotes = false;
    for (let index = 0; index < line.length; index++) {
        const character = line[index];
        if (inQuotes && character === "\\") {
            index++;
            continue;
        }
        if (character === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (!inQuotes && (character === " " || character === "\t"))
            return index;
    }
    return -1;
}

export function parseAuthorizedKeyLine(raw: string): AuthorizedKeyLine | null {
    const line = raw.trim();
    if (!line || line.startsWith("#"))
        return null;

    let options = "";
    let rest = line;
    // As in sshd: a line that does not start with a key type starts with options.
    if (!looksLikeKeyType(line.split(/\s+/)[0])) {
        const optionsEnd = endOfOptions(line);
        if (optionsEnd <= 0)
            return null;
        options = line.slice(0, optionsEnd);
        rest = line.slice(optionsEnd).trim();
    }

    const parts = rest.split(/\s+/);
    if (parts.length < 2 || !looksLikeKeyType(parts[0]) || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1]))
        return null;
    return { raw, options, keyType: parts[0], keyBlob: parts[1], comment: parts.slice(2).join(" ") };
}

export function parseAuthorizedKeys(content: string): AuthorizedKeyLine[] {
    const keys: AuthorizedKeyLine[] = [];
    for (const line of content.split("\n")) {
        const key = parseAuthorizedKeyLine(line);
        if (key)
            keys.push(key);
    }
    return keys;
}

/** Split an options field on commas that are not inside double quotes. */
export function splitOptions(options: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let index = 0; index < options.length; index++) {
        const character = options[index];
        if (inQuotes && character === "\\" && index + 1 < options.length) {
            current += character + options[++index];
            continue;
        }
        if (character === '"')
            inQuotes = !inQuotes;
        if (character === "," && !inQuotes) {
            result.push(current);
            current = "";
            continue;
        }
        current += character;
    }
    if (current)
        result.push(current);
    return result.filter(Boolean);
}

function unquote(value: string): string {
    const match = value.match(/^"(.*)"$/);
    return match ? match[1].replace(/\\(.)/g, "$1") : value;
}

export function restrictionsFromOptions(options: string): KeyRestrictions {
    const restrictions: KeyRestrictions = { restrict: false, fromAddresses: "", expiryTime: "", otherOptions: [] };
    for (const option of splitOptions(options)) {
        const separator = option.indexOf("=");
        const name = (separator < 0 ? option : option.slice(0, separator)).toLowerCase();
        const value = separator < 0 ? "" : unquote(option.slice(separator + 1));
        if (name === "restrict" && separator < 0)
            restrictions.restrict = true;
        else if (name === "from" && separator >= 0)
            restrictions.fromAddresses = value;
        else if (name === "expiry-time" && separator >= 0)
            restrictions.expiryTime = value;
        else
            restrictions.otherOptions.push(option);
    }
    return restrictions;
}

// --- Serialization -------------------------------------------------------

export function buildOptions(restrictions: KeyRestrictions): string {
    const options: string[] = [];
    if (restrictions.restrict)
        options.push("restrict");
    if (restrictions.fromAddresses.trim())
        options.push(`from="${restrictions.fromAddresses.trim()}"`);
    if (restrictions.expiryTime.trim())
        options.push(`expiry-time="${restrictions.expiryTime.trim()}"`);
    options.push(...restrictions.otherOptions);
    return options.join(",");
}

export function serializeKeyLine(key: Omit<AuthorizedKeyLine, "raw">): string {
    const fields = [key.options, key.keyType, key.keyBlob, key.comment].filter(Boolean);
    return fields.join(" ");
}

// --- Validation ----------------------------------------------------------

function decodeBase64(value: string): string | null {
    try {
        return atob(value);
    } catch {
        return null;
    }
}

/** Validate a pasted public key ("type base64 [comment]", no options). */
export function validatePublicKey(text: string): ValidationError | null {
    if (/[\r\n]/.test(text.trim()))
        return "invalid-key-format";
    const parsed = parseAuthorizedKeyLine(text);
    if (!parsed)
        return "invalid-key-format";
    if (parsed.options)
        return "options-in-key";
    if (!ALLOWED_KEY_TYPES.includes(parsed.keyType))
        return "unsupported-key-type";

    // The blob starts with a length-prefixed copy of the key type.
    const decoded = decodeBase64(parsed.keyBlob);
    if (decoded === null || decoded.length < 4)
        return "invalid-key-data";
    const nameLength = ((decoded.charCodeAt(0) << 24) | (decoded.charCodeAt(1) << 16) |
                        (decoded.charCodeAt(2) << 8) | decoded.charCodeAt(3)) >>> 0;
    if (decoded.slice(4, 4 + nameLength) !== parsed.keyType)
        return "invalid-key-data";

    return validateComment(parsed.comment);
}

export function validateComment(comment: string): ValidationError | null {
    // eslint-disable-next-line no-control-regex
    return /["\\\u0000-\u001f\u007f]/.test(comment) ? "invalid-comment" : null;
}

/** from= takes a comma-separated list of host or address patterns, optionally negated with "!". */
export function validateFromAddresses(value: string): ValidationError | null {
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    const patterns = trimmed.split(",");
    return patterns.every(pattern => /^!?[A-Za-z0-9.:*?/_%-]+$/.test(pattern)) ? null : "invalid-from-addresses";
}

/** expiry-time accepts YYYYMMDD or YYYYMMDDHHMM[SS], optionally followed by Z for UTC. */
export function validateExpiryTime(value: string): ValidationError | null {
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    const match = trimmed.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?Z?$/);
    if (!match)
        return "invalid-expiry-time";
    const [, , month, day, hour, minute, second] = match.map(part => part === undefined ? 0 : Number(part));
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
        return "invalid-expiry-time";
    return null;
}

export function validateRestrictions(restrictions: KeyRestrictions): ValidationError | null {
    return validateFromAddresses(restrictions.fromAddresses) ?? validateExpiryTime(restrictions.expiryTime);
}

// --- File editing --------------------------------------------------------

export function sameKey(first: AuthorizedKeyLine, second: AuthorizedKeyLine): boolean {
    return first.keyType === second.keyType && first.keyBlob === second.keyBlob;
}

export function appendKeyLine(content: string, line: string): string {
    const prefix = content && !content.endsWith("\n") ? content + "\n" : content;
    return prefix + line + "\n";
}

/**
 * Replace (or remove, when replacement is null) the first line that is exactly
 * the given raw line. Every other line is kept as is. Returns null when the
 * line is no longer in the file.
 */
export function replaceKeyLine(content: string, raw: string, replacement: string | null): string | null {
    const lines = content.split("\n");
    const index = lines.findIndex(line => line.trim() === raw.trim());
    if (index < 0)
        return null;
    if (replacement === null)
        lines.splice(index, 1);
    else
        lines[index] = replacement;
    return lines.join("\n");
}

export function removeKeyLine(content: string, raw: string): string | null {
    return replaceKeyLine(content, raw, null);
}
