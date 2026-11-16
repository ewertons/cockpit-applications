import React from 'react';
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface ExtraRoutesFieldProps {
    id: string;
    value: string;
    onChange: (value: string) => void;
    errors: string[];
}

/** Networks a split-tunnel client routes through the VPN besides the VPN subnet. */
export function ExtraRoutesField({ id, value, onChange, errors }: ExtraRoutesFieldProps) {
    return (
        <FormGroup label={_("Extra routes")} fieldId={id}>
            <TextArea
                id={id} value={value} onChange={(_ev, text) => onChange(text)}
                validated={errors.length ? "error" : "default"}
                placeholder="192.168.1.0/24"
                resizeOrientation="vertical" rows={3}
            />
            <HelperText>
                {errors.map(error => <HelperTextItem key={error} variant="error">{error}</HelperTextItem>)}
                <HelperTextItem>
                    {_("Addresses or networks (CIDR) beyond the VPN subnet that this client sends through the VPN, one per line. They are added to the client's AllowedIPs. Forwarding and access control on this server are configured in its firewall, not here.")}
                </HelperTextItem>
            </HelperText>
        </FormGroup>
    );
}
