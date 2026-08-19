import React, { useState } from 'react';
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

import cockpit from 'cockpit';

import {
    KeyRestrictions, KeyType, Keypair, SystemUser,
    addKey, buildOptions, composeKeyLine, defaultKeyFileName, discardKeypair, emptyRestrictions,
    generateKeypair, validatePublicKey,
} from './authorized-keys.js';
import { ClientCredentialsView } from './client-credentials-view.jsx';
import { StepWizard, WizardStepDef } from './stepper.jsx';

const _ = cockpit.gettext;

interface AddClientWizardProps {
    user: SystemUser;
    path: string;
    port: string;
    onClose: () => void;
    onAdded: () => void;
}

export function AddClientWizard({ user, path, port, onClose, onAdded }: AddClientWizardProps) {
    const [name, setName] = useState("");
    const [source, setSource] = useState<"paste" | "generate">("paste");
    const [pasted, setPasted] = useState("");
    const [keyType, setKeyType] = useState<KeyType>("ed25519");
    const [restrictions, setRestrictions] = useState<KeyRestrictions>(emptyRestrictions);
    const [restrictionsOpen, setRestrictionsOpen] = useState(false);
    const [keypair, setKeypair] = useState<Keypair | null>(null);

    const comment = name.trim() || `${user.name}@${window.location.hostname}`;
    const fileName = defaultKeyFileName(keyType, name.trim());

    // The generated key sits in a tmpfs directory so it can be downloaded; it
    // must not outlive the dialog.
    const close = () => {
        if (keypair)
            discardKeypair(keypair.dir);
        onClose();
    };

    const setRestriction = <K extends keyof KeyRestrictions>(key: K, value: KeyRestrictions[K]) =>
        setRestrictions(current => ({ ...current, [key]: value }));

    const clientStep: WizardStepDef = {
        id: "client",
        name: _("Client"),
        canContinue: source === "generate" || pasted.trim().length > 0,
        nextLabel: _("Generate key pair"),
        content: (
            <Form>
                <FormGroup label={_("Client name")} fieldId="ssh-client-name">
                    <TextInput
                        id="ssh-client-name"
                        value={name}
                        onChange={(_event, value) => setName(value)}
                        placeholder={_("laptop, backup-runner, …")}
                    />
                    <div className="ssh-provenance">
                        {cockpit.format(_("Used as the key comment. The key is added for $0 in $1."), user.name, path)}
                    </div>
                </FormGroup>

                <FormGroup label={_("Key")} fieldId="ssh-key-source" role="radiogroup">
                    <Radio
                        id="ssh-key-source-paste"
                        name="ssh-key-source"
                        label={_("Paste an existing public key")}
                        isChecked={source === "paste"}
                        onChange={() => setSource("paste")}
                    />
                    <Radio
                        id="ssh-key-source-generate"
                        name="ssh-key-source"
                        label={_("Generate a new key pair on this server")}
                        isChecked={source === "generate"}
                        onChange={() => setSource("generate")}
                        description={_("The private key is shown once for download and is never stored on the server.")}
                    />
                </FormGroup>

                {source === "paste"
                    ? (
                        <FormGroup label={_("Public key")} fieldId="ssh-key-pasted">
                            <TextArea
                                id="ssh-key-pasted"
                                rows={4}
                                value={pasted}
                                onChange={(_event, value) => setPasted(value)}
                                placeholder="ssh-ed25519 AAAA… user@host"
                            />
                        </FormGroup>
                    )
                    : (
                        <FormGroup label={_("Key type")} fieldId="ssh-key-type">
                            <FormSelect
                                id="ssh-key-type"
                                value={keyType}
                                onChange={(_event, value) => setKeyType(value as KeyType)}
                            >
                                <FormSelectOption value="ed25519" label={_("Ed25519 (recommended)")} />
                                <FormSelectOption value="rsa" label={_("RSA 4096")} />
                                <FormSelectOption value="ecdsa" label={_("ECDSA")} />
                            </FormSelect>
                        </FormGroup>
                    )}

                <ExpandableSection
                    toggleText={_("Restrictions")}
                    isExpanded={restrictionsOpen}
                    onToggle={(_event, expanded) => setRestrictionsOpen(expanded)}
                >
                    <FormGroup label={_("Only from")} fieldId="ssh-restrict-from">
                        <TextInput
                            id="ssh-restrict-from"
                            value={restrictions.from}
                            onChange={(_event, value) => setRestriction("from", value)}
                            placeholder="10.0.0.0/8,*.example.com"
                        />
                    </FormGroup>
                    <FormGroup label={_("Forced command")} fieldId="ssh-restrict-command">
                        <TextInput
                            id="ssh-restrict-command"
                            value={restrictions.command}
                            onChange={(_event, value) => setRestriction("command", value)}
                        />
                    </FormGroup>
                    <FormGroup label={_("Expires")} fieldId="ssh-restrict-expiry">
                        <TextInput
                            id="ssh-restrict-expiry"
                            value={restrictions.expiry}
                            onChange={(_event, value) => setRestriction("expiry", value)}
                            placeholder="20261231"
                        />
                        <div className="ssh-provenance">{_("YYYYMMDD, optionally followed by HHMM[SS].")}</div>
                    </FormGroup>
                    <Checkbox
                        id="ssh-restrict-all"
                        label={_("Deny all forwarding, agent and terminal access")}
                        isChecked={restrictions.restrict}
                        onChange={(_event, value) => setRestriction("restrict", value)}
                    />
                    <Checkbox
                        id="ssh-restrict-port-forwarding"
                        label={_("Deny port forwarding")}
                        isChecked={restrictions.restrict || restrictions.noPortForwarding}
                        isDisabled={restrictions.restrict}
                        onChange={(_event, value) => setRestriction("noPortForwarding", value)}
                    />
                    <Checkbox
                        id="ssh-restrict-pty"
                        label={_("Deny terminal allocation")}
                        isChecked={restrictions.restrict || restrictions.noPty}
                        isDisabled={restrictions.restrict}
                        onChange={(_event, value) => setRestriction("noPty", value)}
                    />
                </ExpandableSection>
            </Form>
        ),
        onNext: async () => {
            if (source === "generate") {
                setKeypair(await generateKeypair(keyType, comment));
                return;
            }
            if (!await validatePublicKey(pasted))
                throw new Error(_("That does not look like an SSH public key."));
        },
    };

    const steps: WizardStepDef[] = [clientStep];
    if (source === "generate") {
        steps.push({
            id: "credentials",
            name: _("Key pair"),
            hideBack: true,
            content: keypair
                ? <ClientCredentialsView keypair={keypair} fileName={fileName} user={user.name} port={port} />
                : null,
        });
    }

    const finish = async () => {
        const publicKey = source === "generate" ? keypair?.publicKey ?? "" : pasted;
        // The key only reaches authorized_keys here, once the dialog is confirmed.
        await addKey(user, path, composeKeyLine(buildOptions(restrictions), publicKey));
        if (keypair)
            await discardKeypair(keypair.dir);
        onAdded();
    };

    return (
        <StepWizard
            title={_("Add client")}
            steps={steps}
            onClose={close}
            onFinish={finish}
            finishLabel={source === "generate" ? _("Add key and finish") : _("Add key")}
        />
    );
}
