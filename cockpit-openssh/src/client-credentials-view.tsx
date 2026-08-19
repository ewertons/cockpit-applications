import React from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { ClipboardCopy, ClipboardCopyVariant } from "@patternfly/react-core/dist/esm/components/ClipboardCopy/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";

import cockpit from 'cockpit';

import { Keypair, downloadUrl } from './authorized-keys.js';

const _ = cockpit.gettext;

interface ClientCredentialsViewProps {
    keypair: Keypair;
    fileName: string;
    user: string;
    port: string;
}

/**
 * The private key only exists in a tmpfs directory for as long as this dialog is
 * open, so this is the only chance to download it.
 */
export function ClientCredentialsView({ keypair, fileName, user, port }: ClientCredentialsViewProps) {
    const privateUrl = downloadUrl(`${keypair.dir}/key`, fileName, "application/octet-stream");
    const publicUrl = downloadUrl(`${keypair.dir}/key.pub`, `${fileName}.pub`, "text/plain");

    const host = window.location.hostname;
    const snippet = [
        `mv ~/Downloads/${fileName} ~/.ssh/${fileName}`,
        `chmod 600 ~/.ssh/${fileName}`,
        "",
        "# add to ~/.ssh/config",
        `Host ${host}`,
        `    HostName ${host}`,
        `    Port ${port || "22"}`,
        `    User ${user}`,
        `    IdentityFile ~/.ssh/${fileName}`,
    ].join("\n");

    return (
        <>
            <Alert variant="warning" isInline title={_("Download the private key now")} className="pf-v6-u-mb-md">
                {_("This private key is held in memory on the server only while this dialog is open, and is discarded when it closes. It cannot be shown again. Download it now, then delete the downloaded copy from the browser's download folder once it is in place on the client.")}
            </Alert>

            <FormGroup label={_("Fingerprint")} fieldId="ssh-generated-fingerprint">
                <div className="ssh-mono" id="ssh-generated-fingerprint">{keypair.fingerprint}</div>
            </FormGroup>

            <FormGroup label={_("Private key")} fieldId="ssh-generated-private">
                <ClipboardCopy
                    isReadOnly isExpanded hoverTip={_("Copy")} clickTip={_("Copied")}
                    variant={ClipboardCopyVariant.expansion}
                >
                    {keypair.privateKey}
                </ClipboardCopy>
            </FormGroup>

            <FormGroup label={_("Public key")} fieldId="ssh-generated-public">
                <ClipboardCopy
                    isReadOnly isExpanded hoverTip={_("Copy")} clickTip={_("Copied")}
                    variant={ClipboardCopyVariant.expansion}
                >
                    {keypair.publicKey}
                </ClipboardCopy>
            </FormGroup>

            {/* Real anchors, not a synthesised element clicked from script: that
                also gives keyboard activation and "save link as". */}
            <Flex className="ssh-actions" gap={{ default: "gapMd" }}>
                <FlexItem>
                    <Button
                        variant="primary"
                        component="a"
                        href={privateUrl}
                        download={fileName}
                        isDisabled={!privateUrl}
                    >
                        {cockpit.format(_("Download $0"), fileName)}
                    </Button>
                </FlexItem>
                <FlexItem>
                    <Button
                        variant="secondary"
                        component="a"
                        href={publicUrl}
                        download={`${fileName}.pub`}
                        isDisabled={!publicUrl}
                    >
                        {cockpit.format(_("Download $0.pub"), fileName)}
                    </Button>
                </FlexItem>
            </Flex>

            <FormGroup label={_("On the client machine")} fieldId="ssh-generated-snippet">
                <pre className="ssh-snippet" id="ssh-generated-snippet">{snippet}</pre>
            </FormGroup>
        </>
    );
}
