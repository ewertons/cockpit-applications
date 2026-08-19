/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * authorized_keys management and client key generation.
 */

import cockpit from 'cockpit';

import { EffectiveConfig, effectiveValue } from './openssh.js';

const _ = cockpit.gettext;

// --- Types ---------------------------------------------------------------

export interface AuthorizedKey {
    /** The verbatim line; this is the identity used when removing a key. */
    raw: string;
    options: string;
    type: string;
    blob: string;
    comment: string;
}

export interface SystemUser {
    name: string;
    uid: number;
    gid: number;
    home: string;
    shell: string;
    isSystem: boolean;
}

export type KeyType = "ed25519" | "rsa" | "ecdsa";

export interface Keypair {
    privateKey: string;
    publicKey: string;
    fingerprint: string;
    /** tmpfs directory holding key and key.pub; delete it when the dialog closes. */
    dir: string;
}

export interface KeyInfo {
    bits: string;
    fingerprint: string;
    type: string;
}

export interface KeyRestrictions {
    from: string;
    command: string;
    expiry: string;
    restrict: boolean;
    noPortForwarding: boolean;
    noPty: boolean;
}

export function emptyRestrictions(): KeyRestrictions {
    return { from: "", command: "", expiry: "", restrict: false, noPortForwarding: false, noPty: false };
}

// --- Parsing -------------------------------------------------------------

function looksLikeBlob(value: string): boolean {
    return value.length > 20 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/** Length of a leading options field, or -1 when the line has no whitespace. */
function optionsLength(line: string): number {
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes && c === "\\") {
            i++;
            continue;
        }
        if (c === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (!inQuotes && (c === " " || c === "\t"))
            return i;
    }
    return -1;
}

function splitKey(rest: string, options: string): Omit<AuthorizedKey, "raw"> | null {
    const parts = rest.split(/\s+/);
    if (parts.length < 2 || !looksLikeBlob(parts[1]))
        return null;
    return { options, type: parts[0], blob: parts[1], comment: parts.slice(2).join(" ") };
}

export function parseAuthorizedKey(raw: string): AuthorizedKey | null {
    const line = raw.trim();
    if (!line || line.startsWith("#"))
        return null;

    // Try without options first, so unknown key types still parse.
    const plain = splitKey(line, "");
    if (plain)
        return { ...plain, raw };

    const cut = optionsLength(line);
    if (cut <= 0)
        return null;
    const withOptions = splitKey(line.slice(cut).trim(), line.slice(0, cut));
    return withOptions ? { ...withOptions, raw } : null;
}

export function parseAuthorizedKeys(content: string): AuthorizedKey[] {
    const keys: AuthorizedKey[] = [];
    for (const line of content.split("\n")) {
        const key = parseAuthorizedKey(line);
        if (key)
            keys.push(key);
    }
    return keys;
}

/** Identity of a key: options and comment deliberately play no part. */
export function sameKey(a: AuthorizedKey, b: AuthorizedKey): boolean {
    return a.type === b.type && a.blob === b.blob;
}

