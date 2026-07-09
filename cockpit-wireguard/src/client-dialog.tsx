import React, { useMemo, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

import cockpit from 'cockpit';

import { ClientConfigView, sanitizeFileName } from './client-config-view.jsx';
import {
    WgInterface, WgPeer, buildClientConfig, genKeypair, genPresharedKey,
    saveInterface, applyLive, serverSubnetCidr, resolveClientEndpoint,
} from './wireguard.js';

const _ = cockpit.gettext;

interface ClientDialogProps {
    iface: WgInterface;
    peer: WgPeer;
    onClose: () => void;
    onSaved: () => void;
}

export function ClientDialog({ iface, peer, onClose, onSaved }: ClientDialogProps) {
    const [originalPubKey, setOriginalPubKey] = useState(peer.publicKey);

    const [name, setName] = useState(peer.name || "");
    const [clientIp, setClientIp] = useState(peer.allowedIps[0]?.split("/")[0] || "");
    const [fullTunnel, setFullTunnel] = useState(
        peer.clientAllowedIps ? peer.clientAllowedIps.includes("0.0.0.0/0") : true);
    const [usePsk, setUsePsk] = useState(!!peer.presharedKey);
    const [psk, setPsk] = useState<string | undefined>(peer.presharedKey);
    const [keys, setKeys] = useState<{ privateKey: string; publicKey: string } | null>(
        peer.privateKey ? { privateKey: peer.privateKey, publicKey: peer.publicKey } : null);
    const [endpointOverride, setEndpointOverride] = useState(peer.clientEndpoint || "");

    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    const defaultEndpoint = resolveClientEndpoint(iface.publicEndpoint, window.location.hostname, iface.listenPort);

    const ipValid = /^\d{1,3}(\.\d{1,3}){3}$/.test(clientIp.trim()) &&
        clientIp.trim().split(".")
                .every(o => parseInt(o, 10) <= 255);
    const nameValid = name.trim().length > 0;

    const config = useMemo(() => {
        if (!keys || !iface.publicKey || !ipValid)
            return null;
        return buildClientConfig({
            clientPrivateKey: keys.privateKey,
            clientAddress: `${clientIp.trim()}/32`,
            serverPublicKey: iface.publicKey,
            presharedKey: usePsk ? psk : undefined,
            endpoint: resolveClientEndpoint(endpointOverride.trim() || iface.publicEndpoint, window.location.hostname, iface.listenPort),
            dns: iface.clientDns,
            allowedIps: fullTunnel ? "0.0.0.0/0, ::/0" : serverSubnetCidr(iface),
            persistentKeepalive: 25,
        });
    }, [keys, iface, clientIp, ipValid, usePsk, psk, fullTunnel, endpointOverride]);

    const regenerateKeys = async () => {
        setBusy(true);
        setError(null);
        try {
            setKeys(await genKeypair());
            setSaved(false);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setBusy(false);
    };

    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            let finalPsk = psk;
            if (usePsk && !finalPsk)
                finalPsk = await genPresharedKey();
            if (!usePsk)
                finalPsk = undefined;
            setPsk(finalPsk);

            const updatedPeer: WgPeer = {
                ...peer,
                name: name.trim() || undefined,
                publicKey: keys?.publicKey ?? peer.publicKey,
                privateKey: keys?.privateKey,
                presharedKey: finalPsk,
                allowedIps: [`${clientIp.trim()}/32`],
                clientAllowedIps: fullTunnel ? "0.0.0.0/0, ::/0" : serverSubnetCidr(iface),
                clientEndpoint: endpointOverride.trim() || undefined,
            };

            const updatedIface: WgInterface = {
                ...iface,
                peers: iface.peers.map(p => (p.publicKey === originalPubKey ? updatedPeer : p)),
            };

            await saveInterface(updatedIface);
            if (iface.up) {
                try { await applyLive(iface.name) } catch { /* applied on next restart */ }
            }
            setOriginalPubKey(updatedPeer.publicKey);
            setSaved(true);
            onSaved();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setBusy(false);
    };

    return (
        <Modal variant="large" isOpen onClose={onClose}>
            <ModalHeader title={cockpit.format(_("Client: $0"), peer.name || _("(unnamed)"))} />
            <ModalBody>
                {error && <Alert variant="danger" title={_("Error")} isInline style={{ marginBottom: "1rem" }}>{error}</Alert>}
                {saved && (
                    <Alert
                        variant="success" title={_("Changes saved.")} isInline
                        style={{ marginBottom: "1rem" }}
                    />
                )}

                <div className="wg-form">
                    <FormGroup label={_("Client name")} isRequired fieldId="edit-client-name">
                        <TextInput
                            id="edit-client-name" value={name}
                            onChange={(_ev, v) => { setName(v); setSaved(false) }}
                            validated={nameValid ? "default" : "error"}
                        />
                    </FormGroup>

                    <FormGroup label={_("Client address")} isRequired fieldId="edit-client-ip">
                        <TextInput
                            id="edit-client-ip" value={clientIp}
                            onChange={(_ev, v) => { setClientIp(v); setSaved(false) }}
                            validated={ipValid ? "default" : "error"}
                            placeholder="10.8.0.2"
                        />
                    </FormGroup>

                    <FormGroup label={_("Endpoint")} fieldId="edit-client-endpoint">
                        <TextInput
                            id="edit-client-endpoint" value={endpointOverride}
                            onChange={(_ev, v) => { setEndpointOverride(v); setSaved(false) }}
                            placeholder={defaultEndpoint}
                        />
                        <HelperText>
                            <HelperTextItem>
                                {cockpit.format(_("Where this client connects. Leave blank to use the tunnel default ($0)."), defaultEndpoint)}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>

                    <FormGroup fieldId="edit-client-full" label={_("Traffic")}>
                        <Switch
                            id="edit-client-full"
                            label={_("Route all of the client's traffic through the VPN (full tunnel)")}
                            isChecked={fullTunnel} onChange={(_ev, c) => { setFullTunnel(c); setSaved(false) }}
                        />
                    </FormGroup>

                    <FormGroup fieldId="edit-client-psk" label={_("Security")}>
                        <Switch
                            id="edit-client-psk"
                            label={_("Use a preshared key (recommended)")}
                            isChecked={usePsk} onChange={(_ev, c) => { setUsePsk(c); setSaved(false) }}
                        />
                    </FormGroup>
                </div>

                <Divider style={{ margin: "1.25rem 0" }} />

                {config
                    ? (
                        <>
                            <HelperText style={{ marginBottom: "0.75rem" }}>
                                <HelperTextItem variant="indeterminate">
                                    {_("Configuration and QR code for this client. Click Save to apply any changes above to the server before sharing.")}
                                </HelperTextItem>
                            </HelperText>
                            <ClientConfigView config={config} fileName={sanitizeFileName(name)} />
                            <div style={{ marginTop: "0.75rem" }}>
                                <Button variant="link" isInline onClick={regenerateKeys} isDisabled={busy}>
                                    {_("Regenerate keys")}
                                </Button>
                                <span className="wg-muted" style={{ marginInlineStart: "0.5rem", fontSize: "var(--pf-t--global--font--size--sm)" }}>
                                    {_("Issues a new key pair; the client's current configuration will stop working once saved.")}
                                </span>
                            </div>
                        </>
                    )
                    : (
                        <Alert variant="info" isInline title={_("No stored configuration for this client")}>
                            <p>
                                {_("This client was added outside the dashboard, so its private key is not stored and its original configuration cannot be shown.")}
                            </p>
                            <p style={{ marginTop: "0.5rem" }}>
                                <Button variant="secondary" onClick={regenerateKeys} isLoading={busy} isDisabled={busy}>
                                    {_("Generate a new key pair")}
                                </Button>
                            </p>
                            <p style={{ marginTop: "0.5rem", fontSize: "var(--pf-t--global--font--size--sm)" }}>
                                {_("This re-issues the client with a fresh configuration and QR code. Save to apply it — the client's old configuration will stop working.")}
                            </p>
                        </Alert>
                    )}
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={save} isLoading={busy} isDisabled={busy || !nameValid || !ipValid}>
                    {_("Save")}
                </Button>
                <Button variant="link" onClick={onClose}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
}
