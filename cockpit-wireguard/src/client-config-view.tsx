import React, { useEffect, useMemo, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { ClipboardCopy, ClipboardCopyVariant } from "@patternfly/react-core/dist/esm/components/ClipboardCopy/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";

import cockpit from 'cockpit';
import qrcode from 'qrcode-generator';

const _ = cockpit.gettext;

// Turn an arbitrary client name into a safe WireGuard config file name
// (the file name becomes the tunnel name when imported on the client).
export function sanitizeFileName(name: string): string {
    const cleaned = name.replace(/[^a-zA-Z0-9_=+.-]/g, "-").replace(/^-+|-+$/g, "");
    return (cleaned || "client").slice(0, 15);
}

export function QrCode({ text }: { text: string }) {
    const svg = useMemo(() => {
        try {
            const qr = qrcode(0, "L");
            qr.addData(text);
            qr.make();
            return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        } catch {
            return "";
        }
    }, [text]);

    if (!svg)
        return null;
    // The SVG is generated locally from QR geometry (no external/user markup).
    return <div className="wg-qr" aria-label={_("Configuration QR code")} dangerouslySetInnerHTML={{ __html: svg }} />;
}

interface ClientConfigViewProps {
    config: string;
    fileName: string; // without the .conf suffix
}

// Displays a client configuration with copy, download, and a scannable QR code.
export function ClientConfigView({ config, fileName }: ClientConfigViewProps) {
    const [url, setUrl] = useState<string | null>(null);

    useEffect(() => {
        const objectUrl = URL.createObjectURL(new Blob([config], { type: "text/plain" }));
        setUrl(objectUrl);
        return () => URL.revokeObjectURL(objectUrl);
    }, [config]);

    const download = () => {
        if (!url)
            return;
        const a = document.createElement("a");
        a.href = url;
        a.download = `${fileName}.conf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    return (
        <div className="wg-client-result">
            <div className="wg-client-config">
                <FormGroup label={_("Client configuration")} fieldId="wg-client-config">
                    <ClipboardCopy
                        isReadOnly isExpanded hoverTip={_("Copy")} clickTip={_("Copied")}
                        variant={ClipboardCopyVariant.expansion}
                    >
                        {config}
                    </ClipboardCopy>
                </FormGroup>
                <Button variant="secondary" onClick={download} isDisabled={!url}>
                    {cockpit.format(_("Download $0.conf"), fileName)}
                </Button>
            </div>
            <div className="wg-client-qr">
                <span className="wg-qr-label">{_("Scan with the WireGuard app")}</span>
                <QrCode text={config} />
            </div>
        </div>
    );
}