function quoteOption(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildOptions(restrictions: KeyRestrictions): string {
    const options: string[] = [];
    if (restrictions.restrict)
        options.push("restrict");
    if (restrictions.from.trim())
        options.push(`from="${quoteOption(restrictions.from.trim())}"`);
    if (restrictions.command.trim())
        options.push(`command="${quoteOption(restrictions.command.trim())}"`);
    if (restrictions.expiry.trim())
        options.push(`expiry-time="${quoteOption(restrictions.expiry.trim())}"`);
    // "restrict" already denies these, and listing them again is redundant.
    if (restrictions.noPortForwarding && !restrictions.restrict)
        options.push("no-port-forwarding");
    if (restrictions.noPty && !restrictions.restrict)
        options.push("no-pty");
    return options.join(",");
}

export function composeKeyLine(options: string, publicKey: string): string {
    const key = publicKey.trim().replace(/\s+/g, " ");
    return options ? `${options} ${key}` : key;
}

// --- Key inspection ------------------------------------------------------

/** Validates and describes a key by handing it to ssh-keygen. */
export async function keyInfo(line: string): Promise<KeyInfo> {
    const proc = cockpit.spawn(["ssh-keygen", "-lf", "/dev/stdin"], { err: "message" });
    proc.input(line.trim() + "\n");
    const parts = (await proc).trim().split(/\s+/);
    return {
        bits: parts[0] ?? "",
        fingerprint: parts[1] ?? "",
        type: (parts[parts.length - 1] ?? "").replace(/[()]/g, ""),
    };
}

export async function validatePublicKey(line: string): Promise<boolean> {
    try {
        await keyInfo(line);
        return true;
    } catch {
        return false;
    }
}

// --- Users ---------------------------------------------------------------

export async function listUsers(): Promise<SystemUser[]> {
    let uidMin = 1000;
    let uidMax = 60000;
    try {
        const defs = (await cockpit.file("/etc/login.defs").read()) || "";
        const min = defs.match(/^\s*UID_MIN\s+(\d+)/m);
        const max = defs.match(/^\s*UID_MAX\s+(\d+)/m);
        if (min)
            uidMin = parseInt(min[1], 10);
        if (max)
            uidMax = parseInt(max[1], 10);
    } catch { /* stick with the usual defaults */ }

    let out = "";
    try {
        // getent, not /etc/passwd, so LDAP and SSSD accounts are included.
        out = await cockpit.spawn(["getent", "passwd"], { err: "message" });
    } catch {
        return [];
    }

    const users: SystemUser[] = [];
    for (const line of out.split("\n")) {
        const fields = line.split(":");
        if (fields.length < 7)
            continue;
        const uid = parseInt(fields[2], 10);
        const gid = parseInt(fields[3], 10);
        if (Number.isNaN(uid) || Number.isNaN(gid) || !fields[5])
            continue;
        users.push({
            name: fields[0],
            uid,
            gid,
            // Field 6 is authoritative; never assume /home/<name>.
            home: fields[5],
            shell: fields[6],
            isSystem: uid !== 0 && (uid < uidMin || uid > uidMax),
        });
    }

    users.sort((a, b) => {
        if (a.isSystem !== b.isSystem)
            return a.isSystem ? 1 : -1;
        return a.name.localeCompare(b.name);
    });
    return users;
}

export async function currentUserGroups(): Promise<string[]> {
    try {
        return (await cockpit.spawn(["groups"], { err: "ignore" })).trim().split(/\s+/)
                .filter(Boolean);
    } catch {
        return [];
    }
}

// --- authorized_keys file ------------------------------------------------

/** Resolve the effective AuthorizedKeysFile for a user, expanding %h/%u/%%. */
export function authorizedKeysPathFor(user: SystemUser, effective: EffectiveConfig): string {
    const spec = effectiveValue(effective, "authorizedkeysfile") || ".ssh/authorized_keys";
    const first = spec.split(/\s+/).filter(Boolean)[0] ?? ".ssh/authorized_keys";
    // Splitting on %% keeps an escaped percent from swallowing the token after it.
    const expanded = first.split("%%")
            .map(part => part.replace(/%h/g, user.home).replace(/%u/g, user.name))
            .join("%");
    return expanded.startsWith("/") ? expanded : `${user.home}/${expanded}`;
}

export async function readKeys(path: string): Promise<AuthorizedKey[]> {
    const handle = cockpit.file(path, { superuser: "require" });
    try {
        return parseAuthorizedKeys((await handle.read()) || "");
    } catch {
        return [];
    } finally {
        handle.close();
    }
}

export async function userHasAuthorizedKey(user: SystemUser, effective: EffectiveConfig): Promise<boolean> {
    return (await readKeys(authorizedKeysPathFor(user, effective))).length > 0;
}

async function ensureDirectory(user: SystemUser, path: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (!dir)
        return;
    await cockpit.spawn(["install", "-d", "-m", "0700", "-o", String(user.uid), "-g", String(user.gid), dir],
                        { superuser: "require", err: "message" });
    try {
        await cockpit.spawn(["restorecon", "-R", "-F", dir], { superuser: "require", err: "ignore" });
    } catch { /* no SELinux here */ }
}

/**
 * cockpit.file() creates the file as root, so StrictModes would reject it until
 * the owner and mode are corrected.
 */
async function fixPermissions(user: SystemUser, path: string): Promise<void> {
    await cockpit.spawn(["chmod", "600", path], { superuser: "require", err: "message" });
    await cockpit.spawn(["chown", `${user.uid}:${user.gid}`, path], { superuser: "require", err: "message" });
    try {
        await cockpit.spawn(["restorecon", "-F", path], { superuser: "require", err: "ignore" });
    } catch { /* no SELinux here */ }
}

export async function addKey(user: SystemUser, path: string, line: string): Promise<void> {
    const parsed = parseAuthorizedKey(line);
    if (!parsed)
        throw new Error(_("That does not look like an SSH public key."));

    await ensureDirectory(user, path);

    const handle = cockpit.file(path, { superuser: "require" });
    try {
        await handle.modify(current => {
            const content = current || "";
            if (parseAuthorizedKeys(content).some(key => sameKey(key, parsed)))
                throw new Error(_("That key is already authorized for this account."));
            const prefix = content && !content.endsWith("\n") ? content + "\n" : content;
            return prefix + parsed.raw.trim() + "\n";
        });
    } finally {
        handle.close();
    }

    await fixPermissions(user, path);
}

export async function removeKey(user: SystemUser, path: string, raw: string): Promise<void> {
    const handle = cockpit.file(path, { superuser: "require" });
    try {
        await handle.modify(current => {
            const lines = (current || "").split("\n");
            const kept = lines.filter(line => line.trim() !== raw.trim());
            if (kept.length === lines.length)
                throw new Error(_("That key is no longer in the file."));
            return kept.join("\n").replace(/\n{2,}$/, "\n");
        });
    } finally {
        handle.close();
    }

    await fixPermissions(user, path);
}

// --- Key generation ------------------------------------------------------

const KEY_SPLIT = "-----COCKPIT-OPENSSH-SPLIT-----";

// ssh-keygen has no stdout mode, so it writes into a private tmpfs directory.
// The directory outlives the command because the browser downloads the files
// from it over a Cockpit channel; discardKeypair() removes it afterwards. The
// trap still cleans up on every failure path, including PIPE and HUP when the
// caller closes the channel early. Arguments are positional so a key comment can
// never be interpreted as shell syntax.
const KEYGEN_SCRIPT = [
    'set -e',
    'd=$(mktemp -d -p /dev/shm cockpit-openssh.XXXXXXXX 2>/dev/null || mktemp -d)',
    'trap \'rm -rf "$d"\' EXIT INT TERM HUP PIPE',
    'if [ -n "$2" ]; then',
    '    ssh-keygen -q -t "$1" -b "$2" -f "$d/key" -N "" -C "$3"',
    'else',
    '    ssh-keygen -q -t "$1" -f "$d/key" -N "" -C "$3"',
    'fi',
    'printf "%s\\n" "$d"',
    `echo "${KEY_SPLIT}"`,
    'cat "$d/key"',
    `echo "${KEY_SPLIT}"`,
    'cat "$d/key.pub"',
    'trap - EXIT',
].join("\n");

export async function generateKeypair(type: KeyType, comment: string): Promise<Keypair> {
    const bits = type === "rsa" ? "4096" : "";
    // No superuser: generating a key pair is pure computation.
    const out = await cockpit.spawn(["/bin/sh", "-c", KEYGEN_SCRIPT, "sh", type, bits, comment],
                                    { err: "message" });

    const parts = out.split(KEY_SPLIT);
    if (parts.length < 3)
        throw new Error(_("ssh-keygen did not produce a key pair."));

    const dir = parts[0].trim();
    const privateKey = parts[1].replace(/^\n/, "").replace(/\n+$/, "\n");
    const publicKey = parts[2].trim();
    return { privateKey, publicKey, dir, fingerprint: (await keyInfo(publicKey)).fingerprint };
}

/** Remove the tmpfs directory a generated key pair still lives in. */
export async function discardKeypair(dir: string): Promise<void> {
    if (!dir.startsWith("/dev/shm/cockpit-openssh.") && !dir.startsWith("/tmp/"))
        return;
    try {
        await cockpit.spawn(["rm", "-rf", dir], { err: "ignore" });
    } catch { /* already gone */ }
}

/**
 * A same-origin URL that streams a file as a download. Blob URLs cannot be used:
 * Firefox treats them as a frame navigation inside Cockpit's iframe and the
 * default "frame-src 'self'" policy blocks them.
 */
export function downloadUrl(path: string, filename: string, contentType: string): string {
    const query = window.btoa(JSON.stringify({
        payload: "fsread1",
        binary: "raw",
        path,
        external: {
            "content-disposition": `attachment; filename="${filename}"`,
            "content-type": contentType,
        },
    }));
    const prefix = new URL(cockpit.transport.uri("channel/" + cockpit.transport.csrf_token)).pathname;
    return `${prefix}?${query}`;
}

export function defaultKeyFileName(type: KeyType, label: string): string {
    const cleaned = label.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
    return cleaned ? `id_${type}_${cleaned}` : `id_${type}`;
}
