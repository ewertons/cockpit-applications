import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

import cockpit from 'cockpit';

import { listInterfaceNames, eraseAllConfig } from './wireguard.js';

const _ = cockpit.gettext;

const CONFIRM_WORD = "ERASE";

export const SettingsPage = () => {
    const [names, setNames] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Double confirmation: step 1 (warning) then step 2 (type-to-confirm)
    const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);
    const [confirmText, setConfirmText] = useState("");
    const [erasing, setErasing] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        setNames(await listInterfaceNames());
        setLoading(false);
    }, []);

    useEffect(() => { refresh() }, [refresh]);

    const closeConfirm = () => {
        setConfirmStep(0);
        setConfirmText("");
    };

    const doErase = async () => {
        setErasing(true);
        setError(null);
        try {
            await eraseAllConfig();
            setSuccess(_("All WireGuard configuration has been erased."));
            closeConfirm();
            refresh();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setErasing(false);
    };

    if (loading)
        return <Spinner aria-label={_("Loading settings")} />;

    return (
        <div className="wireguard-app">
            <div className="page-header">
                <div className="page-header-title">
                    <h2>{_("Settings")}</h2>
                    <p>{_("Configuration storage and maintenance")}</p>
                </div>
            </div>

            {error && <Alert variant="danger" title={_("Error")} isInline style={{ marginBottom: "1rem" }}>{error}</Alert>}
            {success && (
                <Alert
                    variant="success" title={success} isInline
                    style={{ marginBottom: "1rem" }}
                    actionClose={<Button variant="plain" aria-label={_("Close")} onClick={() => setSuccess(null)}>×</Button>}
                />
            )}

            <Card isCompact className="wg-summary-card">
                <CardTitle>{_("Configuration")}</CardTitle>
                <CardBody>
                    <p>
                        {_("WireGuard tunnels are stored as standard configuration files in /etc/wireguard. This is the same location wg-quick uses directly, so:")}
                    </p>
                    <ul className="wg-bullets">
                        <li>{_("Tunnels created outside Cockpit appear here automatically after reloading.")}</li>
                        <li>{_("Changes you make here are written back to those same files.")}</li>
                        <li>{_("Removing this Cockpit app leaves all configuration and running tunnels intact.")}</li>
                    </ul>
                </CardBody>
            </Card>

            <Card isCompact className="wg-danger-zone">
                <CardTitle>{_("Danger zone")}</CardTitle>
                <CardBody>
                    <p style={{ marginBottom: "0.75rem" }}>
                        {names.length > 0
                            ? cockpit.format(_("Erase all WireGuard configuration. This will bring down and permanently delete $0 tunnel(s): $1."),
                                             names.length, names.join(", "))
                            : _("There is currently no WireGuard configuration to erase.")}
                    </p>
                    <Button variant="danger" isDisabled={names.length === 0} onClick={() => setConfirmStep(1)}>
                        {_("Erase all configuration")}
                    </Button>
                </CardBody>
            </Card>

            {/* Step 1 — warning */}
            {confirmStep === 1 && (
                <Modal variant="small" isOpen onClose={closeConfirm}>
                    <ModalHeader title={_("Erase all configuration?")} titleIconVariant="warning" />
                    <ModalBody>
                        <p>
                            {cockpit.format(_("This will bring down and delete every tunnel: $0."), names.join(", "))}
                        </p>
                        <p style={{ marginTop: "0.5rem" }}>
                            {_("All client configurations already distributed will stop working. This cannot be undone.")}
                        </p>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={() => setConfirmStep(2)}>{_("Continue")}</Button>
                        <Button variant="link" onClick={closeConfirm}>{_("Cancel")}</Button>
                    </ModalFooter>
                </Modal>
            )}

            {/* Step 2 — type to confirm */}
            {confirmStep === 2 && (
                <Modal variant="small" isOpen onClose={closeConfirm}>
                    <ModalHeader title={_("Final confirmation")} titleIconVariant="danger" />
                    <ModalBody>
                        <FormGroup
                            label={cockpit.format(_("Type $0 to confirm"), CONFIRM_WORD)}
                            isRequired fieldId="wg-confirm-erase"
                        >
                            <TextInput
                                id="wg-confirm-erase" value={confirmText}
                                onChange={(_ev, v) => setConfirmText(v)}
                                autoComplete="off"
                            />
                            <HelperText>
                                <HelperTextItem variant="warning">
                                    {_("Every tunnel in /etc/wireguard will be permanently deleted.")}
                                </HelperTextItem>
                            </HelperText>
                        </FormGroup>
                    </ModalBody>
                    <ModalFooter>
                        <Button
                            variant="danger" onClick={doErase}
                            isLoading={erasing}
                            isDisabled={erasing || confirmText.trim() !== CONFIRM_WORD}
                        >
                            {_("Erase everything")}
                        </Button>
                        <Button variant="link" onClick={closeConfirm} isDisabled={erasing}>{_("Cancel")}</Button>
                    </ModalFooter>
                </Modal>
            )}
        </div>
    );
};
