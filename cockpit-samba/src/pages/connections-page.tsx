import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";

import cockpit from 'cockpit';

import { ErrorAlert, PageHeader, SimpleTable } from '../components.jsx';
import { disconnectSession, errorMessage, readSambaStatus } from '../samba-backend.js';
import { SambaSession, SambaStatus } from '../status.js';

const _ = cockpit.gettext;

const REFRESH_MILLISECONDS = 10000;

export const ConnectionsPage = () => {
    const [status, setStatus] = useState<SambaStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [disconnecting, setDisconnecting] = useState<SambaSession | null>(null);

    const load = useCallback(() => {
        readSambaStatus().then(loaded => {
            setStatus(loaded);
            setError(null);
        }, loadError => setError(errorMessage(loadError)));
    }, []);

    useEffect(() => {
        load();
        const timer = window.setInterval(load, REFRESH_MILLISECONDS);
        return () => window.clearInterval(timer);
    }, [load]);

    const disconnect = (session: SambaSession) => {
        disconnectSession(session.processId)
                .then(() => {
                    setDisconnecting(null);
                    load();
                }, disconnectError => {
                    setDisconnecting(null);
                    setError(errorMessage(disconnectError));
                });
    };

    const smb1Sessions = status?.sessions.filter(session => session.isSmb1) ?? [];

    const sessionRows = (status?.sessions ?? []).map(session => [
        session.userName,
        session.remoteMachine,
        session.clientAddress.replace(/^ipv[46]:/, ""),
        session.isSmb1
            ? <Label key="dialect" isCompact color="red">{session.dialect} (SMB1)</Label>
            : <Label key="dialect" isCompact color="blue">{session.dialect}</Label>,
        session.encryption,
        session.signing,
        session.shares.join(", "),
        String(session.processId),
        <Button key="disconnect" variant="secondary" size="sm" isDanger onClick={() => setDisconnecting(session)}>{_("Disconnect")}</Button>,
    ]);

    const fileRows = (status?.openFiles ?? []).map(file => [
        file.path, file.access, file.shareMode, file.oplock, String(file.processId), file.openedAt,
    ]);

    const lockRows = (status?.locks ?? []).map(lock => [
        lock.path, lock.type, lock.flavour, String(lock.start), String(lock.size), String(lock.processId),
    ]);

    return (
        <>
            <PageHeader
                title={_("Connections")}
                description={status?.version ? cockpit.format(_("Samba $0. Refreshed every 10 seconds."), status.version) : _("Refreshed every 10 seconds.")}
                actions={<Button variant="secondary" onClick={load}>{_("Refresh")}</Button>}
            />
            <ErrorAlert error={error} title={_("Cannot read the Samba status")} />
            {smb1Sessions.length > 0 &&
                <Alert variant="warning" isInline className="smb-alert" title={cockpit.format(_("$0 client(s) use SMB1"), smb1Sessions.length)}>
                    {smb1Sessions.map(session => `${session.remoteMachine} (${session.userName})`).join(", ")}
                </Alert>}
            {!status && !error && <Spinner aria-label={_("Loading")} />}
            {status &&
                <>
                    <Card isCompact className="smb-card">
                        <CardTitle>{_("Sessions")}</CardTitle>
                        <CardBody>
                            <SimpleTable
                                headers={[_("User"), _("Machine"), _("Address"), _("Protocol"), _("Encryption"), _("Signing"), _("Shares"), _("Process"), ""]}
                                rows={sessionRows} emptyText={_("No clients are connected.")}
                            />
                        </CardBody>
                    </Card>
                    <Card isCompact className="smb-card">
                        <CardTitle>{_("Open files")}</CardTitle>
                        <CardBody>
                            <SimpleTable headers={[_("File"), _("Access"), _("Share mode"), _("Oplock"), _("Process"), _("Opened")]} rows={fileRows} emptyText={_("No open files.")} />
                        </CardBody>
                    </Card>
                    <Card isCompact className="smb-card">
                        <CardTitle>{_("Byte-range locks")}</CardTitle>
                        <CardBody>
                            <SimpleTable headers={[_("File"), _("Type"), _("Flavour"), _("Start"), _("Size"), _("Process")]} rows={lockRows} emptyText={_("No locks.")} />
                        </CardBody>
                    </Card>
                </>}
            {disconnecting &&
                <Modal isOpen variant="small" aria-labelledby="disconnect-title" onClose={() => setDisconnecting(null)}>
                    <ModalHeader title={cockpit.format(_("Disconnect $0?"), disconnecting.remoteMachine)} labelId="disconnect-title" titleIconVariant="warning" />
                    <ModalBody>
                        {_("The smbd process serving this client is stopped. Unsaved data in its open files may be lost, and the client may reconnect automatically. To keep it out, change hosts allow or disable its user first.")}
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={() => disconnect(disconnecting)}>{_("Disconnect")}</Button>
                        <Button variant="link" onClick={() => setDisconnecting(null)}>{_("Cancel")}</Button>
                    </ModalFooter>
                </Modal>}
        </>
    );
};
