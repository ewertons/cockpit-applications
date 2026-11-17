import React, { useCallback, useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

import cockpit from 'cockpit';

import { LinuxAccount, SambaUser } from '../accounts.js';
import { ConfigurationPageProps } from '../app.jsx';
import { ErrorAlert, PageHeader, SimpleTable } from '../components.jsx';
import { listShareNames, splitList } from '../model.js';
import {
    addSambaUser,
    createSystemUser,
    deleteSambaUser,
    errorMessage,
    listLinuxGroups,
    listLinuxUsers,
    listSambaUsers,
    setSambaPassword,
    setSambaUserEnabled,
} from '../samba-backend.js';
import { getParameter } from '../smb-conf.js';
import { validateNewUserName, validatePassword } from '../validation.js';

const _ = cockpit.gettext;

/** Lowest uid/gid of regular accounts on Debian and Ubuntu. */
const FIRST_REGULAR_ID = 1000;

const PasswordFields = ({ password, confirmation, onPassword, onConfirmation }: {
    password: string;
    confirmation: string;
    onPassword: (value: string) => void;
    onConfirmation: (value: string) => void;
}) => {
    const error = password || confirmation ? validatePassword(password, confirmation) : null;
    return (
        <>
            <FormGroup label={_("Samba password")} fieldId="samba-password" isRequired>
                <TextInput id="samba-password" type="password" autoComplete="new-password" value={password} onChange={(_event, text) => onPassword(text)} />
            </FormGroup>
            <FormGroup label={_("Confirm password")} fieldId="samba-password-confirm" isRequired>
                <TextInput id="samba-password-confirm" type="password" autoComplete="new-password" value={confirmation} validated={error ? "error" : "default"} onChange={(_event, text) => onConfirmation(text)} />
                {error && <HelperText><HelperTextItem variant="error">{_(error)}</HelperTextItem></HelperText>}
            </FormGroup>
        </>
    );
};

const AddUserDialog = ({ linuxUsers, sambaUsers, onClose, onDone }: { linuxUsers: LinuxAccount[]; sambaUsers: SambaUser[]; onClose: () => void; onDone: () => void }) => {
    const candidates = linuxUsers.filter(user => !sambaUsers.some(samba => samba.userName === user.name) &&
        (user.id >= FIRST_REGULAR_ID || user.shell.endsWith("nologin")) && user.name !== "nobody");
    const [mode, setMode] = useState<"existing" | "create">(candidates.length > 0 ? "existing" : "create");
    const [existing, setExisting] = useState(candidates[0]?.name ?? "");
    const [newName, setNewName] = useState("");
    const [password, setPassword] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Linux user created by this dialog whose Samba step failed; a retry only redoes the Samba step.
    const [createdLinuxUser, setCreatedLinuxUser] = useState<string | null>(null);

    const userName = mode === "existing" ? existing : newName;
    const needsLinuxUser = mode === "create" && newName !== createdLinuxUser;
    const nameError = needsLinuxUser && newName
        ? validateNewUserName(newName) ?? (linuxUsers.some(user => user.name === newName) ? "A Linux user with this name exists; choose \"Existing Linux user\"" : null)
        : null;
    const valid = userName !== "" && !nameError && validatePassword(password, confirmation) === null;

    const submit = async () => {
        setBusy(true);
        setError(null);
        let linuxUserCreated = mode === "create" && !needsLinuxUser;
        try {
            if (needsLinuxUser) {
                await createSystemUser(userName);
                linuxUserCreated = true;
                setCreatedLinuxUser(userName);
            }
            await addSambaUser(userName, password);
            onDone();
        } catch (addError) {
            setError(linuxUserCreated
                ? cockpit.format(_("Linux user $0 was created, but adding the Samba account failed: $1"), userName, errorMessage(addError))
                : errorMessage(addError));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal isOpen variant="small" aria-labelledby="add-user-title" onClose={onClose}>
            <ModalHeader title={_("Add Samba user")} labelId="add-user-title" />
            <ModalBody>
                <ErrorAlert error={error} />
                <Form onSubmit={event => event.preventDefault()}>
                    <FormGroup role="radiogroup" label={_("Account")} fieldId="user-mode" isStack>
                        <Radio id="user-mode-existing" name="user-mode" label={_("Existing Linux user")} isChecked={mode === "existing"} isDisabled={candidates.length === 0 || createdLinuxUser !== null} onChange={() => setMode("existing")} />
                        <Radio
                            id="user-mode-create" name="user-mode" isChecked={mode === "create"} onChange={() => setMode("create")}
                            label={_("New system user without login (Samba only, e.g. for a scanner)")}
                        />
                    </FormGroup>
                    {mode === "existing"
                        ? (
                            <FormGroup label={_("Linux user")} fieldId="user-existing">
                                <FormSelect id="user-existing" value={existing} onChange={(_event, value) => setExisting(value)}>
                                    {candidates.map(user => <FormSelectOption key={user.name} value={user.name} label={user.name} />)}
                                </FormSelect>
                            </FormGroup>)
                        : (
                            <FormGroup label={_("User name")} fieldId="user-new" isRequired>
                                <TextInput id="user-new" value={newName} validated={nameError ? "error" : "default"} isDisabled={createdLinuxUser !== null} onChange={(_event, text) => setNewName(text)} />
                                {nameError && <HelperText><HelperTextItem variant="error">{_(nameError)}</HelperTextItem></HelperText>}
                            </FormGroup>)}
                    <PasswordFields password={password} confirmation={confirmation} onPassword={setPassword} onConfirmation={setConfirmation} />
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" isDisabled={!valid || busy} isLoading={busy} onClick={() => { submit() }}>{_("Add")}</Button>
                <Button variant="link" isDisabled={busy} onClick={onClose}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

const PasswordDialog = ({ userName, onClose }: { userName: string; onClose: () => void }) => {
    const [password, setPassword] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = () => {
        setBusy(true);
        setSambaPassword(userName, password)
                .then(onClose)
                .catch(passwordError => setError(errorMessage(passwordError)))
                .finally(() => setBusy(false));
    };
    return (
        <Modal isOpen variant="small" aria-labelledby="password-title" onClose={onClose}>
            <ModalHeader title={cockpit.format(_("Set Samba password for $0"), userName)} labelId="password-title" />
            <ModalBody>
                <ErrorAlert error={error} />
                <Form onSubmit={event => event.preventDefault()}>
                    <PasswordFields password={password} confirmation={confirmation} onPassword={setPassword} onConfirmation={setConfirmation} />
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" isDisabled={busy || validatePassword(password, confirmation) !== null} isLoading={busy} onClick={submit}>{_("Set password")}</Button>
                <Button variant="link" isDisabled={busy} onClick={onClose}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

const DeleteDialog = ({ userName, onClose, onDone }: { userName: string; onClose: () => void; onDone: () => void }) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    return (
        <Modal isOpen variant="small" aria-labelledby="delete-user-title" onClose={onClose}>
            <ModalHeader title={cockpit.format(_("Delete Samba user $0?"), userName)} labelId="delete-user-title" titleIconVariant="warning" />
            <ModalBody>
                <ErrorAlert error={error} />
                <p>{_("The Samba account and its password are removed. The Linux user and its files are kept.")}</p>
            </ModalBody>
            <ModalFooter>
                <Button
                    variant="danger" isDisabled={busy} isLoading={busy}
                    onClick={() => {
                        setBusy(true);
                        deleteSambaUser(userName).then(onDone, deleteError => {
                            setError(errorMessage(deleteError));
                            setBusy(false);
                        });
                    }}
                >
                    {_("Delete")}
                </Button>
                <Button variant="link" isDisabled={busy} onClick={onClose}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

type UserDialog = { kind: "add" } | { kind: "password" | "delete"; userName: string };

export const UsersPage = ({ document }: ConfigurationPageProps) => {
    const [sambaUsers, setSambaUsers] = useState<SambaUser[] | null>(null);
    const [linuxUsers, setLinuxUsers] = useState<LinuxAccount[]>([]);
    const [groups, setGroups] = useState<LinuxAccount[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [dialog, setDialog] = useState<UserDialog | null>(null);

    const load = useCallback(() => {
        listSambaUsers().then(users => {
            setSambaUsers(users);
            setError(null);
        }, loadError => {
            setSambaUsers([]);
            setError(errorMessage(loadError));
        });
        listLinuxUsers().then(setLinuxUsers, () => setLinuxUsers([]));
        listLinuxGroups().then(setGroups, () => setGroups([]));
    }, []);

    useEffect(load, [load]);

    const shares = listShareNames(document);
    /** @returns shares whose valid users name the account directly or through @group. */
    const sharesOf = (userName: string) => shares.filter(share => {
        const tokens = splitList(getParameter(document, share, "valid users") ?? "");
        return tokens.includes(userName) || groups.some(group => group.members.includes(userName) && tokens.some(token => token.replace(/^[@+&]+/, "") === group.name && token !== group.name));
    });

    const toggle = (user: SambaUser) => {
        setSambaUserEnabled(user.userName, user.disabled)
                .then(load, toggleError => setError(errorMessage(toggleError)));
    };

    const userRows = (sambaUsers ?? []).map(user => [
        user.userName,
        user.fullName,
        user.disabled ? <Label key="state" isCompact>{_("Disabled")}</Label> : <Label key="state" isCompact color="green">{_("Enabled")}</Label>,
        user.passwordLastSet,
        sharesOf(user.userName).join(", "),
        <span key="actions" className="smb-row-actions">
            <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "password", userName: user.userName })}>{_("Set password")}</Button>
            <Button variant="secondary" size="sm" onClick={() => toggle(user)}>{user.disabled ? _("Enable") : _("Disable")}</Button>
            <Button variant="secondary" size="sm" isDanger onClick={() => setDialog({ kind: "delete", userName: user.userName })}>{_("Delete")}</Button>
        </span>,
    ]);

    const groupRows = groups.filter(group => group.id >= FIRST_REGULAR_ID || group.name === "sambashare" || group.name === "users")
            .filter(group => group.id !== 65534)
            .map(group => [`@${group.name}`, String(group.id), group.members.join(", ")]);

    const done = () => {
        setDialog(null);
        load();
    };

    return (
        <>
            <PageHeader
                title={_("Users")}
                description={_("Samba accounts (tdbsam). Each one maps to a Linux user that owns the files it writes.")}
                actions={<Button variant="primary" onClick={() => setDialog({ kind: "add" })}>{_("Add user")}</Button>}
            />
            <ErrorAlert error={error} />
            <Card isCompact className="smb-card">
                <CardTitle>{_("Samba users")}</CardTitle>
                <CardBody>
                    {sambaUsers === null
                        ? <Spinner size="md" aria-label={_("Loading")} />
                        : <SimpleTable headers={[_("User"), _("Full name"), _("State"), _("Password set"), _("Shares"), ""]} rows={userRows} emptyText={_("No Samba users.")} />}
                </CardBody>
            </Card>
            <Card isCompact className="smb-card">
                <CardTitle>{_("Groups")}</CardTitle>
                <CardBody>
                    <p className="smb-muted">{_("Linux groups can be used in valid users, write list and the other user lists as @group. Manage membership in Accounts.")}</p>
                    <SimpleTable headers={[_("Group"), _("GID"), _("Members")]} rows={groupRows} emptyText={_("No regular groups.")} />
                </CardBody>
            </Card>
            {dialog?.kind === "add" && <AddUserDialog linuxUsers={linuxUsers} sambaUsers={sambaUsers ?? []} onClose={() => setDialog(null)} onDone={done} />}
            {dialog?.kind === "password" && <PasswordDialog userName={dialog.userName} onClose={() => setDialog(null)} />}
            {dialog?.kind === "delete" && <DeleteDialog userName={dialog.userName} onClose={() => setDialog(null)} onDone={done} />}
        </>
    );
};
