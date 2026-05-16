import React, { useCallback, useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { EmptyState, EmptyStateBody, EmptyStateFooter, EmptyStateActions } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { ClipboardCopy } from "@patternfly/react-core/dist/esm/components/ClipboardCopy/index.js";

import cockpit from 'cockpit';
import { Destination, loadDestinations, saveDestinations, initRepo, createPasswordFile, checkRepo, destEnvVars } from './restic.js';

const _ = cockpit.gettext;

interface DestinationsPageProps {
    destinationId?: string;
}

const DEST_TYPES: { value: Destination["type"]; label: string; description: string }[] = [
    { value: "local", label: "Local Path", description: _("A directory on this machine or a mounted volume") },
    { value: "sftp", label: "SFTP (SSH)", description: _("Remote server via SSH/SFTP") },
    { value: "rest", label: "REST Server", description: _("A restic REST server") },
    { value: "s3", label: "Amazon S3 / MinIO", description: _("S3-compatible object storage") },
    { value: "azure", label: "Azure Blob Storage", description: _("Microsoft Azure blob container") },
    { value: "gcs", label: "Google Cloud Storage", description: _("Google Cloud Storage bucket") },
    { value: "b2", label: "Backblaze B2", description: _("Backblaze B2 cloud storage") },
];

function getRepoPlaceholder(type: string): string {
    switch (type) {
    case "local": return "/mnt/backup/restic-repo";
    case "sftp": return "sftp:user@host:/path/to/repo";
    case "rest": return "rest:http://host:8000/";
    case "s3": return "s3:s3.amazonaws.com/bucket_name/path";
    case "azure": return "azure:container-name:/path";
    case "gcs": return "gs:bucket-name:/path";
    case "b2": return "b2:bucket-name:path/to/repo";
    default: return "";
    }
}

function getEnvVarHints(type: string): { key: string; label: string; secret: boolean }[] {
    switch (type) {
    case "s3": return [
        { key: "AWS_ACCESS_KEY_ID", label: _("Access Key ID"), secret: false },
        { key: "AWS_SECRET_ACCESS_KEY", label: _("Secret Access Key"), secret: true },
        { key: "AWS_DEFAULT_REGION", label: _("Region"), secret: false },
    ];
    case "azure": return [
        { key: "AZURE_ACCOUNT_NAME", label: _("Account Name"), secret: false },
        { key: "AZURE_ACCOUNT_KEY", label: _("Account Key"), secret: true },
    ];
    case "gcs": return [
        { key: "GOOGLE_APPLICATION_CREDENTIALS", label: _("Credentials File Path"), secret: false },
        { key: "GOOGLE_PROJECT_ID", label: _("Project ID"), secret: false },
    ];
    case "b2": return [
        { key: "B2_ACCOUNT_ID", label: _("Account ID"), secret: false },
        { key: "B2_ACCOUNT_KEY", label: _("Account Key"), secret: true },
    ];
    default: return [];
    }
}

export const DestinationsPage = ({ destinationId: _destinationId }: DestinationsPageProps) => {
    const [destinations, setDestinations] = useState<Destination[]>([]);
    const [loading, setLoading] = useState(true);
    const [showDialog, setShowDialog] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [checkingId, setCheckingId] = useState<string | null>(null);

    // Delete confirmation
    const [deleteTarget, setDeleteTarget] = useState<Destination | null>(null);
    const [deleting, setDeleting] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        const d = await loadDestinations();
        setDestinations(d);
        setLoading(false);
    }, []);

    useEffect(() => { refresh() }, [refresh]);

    const handleDelete = async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        const updated = destinations.filter(d => d.id !== deleteTarget.id);
        await saveDestinations(updated);
        setDeleteTarget(null);
        setDeleting(false);
        refresh();
    };

    const handleCheck = async (dest: Destination) => {
        setCheckingId(dest.id);
        setError(null);
        try {
            await checkRepo(dest.path, dest.password_file, destEnvVars(dest));
            setError(null);
            // Briefly show success
            alert(cockpit.format(_("Repository \"$0\" check passed — no errors found."), dest.name));
        } catch (e: any) {
            setError(cockpit.format(_("$0: $1"), dest.name, e.message || String(e)));
        }
        setCheckingId(null);
    };

    const handleSave = async (dest: Destination, password: string) => {
        setError(null);
        try {
            const passwordFile = await createPasswordFile(dest.id, password);
            dest.password_file = passwordFile;

            if (!dest.initialized) {
                try {
                    await initRepo(dest.path, passwordFile, destEnvVars(dest));
                    dest.initialized = true;
                } catch (e: any) {
                    if (e.message?.includes("already initialized") || e.message?.includes("already exists")) {
                        dest.initialized = true;
                    } else {
                        throw e;
                    }
                }
            }

            const updated = [...destinations, dest];
            await saveDestinations(updated);
            setShowDialog(false);
            refresh();
        } catch (e: any) {
            setError(e.message || String(e));
        }
    };

    if (loading) return <Spinner aria-label={_("Loading destinations")} />;

    return (
        <>
            {error && <Alert variant="danger" title={_("Error")} isInline style={{ marginBottom: "1rem" }}>{error}</Alert>}

            {destinations.length === 0
                ? (
                    <EmptyState>
                        <EmptyStateBody>
                            {_("No backup destinations configured. Add a local path or cloud storage to start backing up.")}
                        </EmptyStateBody>
                        <EmptyStateFooter>
                            <EmptyStateActions>
                                <Button variant="primary" onClick={() => setShowDialog(true)}>
                                    {_("Add Destination")}
                                </Button>
                            </EmptyStateActions>
                        </EmptyStateFooter>
                    </EmptyState>
                )
                : (
                    <>
                        <div className="page-header">
                            <div className="page-header-actions">
                                <Button variant="primary" onClick={() => setShowDialog(true)}>
                                    {_("Add Destination")}
                                </Button>
                            </div>
                        </div>
                        <div className="destination-cards">
                            {destinations.map(dest => {
                                const typeInfo = DEST_TYPES.find(t => t.value === dest.type);
                                return (
                                    <Card key={dest.id} isCompact>
                                        <CardTitle>
                                            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                                                <span style={{ fontWeight: "bold" }}>{dest.name}</span>
                                                <Label color={dest.initialized ? "green" : "orange"}>
                                                    {typeInfo?.label || dest.type}
                                                </Label>
                                            </div>
                                        </CardTitle>
                                        <CardBody>
                                            <DescriptionList isCompact>
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>{_("Repository")}</DescriptionListTerm>
                                                    <DescriptionListDescription>
                                                        <span className="dest-path">{dest.path}</span>
                                                    </DescriptionListDescription>
                                                </DescriptionListGroup>
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>{_("Status")}</DescriptionListTerm>
                                                    <DescriptionListDescription>
                                                        {dest.initialized
                                                            ? <Label color="green">{_("Initialized")}</Label>
                                                            : <Label color="orange">{_("Not initialized")}</Label>}
                                                    </DescriptionListDescription>
                                                </DescriptionListGroup>
                                                {typeInfo && (
                                                    <DescriptionListGroup>
                                                        <DescriptionListTerm>{_("Type")}</DescriptionListTerm>
                                                        <DescriptionListDescription>{typeInfo.description}</DescriptionListDescription>
                                                    </DescriptionListGroup>
                                                )}
                                            </DescriptionList>

                                            <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
                                                <Button
variant="secondary" size="sm" onClick={() => handleCheck(dest)}
                                                isLoading={checkingId === dest.id} isDisabled={checkingId === dest.id}
                                                >
                                                    {_("Check Integrity")}
                                                </Button>
                                                <Button variant="danger" size="sm" onClick={() => setDeleteTarget(dest)}>
                                                    {_("Remove")}
                                                </Button>
                                            </div>
                                        </CardBody>
                                    </Card>
                                );
                            })}
                        </div>
                    </>
                )}

            {showDialog && <DestinationDialog onSave={handleSave} onClose={() => setShowDialog(false)} />}

            {deleteTarget && (
                <Modal variant="small" isOpen onClose={() => setDeleteTarget(null)}>
                    <ModalHeader title={_("Remove Destination")} />
                    <ModalBody>
                        <Alert variant="info" title={_("Backup data will NOT be deleted.")} isInline />
                        <p style={{ marginTop: "0.5rem" }}>
                            {cockpit.format(_("Remove \"$0\" from your configured destinations?"), deleteTarget.name)}
                        </p>
                        <p style={{ marginTop: "0.25rem", fontSize: "var(--pf-t--global--font--size--sm)", color: "var(--pf-t--global--text--color--subtle)" }}>
                            {_("The backup repository and its data will remain intact. You can re-add it later.")}
                        </p>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={handleDelete} isLoading={deleting} isDisabled={deleting}>
                            {_("Remove")}
                        </Button>
                        <Button variant="link" onClick={() => setDeleteTarget(null)}>
                            {_("Cancel")}
                        </Button>
                    </ModalFooter>
                </Modal>
            )}
        </>
    );
};

