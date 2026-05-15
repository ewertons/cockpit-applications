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

import cockpit from 'cockpit';

const _ = cockpit.gettext;
const AUTH_KEYS_PATH = "/srv/git/.ssh/authorized_keys";

interface SSHKey {
    type: string;
    key: string;
    comment: string;
    line: number;
}

function parseAuthorizedKeys(content: string): SSHKey[] {
    return content.trim().split("\n").filter(Boolean).map((line, i) => {
        // Skip comment lines
        if (line.startsWith("#")) return null;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) return null;
        return {
            type: parts[0],
            key: parts[1],
            comment: parts.slice(2).join(" "),
            line: i,
        };
    }).filter(Boolean) as SSHKey[];
}

function fingerprint(key: string): string {
    // Show a truncated version of the key as a simple fingerprint display
    if (key.length > 20) {
        return key.substring(0, 10) + "..." + key.substring(key.length - 10);
    }
    return key;
}

const SSH_KEY_REGEX = /^(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/=]+/;

export const AccessPage = () => {
    const [keys, setKeys] = useState<SSHKey[]>([]);
    const [rawContent, setRawContent] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [gitoliteDetected, setGitoliteDetected] = useState(false);

    // Add key modal
    const [showAdd, setShowAdd] = useState(false);
    const [newKeyContent, setNewKeyContent] = useState("");
    const [newKeyLabel, setNewKeyLabel] = useState("");
    const [addError, setAddError] = useState("");
    const [adding, setAdding] = useState(false);

    const loadKeys = useCallback(() => {
        setLoading(true);
        setError("");

        // Check for Gitolite
        cockpit.spawn(["test", "-d", "/srv/git/.gitolite"], { superuser: "try", err: "ignore" })
                .then(() => setGitoliteDetected(true))
                .catch(() => setGitoliteDetected(false));

        cockpit.file(AUTH_KEYS_PATH).read()
                .then((content: string) => {
                    setRawContent(content || "");
                    setKeys(parseAuthorizedKeys(content || ""));
                    setLoading(false);
                })
                .catch((ex: cockpit.BasicError) => {
                    if (ex.problem === "not-found") {
                        setRawContent("");
                        setKeys([]);
                    } else {
                        setError(ex.message || String(ex));
                    }
                    setLoading(false);
                });
    }, []);

    useEffect(() => { loadKeys() }, [loadKeys]);

    const handleAddKey = () => {
        const keyContent = newKeyContent.trim();
        if (!keyContent) return;

        // Validate SSH key format
        if (!SSH_KEY_REGEX.test(keyContent)) {
            setAddError(_("Invalid SSH public key format. Key must start with a valid key type (e.g. ssh-rsa, ssh-ed25519)."));
            return;
        }

        setAdding(true);
        setAddError("");

        // Append key with optional comment
        let newLine = keyContent;
        if (newKeyLabel.trim() && !keyContent.split(/\s+/).slice(2).join(" ")) {
            newLine = keyContent + " " + newKeyLabel.trim();
        }

        const newContent = rawContent ? rawContent.trimEnd() + "\n" + newLine + "\n" : newLine + "\n";

        // Ensure .ssh directory exists first
        cockpit.spawn(["mkdir", "-p", "/srv/git/.ssh"], { superuser: "require" })
                .then(() => cockpit.spawn(["chmod", "700", "/srv/git/.ssh"], { superuser: "require" }))
                .then(() => cockpit.file(AUTH_KEYS_PATH, { superuser: true }).replace(newContent))
                .then(() => cockpit.spawn(["chmod", "600", AUTH_KEYS_PATH], { superuser: "require" }))
                .then(() => cockpit.spawn(["chown", "-R", "git:git", "/srv/git/.ssh"], { superuser: "require" }))
                .then(() => {
                    setShowAdd(false);
                    setNewKeyContent("");
                    setNewKeyLabel("");
                    setAdding(false);
                    loadKeys();
                })
                .catch((ex: cockpit.BasicError) => {
                    setAddError(ex.message || String(ex));
                    setAdding(false);
                });
    };

    const handleRemoveKey = (keyToRemove: SSHKey) => {
        const lines = rawContent.split("\n");
        const newLines = lines.filter((_line, i) => i !== keyToRemove.line);
        const newContent = newLines.join("\n");

        cockpit.file(AUTH_KEYS_PATH, { superuser: true }).replace(newContent)
                .then(() => loadKeys())
                .catch((ex: cockpit.BasicError) => setError(ex.message || String(ex)));
    };

    if (loading) return <Spinner aria-label={_("Loading")} />;

    return (
        <>
            <CardTitle>{_("Access Control")}</CardTitle>

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
                                            <Label color="blue" style={{ marginRight: "0.5rem" }}>{k.type}</Label>
                                            <strong>{k.comment || _("(no label)")}</strong>
                                            <div className="key-fingerprint" style={{ marginTop: "0.25rem" }}>
                                                {fingerprint(k.key)}
                                            </div>
                                        </div>
                                        <Button variant="danger" onClick={() => handleRemoveKey(k)}>
                                            {_("Remove")}
                                        </Button>
                                    </div>
                                </CardBody>
                            </Card>
                        ))}
                </CardBody>
            </Card>

            {showAdd && (
                <Modal variant="medium" isOpen onClose={() => { setShowAdd(false); setAddError("") }}>
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
                        </FormGroup>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="primary" onClick={handleAddKey} isLoading={adding} isDisabled={adding || !newKeyContent.trim()}>
                            {_("Add Key")}
                        </Button>
                        <Button variant="link" onClick={() => { setShowAdd(false); setAddError("") }}>
                            {_("Cancel")}
                        </Button>
                    </ModalFooter>
                </Modal>
            )}
        </>
    );
};
