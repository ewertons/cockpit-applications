/**
 * Knowledge about smb.conf parameter names: Samba matches names ignoring case
 * and whitespace, and several parameters have synonyms, some inverted
 * (`writeable = yes` means `read only = no`).
 */

/** @returns the lookup key Samba uses for a parameter name (lowercase, no whitespace). */
export function parameterKey(name: string): string {
    return name.replace(/\s+/g, "").toLowerCase();
}

interface Synonym {
    /** Key of the canonical parameter. */
    canonicalKey: string;
    /** The synonym is the boolean inverse of the canonical parameter. */
    inverted: boolean;
}

const SYNONYMS: Record<string, Synonym> = {
    writeable: { canonicalKey: "readonly", inverted: true },
    writable: { canonicalKey: "readonly", inverted: true },
    writeok: { canonicalKey: "readonly", inverted: true },
    browsable: { canonicalKey: "browseable", inverted: false },
    public: { canonicalKey: "guestok", inverted: false },
    createmode: { canonicalKey: "createmask", inverted: false },
    directorymode: { canonicalKey: "directorymask", inverted: false },
    allowhosts: { canonicalKey: "hostsallow", inverted: false },
    denyhosts: { canonicalKey: "hostsdeny", inverted: false },
    minprotocol: { canonicalKey: "serverminprotocol", inverted: false },
    maxprotocol: { canonicalKey: "servermaxprotocol", inverted: false },
    protocol: { canonicalKey: "servermaxprotocol", inverted: false },
    smbencrypt: { canonicalKey: "serversmbencrypt", inverted: false },
    directory: { canonicalKey: "path", inverted: false },
    printok: { canonicalKey: "printable", inverted: false },
    group: { canonicalKey: "forcegroup", inverted: false },
    debuglevel: { canonicalKey: "loglevel", inverted: false },
    onlyguest: { canonicalKey: "guestonly", inverted: false },
    exec: { canonicalKey: "preexec", inverted: false },
    preload: { canonicalKey: "autoservices", inverted: false },
};

/** Display names of the canonical parameters this app knows by key. */
const DISPLAY_NAMES: Record<string, string> = {};

/** Parameters that may appear several times in one section. */
const REPEATABLE_KEYS = new Set(["include"]);

/** Parameter names the UI writes; also the display names in the generic editor. */
export const KNOWN_PARAMETER_NAMES = [
    "workgroup", "server string", "netbios name", "interfaces", "bind interfaces only",
    "hosts allow", "hosts deny", "server min protocol", "server max protocol", "server signing",
    "server smb encrypt", "ntlm auth", "lanman auth", "map to guest", "guest account", "log level",
    "max log size", "usershare max shares", "usershare allow guests", "usershare owner only",
    "load printers", "printing", "printcap name", "disable spoolss", "server role", "security",
    "path", "comment", "browseable", "read only", "guest ok", "guest only", "valid users",
    "invalid users", "write list", "read list", "admin users", "force user", "force group",
    "create mask", "directory mask", "force create mode", "force directory mode", "vfs objects",
    "inherit permissions", "available", "printable", "include", "config backend", "hide unreadable",
    "preexec", "auto services", "passdb backend", "log file",
];
for (const name of KNOWN_PARAMETER_NAMES)
    DISPLAY_NAMES[parameterKey(name)] = name;

/** @returns how a written name maps to its canonical parameter. */
export function resolveParameter(name: string): Synonym {
    const key = parameterKey(name);
    return SYNONYMS[key] ?? { canonicalKey: key, inverted: false };
}

/** @returns the canonical display name for `name` (e.g. "writeable" -> "read only"), or `name` trimmed when unknown. */
export function canonicalParameterName(name: string): string {
    const { canonicalKey } = resolveParameter(name);
    return DISPLAY_NAMES[canonicalKey] ?? name.trim();
}

/** @returns whether the parameter may legitimately appear several times in a section. */
export function isRepeatableParameter(name: string): boolean {
    return REPEATABLE_KEYS.has(resolveParameter(name).canonicalKey);
}

/** @returns the boolean meaning of a Samba boolean value, or null when it is not one. */
export function parseBoolean(value: string): boolean | null {
    const text = value.trim().toLowerCase();
    if (["yes", "true", "on", "1"].includes(text))
        return true;
    if (["no", "false", "off", "0"].includes(text))
        return false;
    return null;
}

/** @returns `value` inverted when it is a boolean, unchanged otherwise. */
export function invertBooleanText(value: string): string {
    const parsed = parseBoolean(value);
    if (parsed === null)
        return value;
    return parsed ? "no" : "yes";
}

/** SMB dialects accepted by `server min protocol` / `server max protocol`, oldest first. */
export const PROTOCOL_LEVELS = [
    "CORE", "COREPLUS", "LANMAN1", "LANMAN2", "NT1",
    "SMB2_02", "SMB2_10", "SMB3_00", "SMB3_02", "SMB3_11",
] as const;

/** Aliases Samba accepts for protocol levels. */
const PROTOCOL_ALIASES: Record<string, string> = {
    SMB2: "SMB2_10",
    SMB3: "SMB3_11",
    DEFAULT: "",
};

/** @returns the index of a protocol level in PROTOCOL_LEVELS, or -1 when unknown or "default". */
export function protocolLevelIndex(value: string): number {
    const upper = value.trim().toUpperCase();
    const resolved = upper in PROTOCOL_ALIASES ? PROTOCOL_ALIASES[upper] : upper;
    return PROTOCOL_LEVELS.indexOf(resolved as typeof PROTOCOL_LEVELS[number]);
}

/** @returns whether the protocol level is SMB1 (NT1) or older. */
export function isSmb1OrOlder(value: string): boolean {
    const index = protocolLevelIndex(value);
    return index >= 0 && index <= PROTOCOL_LEVELS.indexOf("NT1");
}
