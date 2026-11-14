import React, { useMemo, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

import cockpit from 'cockpit';

import { StepWizard, WizardStepDef } from './stepper.jsx';
import { ClientConfigView, sanitizeFileName } from './client-config-view.jsx';
import { LanAccessField } from './lan-access-field.jsx';
import {
    WgInterface, WgPeer, genKeypair, genPresharedKey, pubkeyFromPrivate,
    saveInterface, applyLive, nextClientIp, buildClientConfig, resolveClientEndpoint,
    browserEndpointHost, endpointHost, isLoopbackHost, parseLanAccessList,
    clientAllowedIpsFor, convertLegacyFirewall,
} from './wireguard.js';

const _ = cockpit.gettext;

interface AddClientWizardProps {
    iface: WgInterface;
    onClose: () => void;
    onSaved: () => void;
}

export function AddClientWizard({ iface, onClose, onSaved }: AddClientWizardProps) {
    const [name, setName] = useState("");
    const [clientIp, setClientIp] = useState(() => nextClientIp(iface) || "");
    const [endpointOverride, setEndpointOverride] = useState("");
    const [fullTunnel, setFullTunnel] = useState(true);
    const [lanAccessText, setLanAccessText] = useState("");
    const [usePsk, setUsePsk] = useState(true);
    const [clientConfig, setClientConfig] = useState<string | null>(null);
    const [warning, setWarning] = useState<string | null>(null);

    const browserHost = browserEndpointHost();
    const defaultEndpoint = resolveClientEndpoint(iface.publicEndpoint, browserHost, iface.listenPort);
    const overrideText = endpointOverride.trim();
    const overrideIsLoopback = !!overrideText && isLoopbackHost(endpointHost(overrideText));
    const endpoint = overrideIsLoopback
        ? null
        : resolveClientEndpoint(overrideText || iface.publicEndpoint, browserHost, iface.listenPort);
    const endpointError = overrideIsLoopback
        ? _("Clients cannot reach a loopback address. Enter the public host or IP of this server.")
        : !endpoint
            ? _("No public endpoint is set for this tunnel. Enter the public host or IP clients use to reach this server (add :port if your router forwards another port), or set it in the tunnel settings.")
            : null;
    const lanAccess = useMemo(() => parseLanAccessList(lanAccessText), [lanAccessText]);
    const lanAccessErrors = fullTunnel ? [] : lanAccess.errors;

    const ipValid = /^\d{1,3}(\.\d{1,3}){3}$/.test(clientIp.trim()) &&
        clientIp.trim().split(".")
                .every(o => parseInt(o, 10) <= 255);
    const nameValid = name.trim().length > 0;

    const createClient = async (): Promise<boolean> => {
        const kp = await genKeypair();
        const psk = usePsk ? await genPresharedKey() : undefined;

        let serverPub = iface.publicKey;
        if (!serverPub && iface.privateKey)
            serverPub = await pubkeyFromPrivate(iface.privateKey);
        if (!serverPub)
            throw new Error(_("Could not determine the server public key."));

        if (!endpoint)
            throw new Error(endpointError || _("No endpoint"));
        const allowedIps = clientAllowedIpsFor(iface, fullTunnel, lanAccess.entries);

        const config = buildClientConfig({
            clientPrivateKey: kp.privateKey,
            clientAddress: `${clientIp.trim()}/32`,
            serverPublicKey: serverPub,
            presharedKey: psk,
            endpoint,
            dns: iface.clientDns,
            allowedIps,
            persistentKeepalive: 25,
        });

        // Store the client key + tunnel choice (as `#` comments) so the config
        // and QR code can be viewed again later from the client's details.
        const peer: WgPeer = {
            name: name.trim(),
            publicKey: kp.publicKey,
            privateKey: kp.privateKey,
            presharedKey: psk,
            allowedIps: [`${clientIp.trim()}/32`],
            clientAllowedIps: allowedIps,
            lanAccess: fullTunnel ? undefined : lanAccess.entries,
            clientEndpoint: overrideText || undefined,
            extraLines: [],
        };
        const convertedIface = convertLegacyFirewall(iface);
        const updatedIface: WgInterface = { ...convertedIface, peers: [...convertedIface.peers, peer] };
        await saveInterface(updatedIface);
        if (iface.up) {
            try {
                await applyLive(updatedIface, iface.firewallManagement);
            } catch (e: unknown) {
                setWarning(cockpit.format(_("The client was saved, but the running tunnel could not be updated ($0). Restart the tunnel to apply it."),
                                          e instanceof Error ? e.message : String(e)));
            }
        }

        setClientConfig(config);
        onSaved();
        return true;
    };

    const steps: WizardStepDef[] = [
        {
            id: "details",
            name: _("Client"),
            canContinue: nameValid && ipValid && !endpointError && lanAccessErrors.length === 0,
            nextLabel: _("Create client"),
            onNext: createClient,
            content: (
                <div className="wg-form">
                    <FormGroup label={_("Client name")} isRequired fieldId="wg-client-name">
                        <TextInput
                            id="wg-client-name" value={name} onChange={(_ev, v) => setName(v)}
                            placeholder={_("phone, laptop, ...")}
                        />
                    </FormGroup>

                    <FormGroup label={_("Client address")} isRequired fieldId="wg-client-ip">
                        <TextInput
                            id="wg-client-ip" value={clientIp} onChange={(_ev, v) => setClientIp(v)}
                            validated={clientIp && !ipValid ? "error" : "default"}
                            placeholder="10.8.0.2"
                        />
                        <HelperText>
                            <HelperTextItem variant={clientIp && !ipValid ? "error" : "default"}>
                                {_("Address assigned to this client inside the VPN. Prefilled with the next free address.")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>

                    <FormGroup label={_("Endpoint")} fieldId="wg-client-endpoint">
                        <TextInput
                            id="wg-client-endpoint" value={endpointOverride} onChange={(_ev, v) => setEndpointOverride(v)}
                            placeholder={defaultEndpoint || "vpn.example.com:51820"}
                            validated={endpointError ? "error" : "default"}
                        />
                        <HelperText>
                            <HelperTextItem variant={endpointError ? "error" : "default"}>
                                {endpointError ||
                                    (defaultEndpoint
                                        ? cockpit.format(_("Where this client connects. Leave blank to use the tunnel default ($0)."), defaultEndpoint)
                                        : _("Where this client connects."))}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>

                    <FormGroup fieldId="wg-client-full" label={_("Traffic")}>
                        <Switch
                            id="wg-client-full"
                            label={_("Route all of the client's traffic through the VPN (full tunnel)")}
                            isChecked={fullTunnel} onChange={(_ev, c) => setFullTunnel(c)}
                        />
                        <HelperText>
                            <HelperTextItem>
                                {_("Off means the client only reaches the VPN subnet and its LAN access entries (split tunnel).")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>

                    {!fullTunnel && (
                        <LanAccessField
                            id="wg-client-lan-access" value={lanAccessText} onChange={setLanAccessText}
                            errors={lanAccessErrors} firewallManagement={iface.firewallManagement}
                        />
                    )}

                    <FormGroup fieldId="wg-client-psk" label={_("Security")}>
                        <Switch
                            id="wg-client-psk"
                            label={_("Use a preshared key (recommended)")}
                            isChecked={usePsk} onChange={(_ev, c) => setUsePsk(c)}
                        />
                        <HelperText>
                            <HelperTextItem>
                                {_("Adds a symmetric key for extra protection against future attacks.")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>
                </div>
            ),
        },
        {
            id: "ready",
            name: _("Ready"),
            hideBack: true,
            canContinue: true,
            cancelLabel: _("Done"),
            content: (
                <div className="wg-form">
                    {warning && <Alert variant="warning" isInline title={warning} />}
                    <HelperText>
                        <HelperTextItem variant="success">
                            {_("Client created. Share this configuration now — you can also view or re-download it later from the client's details.")}
                        </HelperTextItem>
                    </HelperText>

                    {clientConfig && <ClientConfigView config={clientConfig} fileName={sanitizeFileName(name)} />}
                </div>
            ),
        },
    ];

    return (
        <StepWizard
            title={cockpit.format(_("Add client to $0"), iface.name)}
            steps={steps}
            onClose={onClose}
            onFinish={onClose}
            finishLabel={_("Done")}
            variant="large"
        />
    );
}
