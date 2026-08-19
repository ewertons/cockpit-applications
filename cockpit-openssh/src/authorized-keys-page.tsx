import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Table, Tbody, Td, Th, Thead, Tr } from "@patternfly/react-table/dist/esm/components/Table/index.js";

import cockpit from 'cockpit';

import {
    AuthorizedKey, SystemUser,
    authorizedKeysPathFor, keyInfo, listUsers, readKeys, removeKey,
} from './authorized-keys.js';
import { EffectiveConfig, effectiveValue, getEffectiveConfig } from './openssh.js';
import { AddClientWizard } from './add-client-wizard.jsx';

const _ = cockpit.gettext;

export const AuthorizedKeysPage = () => {
    const [loading, setLoading] = useState(true);
    const [users, setUsers] = useState<SystemUser[]>([]);
    const [showSystem, setShowSystem] = useState(false);
    const [selected, setSelected] = useState("");
    const [effective, setEffective] = useState<EffectiveConfig>({});
    const [keys, setKeys] = useState<AuthorizedKey[]>([]);
    const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState<AuthorizedKey | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const all = await listUsers();
                setUsers(all);
                setEffective(await getEffectiveConfig());
                const me = await cockpit.user();
                setSelected(all.some(u => u.name === me.name) ? me.name : (all[0]?.name ?? ""));
            } catch (e: unknown) {
                setError(e instanceof Error ? e.message : String(e));
            }
            setLoading(false);
        })();
    }, []);

    const user = users.find(u => u.name === selected) ?? null;
    const path = user ? authorizedKeysPathFor(user, effective) : "";

    const loadKeys = useCallback(async () => {
        if (!path) {
            setKeys([]);
            return;
        }
        const loaded = await readKeys(path);
        setKeys(loaded);

        const map: Record<string, string> = {};
        for (const key of loaded) {
            try {
                map[key.blob] = (await keyInfo(`${key.type} ${key.blob}`)).fingerprint;
            } catch { /* unreadable key, show it without a fingerprint */ }
        }
        setFingerprints(map);
    }, [path]);

    useEffect(() => {
        loadKeys().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, [loadKeys]);

    const confirmRemove = async () => {
        if (!user || !removing)
            return;
        setBusy(true);
        setError(null);
        try {
            await removeKey(user, path, removing.raw);
            setRemoving(null);
            await loadKeys();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setBusy(false);
    };

    if (loading)
        return <Spinner />;

    const visibleUsers = users.filter(u => showSystem || !u.isSystem);
    const keysCommand = effectiveValue(effective, "authorizedkeyscommand");

    return (
        <>
            {error && (
                <Alert variant="danger" title={_("Error")} isInline className="pf-v6-u-mb-md">
                    {error}
                </Alert>
            )}

            <Card>
                <CardTitle>{_("Authorized keys")}</CardTitle>
                <CardBody>
                    <Flex className="ssh-toolbar" gap={{ default: "gapMd" }} alignItems={{ default: "alignItemsFlexEnd" }}>
                        <FlexItem>
                            <FormGroup label={_("Account")} fieldId="ssh-account">
                                <FormSelect
                                    id="ssh-account"
                                    value={selected}
                                    onChange={(_event, value) => setSelected(value)}
                                >
                                    {visibleUsers.map(candidate => (
                                        <FormSelectOption
                                            key={candidate.name}
                                            value={candidate.name}
                                            label={candidate.isSystem
                                                ? cockpit.format(_("$0 (system)"), candidate.name)
                                                : candidate.name}
                                        />
                                    ))}
                                </FormSelect>
                            </FormGroup>
                        </FlexItem>
                        <FlexItem>
                            <Checkbox
                                id="ssh-show-system"
                                label={_("Show system accounts")}
                                isChecked={showSystem}
                                onChange={(_event, value) => setShowSystem(value)}
                            />
                        </FlexItem>
                        <FlexItem align={{ default: "alignRight" }}>
                            <Button variant="primary" onClick={() => setAdding(true)} isDisabled={!user}>
                                {_("Add client")}
                            </Button>
                        </FlexItem>
                    </Flex>

                    {path && (
                        <div className="ssh-provenance pf-v6-u-mb-md">
                            {cockpit.format(_("Keys are stored in $0"), path)}
                        </div>
                    )}

                    {keysCommand && keysCommand !== "none" && (
                        <Alert
                            variant="warning"
                            isInline
                            className="pf-v6-u-mb-md"
                            title={_("Keys may also come from somewhere else")}
                        >
                            {cockpit.format(
                                _("AuthorizedKeysCommand is set to $0. sshd can accept keys supplied by that program in addition to, or instead of, the file shown here."),
                                keysCommand)}
                        </Alert>
                    )}

                    <Table aria-label={_("Authorized keys")} variant="compact">
                        <Thead>
                            <Tr>
                                <Th>{_("Comment")}</Th>
                                <Th>{_("Type")}</Th>
                                <Th>{_("Fingerprint")}</Th>
                                <Th>{_("Options")}</Th>
                                <Th screenReaderText={_("Actions")} />
                            </Tr>
                        </Thead>
                        <Tbody>
                            {keys.length === 0
                                ? (
                                    <Tr>
                                        <Td colSpan={5}>{_("No keys are authorized for this account.")}</Td>
                                    </Tr>
                                )
                                : keys.map(key => (
                                    <Tr key={key.raw}>
                                        <Td>{key.comment || <span className="ssh-provenance">{_("no comment")}</span>}</Td>
                                        <Td><Label isCompact>{key.type}</Label></Td>
                                        <Td><span className="ssh-mono">{fingerprints[key.blob] ?? ""}</span></Td>
                                        <Td><span className="ssh-mono">{key.options}</span></Td>
                                        <Td isActionCell>
                                            <Button variant="danger" isDisabled={busy} onClick={() => setRemoving(key)}>
                                                {_("Remove")}
                                            </Button>
                                        </Td>
                                    </Tr>
                                ))}
                        </Tbody>
                    </Table>
                </CardBody>
            </Card>

            {adding && user && (
                <AddClientWizard
                    user={user}
                    path={path}
                    port={effectiveValue(effective, "port") || "22"}
                    onClose={() => setAdding(false)}
                    onAdded={() => {
                        setAdding(false);
                        loadKeys().catch(() => undefined);
                    }}
                />
            )}

            {removing && (
                <Modal variant="small" isOpen onClose={() => setRemoving(null)}>
                    <ModalHeader title={_("Remove key?")} />
                    <ModalBody>
                        <p>
                            {cockpit.format(
                                _("$0 will no longer be able to log in as $1 with this key."),
                                removing.comment || _("The client holding this key"),
                                selected)}
                        </p>
                        <pre className="ssh-snippet">{removing.raw}</pre>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={confirmRemove} isLoading={busy} isDisabled={busy}>
                            {_("Remove")}
                        </Button>
                        <Button variant="link" onClick={() => setRemoving(null)}>{_("Cancel")}</Button>
                    </ModalFooter>
                </Modal>
            )}
        </>
    );
};
