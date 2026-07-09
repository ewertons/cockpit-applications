import React, { useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { ClipboardCopy } from "@patternfly/react-core/dist/esm/components/ClipboardCopy/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

import cockpit from 'cockpit';

import { StepWizard, WizardStepDef } from './stepper.jsx';
import {
    WgInterface, genKeypair, saveInterface, bringUp, setEnabledAtBoot,
    firewalldActive, openFirewallPort, natRules, isValidInterfaceName,
} from './wireguard.js';

const _ = cockpit.gettext;

interface CreateTunnelWizardProps {
    existingNames: string[];
    onClose: () => void;
    onSaved: () => void;
}

function defaultName(existing: string[]): string {
    for (let i = 0; i < 100; i++) {
        const candidate = `wg${i}`;
        if (!existing.includes(candidate))
            return candidate;
    }
    return "wg0";
}

function isValidAddress(addr: string): boolean {
    const m = addr.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
    if (!m)
        return false;
    for (let i = 1; i <= 4; i++) {
        const o = parseInt(m[i], 10);
        if (o > 255)
            return false;
    }
    const prefix = parseInt(m[5], 10);
    return prefix >= 0 && prefix <= 32;
}

export function CreateTunnelWizard({ existingNames, onClose, onSaved }: CreateTunnelWizardProps) {
    const [name, setName] = useState(() => defaultName(existingNames));
    const [address, setAddress] = useState("10.8.0.1/24");
    const [listenPort, setListenPort] = useState("51820");
    const [publicEndpoint, setPublicEndpoint] = useState(() => window.location.hostname);
    const [clientDns, setClientDns] = useState("1.1.1.1");
    const [nat, setNat] = useState(true);

    const [keys, setKeys] = useState<{ privateKey: string; publicKey: string } | null>(null);
    const [generating, setGenerating] = useState(true);

    const [firewalld, setFirewalld] = useState(false);
    const [openFirewall, setOpenFirewall] = useState(true);
    const [enableBoot, setEnableBoot] = useState(true);
    const [activateNow, setActivateNow] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const kp = await genKeypair();
                if (!cancelled)
                    setKeys(kp);
            } catch {
                if (!cancelled)
                    setKeys(null);
            }
            if (!cancelled)
                setGenerating(false);
            const fw = await firewalldActive();
            if (!cancelled) {
                setFirewalld(fw);
                setOpenFirewall(fw);
            }
        })();
        return () => { cancelled = true };
    }, []);

    const regenerate = async () => {
        setGenerating(true);
        try {
            setKeys(await genKeypair());
        } catch {
            setKeys(null);
        }
        setGenerating(false);
    };

    const port = parseInt(listenPort, 10);
    const nameError = !name.trim()
        ? _("Required")
        : !isValidInterfaceName(name)
            ? _("Use up to 15 letters, digits, or - _ . = + characters")
            : existingNames.includes(name)
                ? _("A tunnel with this name already exists")
                : null;
    const addressValid = isValidAddress(address);
    const portValid = !isNaN(port) && port >= 1 && port <= 65535;

    const doCreate = async () => {
        if (!keys)
            throw new Error(_("Server keys were not generated. Go back and regenerate them."));

        const iface: WgInterface = {
            name: name.trim(),
            privateKey: keys.privateKey,
            address: [address.trim()],
            listenPort: port,
            publicEndpoint: publicEndpoint.trim() || undefined,
            clientDns: clientDns.trim() || undefined,
            peers: [],
            extraInterfaceLines: [],
        };
        if (nat) {
            const rules = natRules();
            iface.extraInterfaceLines!.push(...rules.postUp, ...rules.postDown);
        }

        await saveInterface(iface);

        if (openFirewall && firewalld) {
            try { await openFirewallPort(port) } catch { /* best-effort */ }
        }
        if (enableBoot)
            await setEnabledAtBoot(name.trim(), true);
        if (activateNow)
            await bringUp(name.trim());

        onSaved();
        onClose();
    };

    const steps: WizardStepDef[] = [
        {
            id: "basics",
            name: _("Interface"),
            canContinue: !nameError && addressValid && portValid,
            content: (
                <div className="wg-form">
                    <FormGroup label={_("Tunnel name")} isRequired fieldId="wg-name">
                        <TextInput
                            id="wg-name" value={name} onChange={(_ev, v) => setName(v)}
                            validated={nameError ? "error" : "default"} placeholder="wg0"
                        />
                        <HelperText>
                            <HelperTextItem variant={nameError ? "error" : "default"}>
                                {nameError || _("The interface name, e.g. wg0. This becomes /etc/wireguard/<name>.conf")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>

                    <FormGroup label={_("Server address (VPN subnet)")} isRequired fieldId="wg-address">
                        <TextInput
                            id="wg-address" value={address} onChange={(_ev, v) => setAddress(v)}
                            validated={address && !addressValid ? "error" : "default"}
                            placeholder="10.8.0.1/24"
                        />
                        <HelperText>
                            <HelperTextItem variant={address && !addressValid ? "error" : "default"}>
                                {_("This server's address inside the VPN, with subnet. Clients get addresses from this range.")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>

                    <FormGroup label={_("Listen port")} isRequired fieldId="wg-port">
                        <TextInput
                            id="wg-port" type="number" value={listenPort} onChange={(_ev, v) => setListenPort(v)}
                            validated={listenPort && !portValid ? "error" : "default"}
                            placeholder="51820"
                        />
                        <HelperText>
                            <HelperTextItem variant={listenPort && !portValid ? "error" : "default"}>
                                {_("UDP port WireGuard listens on. Clients connect to this port.")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>
                </div>
            ),
        },
        {
            id: "access",
            name: _("Server & clients"),
            canContinue: !generating && !!keys && !!publicEndpoint.trim(),
            content: (
                <div className="wg-form">
                    <FormGroup label={_("Server public key")} fieldId="wg-pubkey">
                        {generating
                            ? <Spinner size="md" aria-label={_("Generating keys")} />
                            : keys
                                ? (
                                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                                        <ClipboardCopy isReadOnly hoverTip={_("Copy")} clickTip={_("Copied")} style={{ flex: 1 }}>
                                            {keys.publicKey}
                                        </ClipboardCopy>
                                        <Button variant="secondary" onClick={regenerate}>{_("Regenerate")}</Button>
                                    </div>
                                )
                                : <span>{_("Key generation failed — check that WireGuard is installed.")}</span>}
                        <HelperText>
                            <HelperTextItem>
                                {_("Generated automatically. The private key is stored only on this server.")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>

                    <FormGroup label={_("Public endpoint")} isRequired fieldId="wg-endpoint">
                        <TextInput
                            id="wg-endpoint" value={publicEndpoint} onChange={(_ev, v) => setPublicEndpoint(v)}
                            placeholder="vpn.example.com or vpn.example.com:51820"
                        />
                        <HelperText>
                            <HelperTextItem>
                                {_("The public hostname or IP clients use to reach this server — for example a DDNS name for your router. Add \":port\" if your router forwards a different external port to the listen port.")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>

                    <FormGroup label={_("Client DNS")} fieldId="wg-clientdns">
                        <TextInput
                            id="wg-clientdns" value={clientDns} onChange={(_ev, v) => setClientDns(v)}
                            placeholder="1.1.1.1"
                        />
                        <HelperText>
                            <HelperTextItem>
                                {_("Optional DNS server pushed to clients. Leave blank to keep the client's own DNS.")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>

                    <FormGroup fieldId="wg-nat" label={_("Routing")}>
                        <Switch
                            id="wg-nat" label={_("Route all client traffic through this server (full tunnel + NAT)")}
                            isChecked={nat} onChange={(_ev, checked) => setNat(checked)}
                        />
                        <HelperText>
                            <HelperTextItem>
                                {_("Adds masquerading and enables IP forwarding so clients reach the internet through this server. Turn off for split-tunnel (VPN subnet only).")}
                            </HelperTextItem>
                        </HelperText>
                    </FormGroup>
                </div>
            ),
        },
        {
            id: "options",
            name: _("Finish"),
            canContinue: true,
            content: (
                <div className="wg-form">
                    <p className="wg-review">
                        {cockpit.format(_("Tunnel $0 will serve the $1 subnet on UDP port $2."),
                                        name, address, listenPort)}
                    </p>
                    {firewalld && (
                        <Checkbox
                            id="wg-openfw"
                            label={cockpit.format(_("Open UDP port $0 in the firewall (firewalld)"), listenPort)}
                            isChecked={openFirewall} onChange={(_ev, c) => setOpenFirewall(c)}
                        />
                    )}
                    <Checkbox
                        id="wg-boot"
                        label={_("Start automatically at boot")}
                        isChecked={enableBoot} onChange={(_ev, c) => setEnableBoot(c)}
                    />
                    <Checkbox
                        id="wg-now"
                        label={_("Activate the tunnel now")}
                        isChecked={activateNow} onChange={(_ev, c) => setActivateNow(c)}
                    />
                </div>
            ),
        },
    ];

    return (
        <StepWizard
            title={_("Create WireGuard tunnel")}
            steps={steps}
            onClose={onClose}
            onFinish={doCreate}
            finishLabel={_("Create tunnel")}
            variant="medium"
        />
    );
}
