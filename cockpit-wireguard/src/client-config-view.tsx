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

// A same-origin URL, not a blob: inside Cockpit's iframe Firefox treats blob
// downloads as a frame navigation and blocks them under "frame-src 'self'".
function downloadUrl(path: string, filename: string): string {
    const query = window.btoa(JSON.stringify({
        payload: "fsread1",
        binary: "raw",
        path,
        external: {
            "content-disposition": `attachment; filename="${filename}"`,
            "content-type": "text/plain",
        },
    }));
    const prefix = new URL(cockpit.transport.uri("channel/" + cockpit.transport.csrf_token)).pathname;
    return `${prefix}?${query}`;
}

// Displays a client configuration with copy, download, and a scannable QR code.
export function ClientConfigView({ config, fileName }: ClientConfigViewProps) {
    const [path, setPath] = useState("");

    // Downloading over a Cockpit channel needs the config to exist as a file, so
    // it is staged in a private tmpfs directory for as long as this is shown.
    useEffect(() => {
        let dir = "";
        let cancelled = false;
        const discard = () => {
            if (dir)
                cockpit.spawn(["rm", "-rf", dir], { err: "ignore" });
            dir = "";
        };

        const proc = cockpit.spawn(
            ["/bin/sh", "-c",
                'set -e; d=$(mktemp -d -p /dev/shm cockpit-wireguard.XXXXXXXX 2>/dev/null || mktemp -d); ' +
                'umask 077; cat > "$d/$1.conf"; printf "%s\\n" "$d"',
                "sh", fileName],
            { err: "message" });
        proc.input(config);
        proc.then((out: string) => {
            dir = out.trim();
            if (cancelled)
                discard();
            else
                setPath(`${dir}/${fileName}.conf`);
        })
                .catch(() => undefined);

        return () => {
            cancelled = true;
            setPath("");
            discard();
        };
    }, [config, fileName]);

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
                <Button
                    variant="secondary"
                    component="a"
                    href={path ? downloadUrl(path, `${fileName}.conf`) : ""}
                    download={`${fileName}.conf`}
                    isDisabled={!path}
                >
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
