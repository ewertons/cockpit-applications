import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { EmptyState, EmptyStateBody, EmptyStateFooter, EmptyStateActions } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { ClipboardCopy } from "@patternfly/react-core/dist/esm/components/ClipboardCopy/index.js";

import cockpit from 'cockpit';

import {
    AuthorizedKeyLine,
    KeyRestrictions,
    ValidationError,
    appendKeyLine,
    buildOptions,
    parseAuthorizedKeyLine,
    parseAuthorizedKeys,
    removeKeyLine,
    replaceKeyLine,
    restrictionsFromOptions,
    sameKey,
    serializeKeyLine,
    validateComment,
    validatePublicKey,
    validateRestrictions,
} from './authorized-keys.js';
import { SshdHardeningCard } from './sshd-hardening.jsx';

const _ = cockpit.gettext;
const GIT_ROOT = "/srv/git";
const SSH_DIRECTORY = GIT_ROOT + "/.ssh";
const AUTH_KEYS_PATH = SSH_DIRECTORY + "/authorized_keys";

function defaultRestrictions(): KeyRestrictions {
    return { restrict: true, fromAddresses: "", expiryTime: "", otherOptions: [] };
}

function validationMessage(error: ValidationError): string {
    switch (error) {
    case "invalid-key-format":
        return _("Invalid SSH public key format. Paste a single line such as \"ssh-ed25519 AAAA... user@host\".");
    case "unsupported-key-type":
        return _("Unsupported key type. Use ssh-ed25519, ssh-rsa, ecdsa-sha2-* or a security key type.");
    case "invalid-key-data":
        return _("The key data is not valid for its key type.");
    case "options-in-key":
        return _("Paste the public key without options; use the restriction fields instead.");
    case "invalid-comment":
        return _("The label must not contain quotes, backslashes or control characters.");
    case "invalid-from-addresses":
        return _("Allowed sources must be a comma-separated list of addresses, CIDR ranges or host names, without spaces or quotes.");
    case "invalid-expiry-time":
        return _("Expiry time must be YYYYMMDD or YYYYMMDDHHMM[SS], optionally followed by Z for UTC.");
    }
}

/** Apply a change to authorized_keys atomically and restore the ownership and modes sshd requires. */
async function updateAuthorizedKeys(transform: (content: string) => string): Promise<void> {
    const owner = (await cockpit.spawn(["stat", "-c", "%U:%G", GIT_ROOT], { superuser: "require", err: "message" })).trim();
    const [ownerUser, ownerGroup] = owner.split(":");
    await cockpit.spawn(["install", "-d", "-m", "0700", "-o", ownerUser, "-g", ownerGroup, SSH_DIRECTORY],
                        { superuser: "require", err: "message" });

    // modify() writes through a temporary file and rename, and fails if the file changed meanwhile.
    const handle = cockpit.file(AUTH_KEYS_PATH, { superuser: "require" });
    try {
        await handle.modify((current: string | null) => transform(current || ""));
    } finally {
        handle.close();
    }

    await cockpit.spawn(["chmod", "600", AUTH_KEYS_PATH], { superuser: "require", err: "message" });
    await cockpit.spawn(["chown", owner, AUTH_KEYS_PATH], { superuser: "require", err: "message" });
}

async function keyFingerprint(key: AuthorizedKeyLine): Promise<string> {
    const keygenProcess = cockpit.spawn(["ssh-keygen", "-lf", "-"], { err: "message" });
    keygenProcess.input(`${key.keyType} ${key.keyBlob}\n`);
    return (await keygenProcess).trim().split(/\s+/)[1] ?? "";
}

interface RestrictionFieldsProps {
    idPrefix: string;
    restrictions: KeyRestrictions;
    onChange: (restrictions: KeyRestrictions) => void;
}