// --- Add Destination dialog ---

interface DestinationDialogProps {
    onSave: (dest: Destination, password: string) => void;
    onClose: () => void;
}

function DestinationDialog({ onSave, onClose }: DestinationDialogProps) {
    const [name, setName] = useState('');
    const [type, setType] = useState<Destination["type"]>("local");
    const [path, setPath] = useState('');
    const [password, setPassword] = useState('');
    const [passwordConfirm, setPasswordConfirm] = useState('');
    const [envVars, setEnvVars] = useState<Record<string, string>>({});
    const [sshKey, setSshKey] = useState('');
    const [sshPubKey, setSshPubKey] = useState('');
    const [generatingKey, setGeneratingKey] = useState(false);

    const envHints = getEnvVarHints(type);
    const passwordMismatch = password && passwordConfirm && password !== passwordConfirm;

    const handleGenerateKey = async () => {
        setGeneratingKey(true);
        try {
            const keyDir = "/etc/cockpit-backup/ssh-keys";
            const keyName = `backup-${Date.now()}`;
            const keyPath = `${keyDir}/${keyName}`;
            await cockpit.spawn(["mkdir", "-p", keyDir], { superuser: "try" });
            await cockpit.spawn(
                ["ssh-keygen", "-t", "ed25519", "-f", keyPath, "-N", "", "-C", `cockpit-backup@${window.location.hostname}`],
                { superuser: "try", err: "message" }
            );
            await cockpit.spawn(["chmod", "600", keyPath], { superuser: "try" });
            const pubKey = await cockpit.spawn(["cat", `${keyPath}.pub`], { superuser: "try" });
            setSshKey(keyPath);
            setSshPubKey(pubKey.trim());
        } catch (e: any) {
            setSshPubKey('');
            alert(cockpit.format(_("Failed to generate SSH key: $0"), e.message || String(e)));
        }
        setGeneratingKey(false);
    };

    const handleSubmit = () => {
        const dest: Destination = {
            id: crypto.randomUUID(),
            name,
            type,
            path,
            password_file: '', // set by parent
            env_vars: Object.keys(envVars).length > 0 ? envVars : undefined,
            ssh_key: type === 'sftp' && sshKey.trim() ? sshKey.trim() : undefined,
            initialized: false,
        };
        onSave(dest, password);
    };

    const canSubmit = name.trim() && path.trim() && password && password === passwordConfirm;

    return (
        <Modal variant="medium" isOpen onClose={onClose}>
            <ModalHeader title={_("Add Backup Destination")} />
            <ModalBody>
                <div className="job-form">
                    <FormGroup
label={_("Name")} isRequired fieldId="dest-name"
                        helperText={_("A friendly name for this destination")}
                    >
                        <TextInput
id="dest-name" value={name} onChange={(_ev, val) => setName(val)}
                            placeholder={_("External Drive")}
                        />
                    </FormGroup>

                    <FormGroup label={_("Storage Type")} isRequired fieldId="dest-type">
                        <FormSelect id="dest-type" value={type} onChange={(_ev, val) => { setType(val as Destination["type"]); setPath(''); setEnvVars({}) }}>
                            {DEST_TYPES.map(t => (
                                <FormSelectOption key={t.value} value={t.value} label={`${t.label} — ${t.description}`} />
                            ))}
                        </FormSelect>
                    </FormGroup>

                    <FormGroup
label={_("Repository Path")} isRequired fieldId="dest-path"
                        helperText={cockpit.format(_("Full restic repository URI for $0"), DEST_TYPES.find(t => t.value === type)?.label || type)}
                    >
                        <TextInput
id="dest-path" value={path} onChange={(_ev, val) => setPath(val)}
                            placeholder={getRepoPlaceholder(type)}
                        />
                    </FormGroup>

                    {type === 'sftp' && (
                        <Card isFlat isCompact>
                            <CardTitle>{_("SSH Authentication")}</CardTitle>
                            <CardBody>
                                <FormGroup
label={_("SSH Private Key Path")} fieldId="dest-ssh-key"
                                    helperText={_("Path to the private key used to connect to the remote server.")}
                                >
                                    <div style={{ display: "flex", gap: "0.5rem" }}>
                                        <TextInput
id="dest-ssh-key" value={sshKey}
                                            onChange={(_ev, val) => { setSshKey(val); setSshPubKey('') }}
                                            placeholder="/etc/cockpit-backup/ssh-keys/backup-key"
                                            style={{ flex: 1 }}
                                        />
                                        <Button
variant="secondary" onClick={handleGenerateKey}
                                            isLoading={generatingKey} isDisabled={generatingKey}
                                        >
                                            {_("Generate Key")}
                                        </Button>
                                    </div>
                                </FormGroup>
                                {sshPubKey && (
                                    <FormGroup
label={_("Public Key")} fieldId="dest-ssh-pubkey"
                                        helperText={_("Copy this key and add it to the remote user's authorized keys.")}
                                    >
                                        <ClipboardCopy isReadOnly hoverTip={_("Copy")} clickTip={_("Copied")}>
                                            {sshPubKey}
                                        </ClipboardCopy>
                                    </FormGroup>
                                )}
                            </CardBody>
                        </Card>
                    )}

                    <FormGroup
label={_("Encryption Password")} isRequired fieldId="dest-password"
                        helperText={_("Encrypts all backup data. Stored automatically at /etc/cockpit-backup/passwords/ — but save a copy somewhere safe as a backup.")}
                    >
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                            <TextInput
id="dest-password" type="password" value={password}
                                onChange={(_ev, val) => setPassword(val)} style={{ flex: 1 }}
                            />
                            <Button
variant="secondary" onClick={() => {
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    const generated = btoa(String.fromCharCode(...arr)).replace(/[/+=]/g, '')
            .slice(0, 32);
    setPassword(generated);
    setPasswordConfirm(generated);
}}
                            >{_("Generate")}
                            </Button>
                        </div>
                    </FormGroup>

                    <FormGroup
label={_("Confirm Password")} isRequired fieldId="dest-password-confirm"
                        validated={passwordMismatch ? "error" : "default"}
                        helperTextInvalid={_("Passwords do not match")}
                    >
                        <TextInput
id="dest-password-confirm" type="password" value={passwordConfirm}
                            onChange={(_ev, val) => setPasswordConfirm(val)}
                            validated={passwordMismatch ? "error" : "default"}
                        />
                    </FormGroup>

                    {envHints.length > 0 && (
                        <Card isFlat isCompact>
                            <CardTitle>{_("Cloud Credentials")}</CardTitle>
                            <CardBody>
                                <p style={{ marginBottom: "0.75rem", color: "var(--pf-t--global--text--color--subtle)", fontSize: "var(--pf-t--global--font--size--sm)" }}>
                                    {cockpit.format(_("Required for $0 access"), DEST_TYPES.find(t => t.value === type)?.label || type)}
                                </p>
                                {envHints.map(hint => (
                                    <FormGroup key={hint.key} label={hint.label} fieldId={`env-${hint.key}`}>
                                        <TextInput
                                            id={`env-${hint.key}`}
                                            type={hint.secret ? "password" : "text"}
                                            value={envVars[hint.key] || ''}
                                            onChange={(_ev, val) => setEnvVars({ ...envVars, [hint.key]: val })}
                                            placeholder={hint.key}
                                        />
                                    </FormGroup>
                                ))}
                            </CardBody>
                        </Card>
                    )}
                </div>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={handleSubmit} isDisabled={!canSubmit}>
                    {_("Save & Initialize")}
                </Button>
                <Button variant="link" onClick={onClose}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
