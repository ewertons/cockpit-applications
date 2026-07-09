import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { EmptyState, EmptyStateActions, EmptyStateBody, EmptyStateFooter } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

import cockpit from 'cockpit';

import { CreateTunnelWizard } from './create-tunnel-wizard.jsx';
import {
    WgInterface, loadInterfaces, bringUp, bringDown, setEnabledAtBoot,
    deleteInterface, saveInterface, applyLive, isPeerActive,
} from './wireguard.js';

const _ = cockpit.gettext;

export const TunnelsPage = () => {
    const [interfaces, setInterfaces] = useState<WgInterface[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [editTarget, setEditTarget] = useState<WgInterface | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<WgInterface | null>(null);
    const [deleting, setDeleting] = useState(false);

    const initialLoadDone = useRef(false);

    const refresh = useCallback(async () => {
        if (!initialLoadDone.current)
            setLoading(true);
        try {
            setInterfaces(await loadInterfaces());
            setError(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setLoading(false);
        initialLoadDone.current = true;
    }, []);

    useEffect(() => { refresh() }, [refresh]);

    useEffect(() => {
        const interval = setInterval(refresh, 7000);
        return () => clearInterval(interval);
    }, [refresh]);

    const runAction = async (name: string, action: () => Promise<void>) => {
        setBusy(name);
        setError(null);
        try {
            await action();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setBusy(null);
        refresh();
    };

    const handleDelete = async () => {
        if (!deleteTarget)
            return;
        setDeleting(true);
        setError(null);
        try {
            await deleteInterface(deleteTarget.name);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setDeleting(false);
        setDeleteTarget(null);
        refresh();
    };

    if (loading)
        return <Spinner aria-label={_("Loading tunnels")} />;

    const existingNames = interfaces.map(i => i.name);

    return (
        <div className="wireguard-app">
            <div className="page-header">
                <div className="page-header-title">
                    <h2>{_("WireGuard Tunnels")}</h2>
                    <p>{_("VPN interfaces configured in /etc/wireguard")}</p>
                </div>
                <div className="page-header-actions">
                    <Button variant="secondary" onClick={refresh}>{_("Reload")}</Button>
                    <Button variant="primary" onClick={() => setShowCreate(true)}>{_("Create tunnel")}</Button>
                </div>
            </div>

            {error && (
                <Alert variant="danger" title={_("Error")} isInline style={{ marginBottom: "1rem" }}>
                    {error}
                </Alert>
            )}

            {interfaces.length === 0
                ? (
                    <EmptyState>
                        <EmptyStateBody>
                            {_("No WireGuard tunnels yet. Create one to start adding VPN clients. Existing /etc/wireguard configuration is detected automatically.")}
                        </EmptyStateBody>
                        <EmptyStateFooter>
                            <EmptyStateActions>
                                <Button variant="primary" onClick={() => setShowCreate(true)}>
                                    {_("Create tunnel")}
                                </Button>
                            </EmptyStateActions>
                        </EmptyStateFooter>
                    </EmptyState>
                )
                : (
                    <div className="wg-cards">
                        {interfaces.map(iface => {
                            const connected = iface.peers.filter(isPeerActive).length;
                            const isBusy = busy === iface.name;
                            return (
                                <Card key={iface.name} isCompact>
                                    <CardTitle>
                                        <div className="wg-card-title">
                                            <div className="wg-card-title-left">
                                                <span className="wg-card-name">{iface.name}</span>
                                                <Label color={iface.up ? "green" : "grey"}>
                                                    {iface.up ? _("Active") : _("Inactive")}
                                                </Label>
                                                {iface.enabled && <Label color="blue">{_("Starts at boot")}</Label>}
                                            </div>
                                            <Switch
                                                id={`up-${iface.name}`}
                                                label={iface.up ? _("On") : _("Off")}
                                                isChecked={!!iface.up}
                                                isDisabled={isBusy}
                                                onChange={(_ev, checked) => runAction(iface.name,
                                                                                      () => (checked ? bringUp(iface.name) : bringDown(iface.name)))}
                                            />
                                        </div>
                                    </CardTitle>
                                    <CardBody>
                                        <DescriptionList isCompact isAutoColumnWidths columnModifier={{ default: "2Col" }}>
                                            <DescriptionListGroup>
                                                <DescriptionListTerm>{_("Address")}</DescriptionListTerm>
                                                <DescriptionListDescription>
                                                    {iface.address.join(", ") || "—"}
                                                </DescriptionListDescription>
                                            </DescriptionListGroup>
                                            <DescriptionListGroup>
                                                <DescriptionListTerm>{_("Listen port")}</DescriptionListTerm>
                                                <DescriptionListDescription>
                                                    {iface.listenPort ?? "—"}
                                                </DescriptionListDescription>
                                            </DescriptionListGroup>
                                            <DescriptionListGroup>
                                                <DescriptionListTerm>{_("Public endpoint")}</DescriptionListTerm>
                                                <DescriptionListDescription>
                                                    {iface.publicEndpoint || "—"}
                                                </DescriptionListDescription>
                                            </DescriptionListGroup>
                                            <DescriptionListGroup>
                                                <DescriptionListTerm>{_("Clients")}</DescriptionListTerm>
                                                <DescriptionListDescription>
                                                    {iface.up && iface.peers.length > 0
                                                        ? cockpit.format(_("$0 ($1 connected)"), iface.peers.length, connected)
                                                        : iface.peers.length}
                                                </DescriptionListDescription>
                                            </DescriptionListGroup>
                                        </DescriptionList>

                                        <div className="wg-card-actions">
                                            <Button
                                                variant="primary" size="sm"
                                                onClick={() => cockpit.location.go(["tunnels", iface.name])}
                                            >
                                                {_("Manage clients")}
                                            </Button>
                                            <div className="wg-card-boot">
                                                <Switch
                                                    id={`boot-${iface.name}`}
                                                    label={_("Start at boot")}
                                                    isChecked={!!iface.enabled}
                                                    isDisabled={isBusy}
                                                    onChange={(_ev, checked) => runAction(iface.name,
                                                                                          () => setEnabledAtBoot(iface.name, checked))}
                                                />
                                            </div>
                                            <Button variant="secondary" size="sm" onClick={() => setEditTarget(iface)}>
                                                {_("Edit")}
                                            </Button>
                                            <Button variant="danger" size="sm" onClick={() => setDeleteTarget(iface)}>
                                                {_("Remove")}
                                            </Button>
                                        </div>
                                    </CardBody>
                                </Card>
                            );
                        })}
                    </div>
                )}

            {showCreate && (
                <CreateTunnelWizard
                    existingNames={existingNames}
                    onClose={() => setShowCreate(false)}
                    onSaved={refresh}
                />
            )}

            {editTarget && (
                <EditTunnelDialog
                    iface={editTarget}
                    onClose={() => setEditTarget(null)}
                    onSaved={refresh}
                />
            )}

            {deleteTarget && (
                <Modal variant="small" isOpen onClose={() => setDeleteTarget(null)}>
                    <ModalHeader title={_("Remove tunnel")} />
                    <ModalBody>
                        <p>
                            {cockpit.format(_("Remove tunnel \"$0\"? This brings it down, disables it at boot, and deletes /etc/wireguard/$0.conf."),
                                            deleteTarget.name)}
                        </p>
                        <p style={{ marginTop: "0.5rem", color: "var(--pf-t--global--text--color--subtle)", fontSize: "var(--pf-t--global--font--size--sm)" }}>
                            {_("Client configurations already distributed will stop working.")}
                        </p>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={handleDelete} isLoading={deleting} isDisabled={deleting}>
                            {_("Remove")}
                        </Button>
                        <Button variant="link" onClick={() => setDeleteTarget(null)}>{_("Cancel")}</Button>
                    </ModalFooter>
                </Modal>
            )}
        </div>
    );
};

// --- Edit tunnel dialog ----------------------------------------------------

interface EditTunnelDialogProps {
    iface: WgInterface;
    onClose: () => void;
    onSaved: () => void;
}

function EditTunnelDialog({ iface, onClose, onSaved }: EditTunnelDialogProps) {
    const [address, setAddress] = useState(iface.address.join(", "));
    const [listenPort, setListenPort] = useState(iface.listenPort ? String(iface.listenPort) : "");
    const [publicEndpoint, setPublicEndpoint] = useState(iface.publicEndpoint || "");
    const [clientDns, setClientDns] = useState(iface.clientDns || "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const port = parseInt(listenPort, 10);
    const portValid = listenPort.trim() === "" ? false : !isNaN(port) && port >= 1 && port <= 65535;
    const addressValid = address.split(",").map(s => s.trim())
            .filter(Boolean).length > 0;

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            const updated: WgInterface = {
                ...iface,
                address: address.split(",").map(s => s.trim())
                        .filter(Boolean),
                listenPort: port,
                publicEndpoint: publicEndpoint.trim() || undefined,
                clientDns: clientDns.trim() || undefined,
            };
            await saveInterface(updated);
            if (iface.up) {
                try { await applyLive(iface.name) } catch { /* applied on next restart */ }
            }
            onSaved();
            onClose();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
            setSaving(false);
        }
    };

    return (
        <Modal variant="medium" isOpen onClose={onClose}>
            <ModalHeader title={cockpit.format(_("Edit tunnel $0"), iface.name)} />
            <ModalBody>
                {error && <Alert variant="danger" title={_("Error")} isInline style={{ marginBottom: "1rem" }}>{error}</Alert>}
                <div className="wg-form">
                    <FormGroup label={_("Server address (VPN subnet)")} isRequired fieldId="edit-address">
                        <TextInput
                            id="edit-address" value={address} onChange={(_ev, v) => setAddress(v)}
                            validated={addressValid ? "default" : "error"} placeholder="10.8.0.1/24"
                        />
                    </FormGroup>
                    <FormGroup label={_("Listen port")} isRequired fieldId="edit-port">
                        <TextInput
                            id="edit-port" type="number" value={listenPort} onChange={(_ev, v) => setListenPort(v)}
                            validated={portValid ? "default" : "error"} placeholder="51820"
                        />
                    </FormGroup>
                    <FormGroup label={_("Public endpoint")} fieldId="edit-endpoint">
                        <TextInput
                            id="edit-endpoint" value={publicEndpoint} onChange={(_ev, v) => setPublicEndpoint(v)}
                            placeholder="vpn.example.com"
                        />
                    </FormGroup>
                    <FormGroup label={_("Client DNS")} fieldId="edit-clientdns">
                        <TextInput
                            id="edit-clientdns" value={clientDns} onChange={(_ev, v) => setClientDns(v)}
                            placeholder="1.1.1.1"
                        />
                    </FormGroup>
                </div>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={save} isLoading={saving} isDisabled={saving || !portValid || !addressValid}>
                    {_("Save")}
                </Button>
                <Button variant="link" onClick={onClose}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
