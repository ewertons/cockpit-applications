import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { ClipboardCopy } from "@patternfly/react-core/dist/esm/components/ClipboardCopy/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { EmptyState, EmptyStateActions, EmptyStateBody, EmptyStateFooter } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";

import cockpit from 'cockpit';

import { AddClientWizard } from './add-client-wizard.jsx';
import { ClientDialog } from './client-dialog.jsx';
import {
    WgInterface, WgPeer, loadInterfaces, saveInterface, applyLive,
    handshakeAgo, handshakeAbsolute, formatBytes, isPeerActive,
} from './wireguard.js';

const _ = cockpit.gettext;

interface TunnelDetailPageProps {
    tunnelName: string;
}

export const TunnelDetailPage = ({ tunnelName }: TunnelDetailPageProps) => {
    const [iface, setIface] = useState<WgInterface | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showAdd, setShowAdd] = useState(false);
    const [editTarget, setEditTarget] = useState<WgPeer | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<WgPeer | null>(null);
    const [deleting, setDeleting] = useState(false);

    const initialLoadDone = useRef(false);

    const refresh = useCallback(async () => {
        if (!initialLoadDone.current)
            setLoading(true);
        try {
            const all = await loadInterfaces();
            setIface(all.find(i => i.name === tunnelName) || null);
            setError(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setLoading(false);
        initialLoadDone.current = true;
    }, [tunnelName]);

    useEffect(() => { refresh() }, [refresh]);

    useEffect(() => {
        const interval = setInterval(refresh, 7000);
        return () => clearInterval(interval);
    }, [refresh]);

    const handleDeletePeer = async () => {
        if (!iface || !deleteTarget)
            return;
        setDeleting(true);
        setError(null);
        try {
            const updated: WgInterface = {
                ...iface,
                peers: iface.peers.filter(p => p.publicKey !== deleteTarget.publicKey),
            };
            await saveInterface(updated);
            if (iface.up) {
                try { await applyLive(iface.name) } catch { /* applied on next restart */ }
            }
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setDeleting(false);
        setDeleteTarget(null);
        refresh();
    };

    if (loading)
        return <Spinner aria-label={_("Loading tunnel")} />;

    if (!iface) {
        return (
            <div className="wireguard-app">
                <Alert variant="warning" title={_("Tunnel not found")} isInline>
                    {cockpit.format(_("No configuration found for \"$0\"."), tunnelName)}
                </Alert>
                <div style={{ marginTop: "1rem" }}>
                    <Button variant="link" onClick={() => cockpit.location.go([])}>
                        {_("Back to tunnels")}
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="wireguard-app">
            <div className="page-header">
                <div className="page-header-title">
                    <div className="wg-breadcrumb">
                        <Button variant="link" isInline onClick={() => cockpit.location.go([])}>
                            {_("Tunnels")}
                        </Button>
                        <span className="wg-breadcrumb-sep">/</span>
                        <span>{iface.name}</span>
                    </div>
                    <h2>
                        {iface.name}{" "}
                        <Label color={iface.up ? "green" : "grey"}>
                            {iface.up ? _("Active") : _("Inactive")}
                        </Label>
                    </h2>
                </div>
                <div className="page-header-actions">
                    <Button variant="secondary" onClick={refresh}>{_("Reload")}</Button>
                    <Button variant="primary" onClick={() => setShowAdd(true)}>{_("Add client")}</Button>
                </div>
            </div>

            {error && (
                <Alert variant="danger" title={_("Error")} isInline style={{ marginBottom: "1rem" }}>
                    {error}
                </Alert>
            )}

            <Card isCompact className="wg-summary-card">
                <CardBody>
                    <DescriptionList isCompact isAutoColumnWidths columnModifier={{ default: "2Col" }}>
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Address")}</DescriptionListTerm>
                            <DescriptionListDescription>{iface.address.join(", ") || "—"}</DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Listen port")}</DescriptionListTerm>
                            <DescriptionListDescription>{iface.listenPort ?? "—"}</DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Public endpoint")}</DescriptionListTerm>
                            <DescriptionListDescription>{iface.publicEndpoint || "—"}</DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Server public key")}</DescriptionListTerm>
                            <DescriptionListDescription>
                                {iface.publicKey
                                    ? (
                                        <ClipboardCopy isReadOnly hoverTip={_("Copy")} clickTip={_("Copied")} variant="inline-compact">
                                            {iface.publicKey}
                                        </ClipboardCopy>
                                    )
                                    : "—"}
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                    </DescriptionList>
                </CardBody>
            </Card>

            <Card isCompact>
                <CardTitle>{cockpit.format(_("Clients ($0)"), iface.peers.length)}</CardTitle>
                <CardBody>
                    {iface.peers.length === 0
                        ? (
                            <EmptyState>
                                <EmptyStateBody>
                                    {_("No clients yet. Add one to generate a ready-to-use configuration and QR code.")}
                                </EmptyStateBody>
                                <EmptyStateFooter>
                                    <EmptyStateActions>
                                        <Button variant="primary" onClick={() => setShowAdd(true)}>{_("Add client")}</Button>
                                    </EmptyStateActions>
                                </EmptyStateFooter>
                            </EmptyState>
                        )
                        : (
                            <table className="wg-peer-table">
                                <thead>
                                    <tr>
                                        <th>{_("Name")}</th>
                                        <th>{_("Address")}</th>
                                        <th>{_("Latest handshake")}</th>
                                        <th>{_("Transfer")}</th>
                                        <th className="wg-peer-actions-col" aria-label={_("Actions")} />
                                    </tr>
                                </thead>
                                <tbody>
                                    {iface.peers.map(peer => {
                                        const active = isPeerActive(peer);
                                        return (
                                            <tr key={peer.publicKey}>
                                                <td>
                                                    <span className={"wg-peer-dot " + (active ? "active" : "")} />
                                                    {peer.name || <span className="wg-muted">{_("(unnamed)")}</span>}
                                                </td>
                                                <td>{peer.allowedIps.join(", ") || "—"}</td>
                                                <td>
                                                    {iface.up
                                                        ? (
                                                            <span title={handshakeAbsolute(peer.latestHandshake || 0)}>
                                                                {handshakeAgo(peer.latestHandshake || 0)}
                                                            </span>
                                                        )
                                                        : <span className="wg-muted">{_("Tunnel inactive")}</span>}
                                                </td>
                                                <td>
                                                    {iface.up && (peer.transferRx || peer.transferTx)
                                                        ? cockpit.format(_("↓ $0  ↑ $1"),
                                                                         formatBytes(peer.transferRx || 0), formatBytes(peer.transferTx || 0))
                                                        : "—"}
                                                </td>
                                                <td className="wg-peer-actions">
                                                    <Button variant="secondary" size="sm" onClick={() => setEditTarget(peer)}>
                                                        {_("Edit / Config")}
                                                    </Button>
                                                    <Button variant="danger" size="sm" onClick={() => setDeleteTarget(peer)}>
                                                        {_("Remove")}
                                                    </Button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                </CardBody>
            </Card>

            {showAdd && (
                <AddClientWizard
                    iface={iface}
                    onClose={() => setShowAdd(false)}
                    onSaved={refresh}
                />
            )}

            {editTarget && (
                <ClientDialog
                    iface={iface}
                    peer={editTarget}
                    onClose={() => setEditTarget(null)}
                    onSaved={refresh}
                />
            )}

            {deleteTarget && (
                <Modal variant="small" isOpen onClose={() => setDeleteTarget(null)}>
                    <ModalHeader title={_("Remove client")} />
                    <ModalBody>
                        <p>
                            {cockpit.format(_("Remove client \"$0\" from $1? Its configuration will stop working immediately."),
                                            deleteTarget.name || _("(unnamed)"), iface.name)}
                        </p>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={handleDeletePeer} isLoading={deleting} isDisabled={deleting}>
                            {_("Remove")}
                        </Button>
                        <Button variant="link" onClick={() => setDeleteTarget(null)}>{_("Cancel")}</Button>
                    </ModalFooter>
                </Modal>
            )}
        </div>
    );
};
