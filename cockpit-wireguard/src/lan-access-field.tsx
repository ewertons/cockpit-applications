import React from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";

import cockpit from 'cockpit';

import { FirewallManagement } from './wireguard.js';

const _ = cockpit.gettext;

interface LanAccessFieldProps {
    id: string;
    value: string;
    onChange: (value: string) => void;
    errors: string[];
    firewallManagement: FirewallManagement | undefined;
}

/** Per-client LAN access list, with how this server enforces it. */
export function LanAccessField({ id, value, onChange, errors, firewallManagement }: LanAccessFieldProps) {
    return (
        <FormGroup label={_("LAN access")} fieldId={id}>
            <TextArea
                id={id} value={value} onChange={(_ev, text) => onChange(text)}
                validated={errors.length ? "error" : "default"}
                placeholder="192.168.1.198:22/tcp"
                resizeOrientation="vertical" rows={3}
            />
            <HelperText>
                {errors.map(error => <HelperTextItem key={error} variant="error">{error}</HelperTextItem>)}
                <HelperTextItem>
                    {_("Hosts or networks beyond the VPN subnet this client may reach, one per line: address or CIDR, optionally :port and /tcp or /udp (a port alone means both). Leave empty for the VPN subnet only.")}
                </HelperTextItem>
            </HelperText>
            {firewallManagement === "unmanaged" && (
                <Alert variant="warning" isInline isPlain title={_("Not enforced on this server")}>
                    {_("This tunnel's firewall rules (PostUp/PostDown) were not created by this app and are left unchanged. These entries only change the client's configuration; restrict forwarding on this server separately.")}
                </Alert>
            )}
            {firewallManagement === "legacy" && (
                <Alert variant="info" isInline isPlain title={_("Firewall rules will be upgraded")}>
                    {_("Saving replaces this tunnel's allow-all forwarding rules with per-client rules. Clients that were never edited keep unrestricted forwarding until they are saved.")}
                </Alert>
            )}
        </FormGroup>
    );
}
