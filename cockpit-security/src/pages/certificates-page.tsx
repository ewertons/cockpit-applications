import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface Certificate {
    subject: string;
    issuer: string;
    notBefore: string;
    notAfter: string;
    serial: string;
    path: string;
    daysRemaining: number;
}

export const CertificatesPage = () => {
    const [certificates, setCertificates] = useState<Certificate[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, _setError] = useState("");

    useEffect(() => {
        loadCertificates();
    }, []);

    const loadCertificates = async () => {
        setLoading(true);
        const certs: Certificate[] = [];

        // Common certificate locations
        const certPaths = [
            "/etc/ssl/certs",
            "/etc/pki/tls/certs",
            "/etc/letsencrypt/live",
        ];

        for (const certDir of certPaths) {
            try {
                const files = await cockpit.spawn(
                    ["find", certDir, "-name", "*.pem", "-o", "-name", "*.crt"],
                    { err: "ignore", superuser: "try" }
                );
                const certFiles = files.trim().split("\n")
                        .filter(Boolean)
                        .slice(0, 30);

                for (const file of certFiles) {
                    try {
                        const info = await cockpit.spawn(
                            ["openssl", "x509", "-in", file, "-noout", "-subject", "-issuer", "-dates", "-serial"],
                            { err: "ignore" }
                        );
                        const subject = (info.match(/subject\s*=\s*(.*)/) || ["", ""])[1].trim();
                        const issuer = (info.match(/issuer\s*=\s*(.*)/) || ["", ""])[1].trim();
                        const notBefore = (info.match(/notBefore\s*=\s*(.*)/) || ["", ""])[1].trim();
                        const notAfter = (info.match(/notAfter\s*=\s*(.*)/) || ["", ""])[1].trim();
                        const serial = (info.match(/serial\s*=\s*(.*)/) || ["", ""])[1].trim();

                        let daysRemaining = -1;
                        if (notAfter) {
                            const expiry = new Date(notAfter);
                            daysRemaining = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
                        }

                        if (subject) {
                            certs.push({ subject, issuer, notBefore, notAfter, serial, path: file, daysRemaining });
                        }
                    } catch { /* skip individual cert */ }
                }
            } catch { /* skip directory */ }
        }

        // Sort by days remaining (expiring soonest first)
        certs.sort((a, b) => a.daysRemaining - b.daysRemaining);
        setCertificates(certs);
        setLoading(false);
    };

    if (loading) return <Spinner />;

    const expiryStatus = (days: number) => {
        if (days < 0) return <span className="security-status-danger">{_("EXPIRED")}</span>;
        if (days < 30) return <span className="security-status-danger">{days} {_("days")}</span>;
        if (days < 90) return <span className="security-status-warning">{days} {_("days")}</span>;
        return <span className="security-status-good">{days} {_("days")}</span>;
    };

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("TLS Certificates")}</Title>

            {error && <Alert variant="danger" title={error} className="pf-v6-u-mb-md" />}

            <div className="pf-v6-u-mb-md">
                <Button variant="secondary" onClick={loadCertificates}>{_("Refresh")}</Button>
            </div>

            {certificates.length === 0
                ? (
                    <Alert variant="info" title={_("No certificates found in standard locations.")} />
                )
                : (
                    <Card>
                        <CardTitle>{_("Certificates")} ({certificates.length})</CardTitle>
                        <CardBody>
                            <div style={{ overflowX: "auto" }}>
                                <table className="pf-v6-c-table pf-m-compact">
                                    <thead>
                                        <tr>
                                            <th>{_("Subject")}</th>
                                            <th>{_("Issuer")}</th>
                                            <th>{_("Expires")}</th>
                                            <th>{_("Remaining")}</th>
                                            <th>{_("Path")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {certificates.map((cert, i) => (
                                            <tr key={i}>
                                                <td>{cert.subject}</td>
                                                <td>{cert.issuer}</td>
                                                <td>{cert.notAfter}</td>
                                                <td>{expiryStatus(cert.daysRemaining)}</td>
                                                <td style={{ fontSize: "0.85em", fontFamily: "monospace" }}>{cert.path}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </CardBody>
                    </Card>
                )}
        </>
    );
};