const RestrictionFields = ({ idPrefix, restrictions, onChange }: RestrictionFieldsProps) => (
    <>
        <div style={{ marginTop: "1rem" }}>
            <Checkbox
                id={idPrefix + "-restrict"}
                label={_("Restrict (recommended)")}
                description={_("Disables port, agent and X11 forwarding and terminal allocation. Git over SSH keeps working.")}
                isChecked={restrictions.restrict}
                onChange={(_event, value) => onChange({ ...restrictions, restrict: value })}
            />
        </div>
        <FormGroup label={_("Allowed sources (optional)")} fieldId={idPrefix + "-from"} style={{ marginTop: "1rem" }}>
            <TextInput
                id={idPrefix + "-from"}
                value={restrictions.fromAddresses}
                onChange={(_event, value) => onChange({ ...restrictions, fromAddresses: value })}
                placeholder="10.0.0.5,192.168.1.0/24,*.example.com"
            />
        </FormGroup>
        <FormGroup label={_("Expiry time (optional)")} fieldId={idPrefix + "-expiry"} style={{ marginTop: "1rem" }}>
            <TextInput
                id={idPrefix + "-expiry"}
                value={restrictions.expiryTime}
                onChange={(_event, value) => onChange({ ...restrictions, expiryTime: value })}
                placeholder="YYYYMMDD"
            />
        </FormGroup>
        {restrictions.otherOptions.length > 0 && (
            <p style={{ marginTop: "1rem" }}>
                {cockpit.format(_("Other options kept as they are: $0"), restrictions.otherOptions.join(","))}
            </p>
        )}
    </>
);

export const AccessPage = () => {
    const [keys, setKeys] = useState<AuthorizedKeyLine[]>([]);
    const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [gitoliteDetected, setGitoliteDetected] = useState(false);

    // Add key modal
    const [showAdd, setShowAdd] = useState(false);
    const [newKeyContent, setNewKeyContent] = useState("");
    const [newKeyLabel, setNewKeyLabel] = useState("");
    const [newKeyRestrictions, setNewKeyRestrictions] = useState<KeyRestrictions>(defaultRestrictions());
    const [addError, setAddError] = useState("");
    const [adding, setAdding] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [generatedPrivateKey, setGeneratedPrivateKey] = useState("");
    const [keyDir, setKeyDir] = useState("");
    // The browser may reach Cockpit as "localhost" through an SSH tunnel; clients need the real name.
    const [hostname, setHostname] = useState("localhost");

    useEffect(() => {
        const file = cockpit.file('/etc/hostname');
        file.watch(content => setHostname(content?.trim() || "localhost"));
        return file.close;
    }, []);

    // Edit restrictions modal
    const [editedKey, setEditedKey] = useState<AuthorizedKeyLine | null>(null);
    const [editedRestrictions, setEditedRestrictions] = useState<KeyRestrictions>(defaultRestrictions());
    const [editError, setEditError] = useState("");
    const [saving, setSaving] = useState(false);

    const loadKeys = useCallback(() => {
        setLoading(true);
        setError("");

        // Check for Gitolite
        cockpit.spawn(["test", "-d", "/srv/git/.gitolite"], { superuser: "try", err: "ignore" })
                .then(() => setGitoliteDetected(true))
                .catch(() => setGitoliteDetected(false));

        cockpit.file(AUTH_KEYS_PATH, { superuser: "require" }).read()
                .then((content: string) => {
                    setKeys(parseAuthorizedKeys(content || ""));
                    setLoading(false);
                })
                .catch((ex: cockpit.BasicError) => {
                    if (ex.problem === "not-found") {
                        setKeys([]);
                    } else {
                        setError(ex.message || String(ex));
                    }
                    setLoading(false);
                });
    }, []);

    useEffect(() => { loadKeys() }, [loadKeys]);

    useEffect(() => {
        let cancelled = false;
        Promise.all(keys.map(key => keyFingerprint(key).catch(() => "")))
                .then(results => {
                    if (cancelled)
                        return;
                    const byBlob: Record<string, string> = {};
                    keys.forEach((key, index) => { byBlob[key.keyBlob] = results[index] });
                    setFingerprints(byBlob);
                });
        return () => { cancelled = true };
    }, [keys]);

    const handleAddKey = () => {
        const keyContent = newKeyContent.trim();
        if (!keyContent) return;

        const keyError = validatePublicKey(keyContent) ??
            validateComment(newKeyLabel.trim()) ??
            validateRestrictions(newKeyRestrictions);
        if (keyError) {
            setAddError(validationMessage(keyError));
            return;
        }

        const parsed = parseAuthorizedKeyLine(keyContent);
        if (!parsed)
            return;
        const newLine = serializeKeyLine({
            options: buildOptions(newKeyRestrictions),
            keyType: parsed.keyType,
            keyBlob: parsed.keyBlob,
            comment: parsed.comment || newKeyLabel.trim(),
        });

        setAdding(true);
        setAddError("");

        keyFingerprint(parsed)
                .catch(() => { throw new Error(validationMessage("invalid-key-data")) })
                .then(() => updateAuthorizedKeys(content => {
                    if (parseAuthorizedKeys(content).some(key => sameKey(key, parsed)))
                        throw new Error(_("That key is already authorized."));
                    return appendKeyLine(content, newLine);
                }))
                .then(() => {
                    if (keyDir)
                        cockpit.spawn(["rm", "-rf", keyDir], { err: "ignore" });
                    setKeyDir("");
                    setShowAdd(false);
                    setNewKeyContent("");
                    setNewKeyLabel("");
                    setNewKeyRestrictions(defaultRestrictions());
                    setAdding(false);
                    setGeneratedPrivateKey("");
                    loadKeys();
                })
                .catch((ex: Error) => {
                    setAddError(ex.message || String(ex));
                    setAdding(false);
                });
    };

    const handleRemoveKey = (keyToRemove: AuthorizedKeyLine) => {
        setError("");
        updateAuthorizedKeys(content => {
            const updated = removeKeyLine(content, keyToRemove.raw);
            if (updated === null)
                throw new Error(_("That key is no longer in the file."));
            return updated;
        })
                .then(() => loadKeys())
                .catch((ex: Error) => setError(ex.message || String(ex)));
    };

    const openEdit = (key: AuthorizedKeyLine) => {
        setEditedKey(key);
        setEditedRestrictions(restrictionsFromOptions(key.options));
        setEditError("");
    };

    const handleSaveRestrictions = () => {
        if (!editedKey)
            return;
        const restrictionsError = validateRestrictions(editedRestrictions);
        if (restrictionsError) {
            setEditError(validationMessage(restrictionsError));
            return;
        }

        const newLine = serializeKeyLine({ ...editedKey, options: buildOptions(editedRestrictions, editedKey.options) });
        setSaving(true);
        setEditError("");
        updateAuthorizedKeys(content => {
            const updated = replaceKeyLine(content, editedKey.raw, newLine);
            if (updated === null)
                throw new Error(_("That key is no longer in the file."));
            return updated;
        })
                .then(() => {
                    setSaving(false);
                    setEditedKey(null);
                    loadKeys();
                })
                .catch((ex: Error) => {
                    setEditError(ex.message || String(ex));
                    setSaving(false);
                });
    };

    const handleGenerateKey = () => {
        setGenerating(true);
        setAddError("");
        setGeneratedPrivateKey("");

        const comment = newKeyLabel.trim() || "generated-key";
        // A private tmpfs directory: the key must not land on persistent storage,
        // and mktemp avoids the predictable name a guessable path would have.
        const script = [
            'set -e',
            'd=$(mktemp -d -p /dev/shm cockpit-git-keygen.XXXXXXXX 2>/dev/null || mktemp -d)',
            'trap \'rm -rf "$d"\' EXIT INT TERM HUP PIPE',
            'ssh-keygen -q -t ed25519 -f "$d/key" -N "" -C "$1"',
            'printf "%s\\n" "$d"',
            'trap - EXIT',
        ].join("\n");

        cockpit.spawn(["/bin/sh", "-c", script, "sh", comment], { err: "message" })
                .then((out: string) => {
                    const dir = out.trim();
                    return Promise.all([
                        cockpit.file(dir + "/key.pub").read(),
                        cockpit.file(dir + "/key").read(),
                        Promise.resolve(dir),
                    ]);
                })
                .then(([pubKey, privKey, dir]: [string, string, string]) => {
                    setNewKeyContent(pubKey.trim());
                    setGeneratedPrivateKey(privKey);
                    // Kept until the dialog closes so the browser can download it.
                    setKeyDir(dir);
                    setGenerating(false);
                })
                .catch((ex: cockpit.BasicError) => {
                    setAddError(ex.message || String(ex));
                    setGenerating(false);
                });
    };

    const closeAdd = () => {
        if (keyDir)
            cockpit.spawn(["rm", "-rf", keyDir], { err: "ignore" });
        setKeyDir("");
        setShowAdd(false);
        setAddError("");
        setGeneratedPrivateKey("");
        setNewKeyRestrictions(defaultRestrictions());
    };

    const getKeyFilename = () => {
        const label = newKeyLabel.trim();
        if (label) {
            return "id_ed25519_" + label.replace(/[^a-zA-Z0-9._-]/g, "_");
        }
        return "id_ed25519";
    };

    // A same-origin URL, not a blob: inside Cockpit's iframe Firefox treats blob
    // downloads as a frame navigation and blocks them under "frame-src 'self'".
    const privateKeyUrl = () => {
        const query = window.btoa(JSON.stringify({
            payload: "fsread1",
            binary: "raw",
            path: keyDir + "/key",
            external: {
                "content-disposition": `attachment; filename="${getKeyFilename()}"`,
                "content-type": "application/octet-stream",
            },
        }));
        const prefix = new URL(cockpit.transport.uri("channel/" + cockpit.transport.csrf_token)).pathname;
        return `${prefix}?${query}`;
    };

    const setupInstructions = [
        "# Save the downloaded file to ~/.ssh/ and set permissions:",
        `mv ~/Downloads/${getKeyFilename()} ~/.ssh/`,
        `chmod 600 ~/.ssh/${getKeyFilename()}`,
        "",
        "# Add to ~/.ssh/config:",
        `Host ${hostname}`,
        `    IdentityFile ~/.ssh/${getKeyFilename()}`,
        "    User git",
    ].join("\n");

    if (loading) return <Spinner aria-label={_("Loading")} />;

    return (
        <>
            {gitoliteDetected && (
                <Alert variant="info" title={_("Gitolite detected")} isInline style={{ marginBottom: "1rem" }}>
                    {_("Gitolite is installed at /srv/git/.gitolite. Access may be managed by Gitolite in addition to authorized_keys.")}
                </Alert>
            )}

            <Card style={{ marginBottom: "1rem" }}>
                <CardTitle>
                    <span>{_("SSH Authorized Keys")}</span>
                    <Label color="blue" style={{ marginLeft: "1rem" }}>
                        {gitoliteDetected ? _("Managed by: Gitolite + SSH") : _("Managed by: SSH keys")}
                    </Label>
                </CardTitle>
                <CardBody>
                    <p style={{ marginBottom: "1rem" }}>
                        {cockpit.format(_("Managing keys in $0"), AUTH_KEYS_PATH)}
                    </p>

                    {error && <Alert variant="danger" title={error} isInline style={{ marginBottom: "1rem" }} />}

                    {keys.length > 0 && (
                        <Button variant="primary" onClick={() => setShowAdd(true)} style={{ marginBottom: "1rem" }}>
                            {_("Add SSH Key")}
                        </Button>
                    )}

                    {keys.length === 0
                        ? (
                            <EmptyState>
                                <EmptyStateBody>
                                    {_("No SSH keys configured.")}
                                </EmptyStateBody>
                                <EmptyStateFooter>
                                    <EmptyStateActions>
                                        <Button variant="primary" onClick={() => setShowAdd(true)}>
                                            {_("Add SSH Key")}
                                        </Button>
                                    </EmptyStateActions>
                                </EmptyStateFooter>
                            </EmptyState>
                        )
                        : keys.map((k, i) => (
                            <Card key={i} isCompact isFlat style={{ marginBottom: "0.5rem" }}>
                                <CardBody>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                        <div>
                                            <Label color="blue" style={{ marginRight: "0.5rem" }}>{k.keyType}</Label>
                                            <strong>{k.comment || _("(no label)")}</strong>
                                            <div className="key-fingerprint" style={{ marginTop: "0.25rem" }}>
                                                {fingerprints[k.keyBlob] || k.keyBlob.slice(-16)}
                                            </div>
                                            <div className="key-options" style={{ marginTop: "0.25rem" }}>
                                                {k.options
                                                    ? <code>{k.options}</code>
                                                    : <Label color="orange">{_("Unrestricted")}</Label>}
                                            </div>
                                        </div>
                                        <div>
                                            <Button variant="secondary" onClick={() => openEdit(k)} style={{ marginRight: "0.5rem" }}>
                                                {_("Edit restrictions")}
                                            </Button>
                                            <Button variant="danger" onClick={() => handleRemoveKey(k)}>
                                                {_("Remove")}
                                            </Button>
                                        </div>
                                    </div>
                                </CardBody>
                            </Card>
                        ))}
                </CardBody>
            </Card>

            {showAdd && (
                <Modal variant="medium" isOpen onClose={closeAdd}>
                    <ModalHeader title={_("Add SSH Public Key")} />
                    <ModalBody>
                        {addError && <Alert variant="danger" title={addError} isInline style={{ marginBottom: "1rem" }} />}
                        <FormGroup label={_("Label (optional)")} fieldId="key-label">
                            <TextInput
                                id="key-label"
                                value={newKeyLabel}
                                onChange={(_e, val) => setNewKeyLabel(val)}
                                placeholder="user@hostname"
                            />
                        </FormGroup>
                        <FormGroup label={_("Public Key")} fieldId="key-content" style={{ marginTop: "1rem" }}>
                            <TextArea
                                id="key-content"
                                value={newKeyContent}
                                onChange={(_e, val) => setNewKeyContent(val)}
                                placeholder="ssh-ed25519 AAAA... user@host"
                                rows={4}
                            />
                            <Button
                                variant="secondary"
                                onClick={handleGenerateKey}
                                isLoading={generating}
                                isDisabled={generating}
                                style={{ marginTop: "0.5rem" }}
                            >
                                {_("Generate")}
                            </Button>
                        </FormGroup>
                        <RestrictionFields idPrefix="new-key" restrictions={newKeyRestrictions} onChange={setNewKeyRestrictions} />
                        {generatedPrivateKey && (
                            <Alert variant="warning" title={_("Private key generated")} isInline style={{ marginTop: "1rem" }}>
                                {_("Download the private key now. It is discarded when this dialog closes.")}
                                <br />
                                <Button
                                    variant="link"
                                    component="a"
                                    href={privateKeyUrl()}
                                    download={getKeyFilename()}
                                    style={{ paddingLeft: 0, marginTop: "0.5rem" }}
                                >
                                    {_("Download Private Key")}
                                </Button>
                                <div style={{ marginTop: "0.5rem" }}>
                                    {_("If the download fails (Chromium browsers refuse downloads over an untrusted certificate), copy the key into the file instead:")}
                                </div>
                                <ClipboardCopy
                                    isReadOnly
                                    isCode
                                    variant="expansion"
                                    hoverTip={_("Copy private key")}
                                    clickTip={_("Copied")}
                                    style={{ marginTop: "0.25rem" }}
                                >
                                    {generatedPrivateKey}
                                </ClipboardCopy>
                                <div style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
                                    <strong>{_("Setup instructions:")}</strong>
                                    <pre style={{ marginTop: "0.25rem", whiteSpace: "pre-wrap", background: "var(--pf-t--global--background--color--secondary--default)", padding: "0.5rem", borderRadius: "4px" }}>
                                        {setupInstructions}
                                    </pre>
                                </div>
                            </Alert>
                        )}
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="primary" onClick={handleAddKey} isLoading={adding} isDisabled={adding || !newKeyContent.trim()}>
                            {_("Add Key")}
                        </Button>
                        <Button variant="link" onClick={closeAdd}>
                            {_("Cancel")}
                        </Button>
                    </ModalFooter>
                </Modal>
            )}

            {editedKey && (
                <Modal variant="medium" isOpen onClose={() => setEditedKey(null)}>
                    <ModalHeader title={cockpit.format(_("Edit restrictions of $0"), editedKey.comment || editedKey.keyType)} />
                    <ModalBody>
                        {editError && <Alert variant="danger" title={editError} isInline style={{ marginBottom: "1rem" }} />}
                        <div className="key-fingerprint">{fingerprints[editedKey.keyBlob] || editedKey.keyType}</div>
                        <RestrictionFields idPrefix="edit-key" restrictions={editedRestrictions} onChange={setEditedRestrictions} />
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="primary" onClick={handleSaveRestrictions} isLoading={saving} isDisabled={saving}>
                            {_("Save")}
                        </Button>
                        <Button variant="link" onClick={() => setEditedKey(null)}>
                            {_("Cancel")}
                        </Button>
                    </ModalFooter>
                </Modal>
            )}

            <SshdHardeningCard />
        </>
    );
};
