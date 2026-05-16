import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";

import { DescriptionList, DescriptionListGroup, DescriptionListTerm, DescriptionListDescription } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Grid, GridItem } from "@patternfly/react-core/dist/esm/layouts/Grid/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

type IDSBackend = "aide" | "rkhunter" | "chkrootkit" | "none";

export const IntrusionDetectionPage = () => {
    const [backends, setBackends] = useState<IDSBackend[]>([]);
    const [loading, setLoading] = useState(true);
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [scanOutput, setScanOutput] = useState("");
    const [_suspiciousFiles, _setSuspiciousFiles] = useState<string[]>([]);
    const [suidFiles, setSuidFiles] = useState<string[]>([]);
    const [worldWritable, setWorldWritable] = useState<string[]>([]);

    useEffect(() => {
        detectBackends();
        loadFileChecks();
    }, []);

    const detectBackends = async () => {
        setLoading(true);
        const found: IDSBackend[] = [];

        try {
            await cockpit.spawn(["which", "aide"], { err: "ignore" });
            found.push("aide");
        } catch { /* not installed */ }

        try {
            await cockpit.spawn(["which", "rkhunter"], { err: "ignore" });
            found.push("rkhunter");
        } catch { /* not installed */ }

        try {
            await cockpit.spawn(["which", "chkrootkit"], { err: "ignore" });
            found.push("chkrootkit");
        } catch { /* not installed */ }

        setBackends(found);
        setLoading(false);
    };

    const loadFileChecks = async () => {
        // Find SUID/SGID files
        try {
            const suid = await cockpit.spawn(
                ["find", "/usr", "/bin", "/sbin", "-perm", "/4000", "-type", "f"],
                { err: "ignore", superuser: "try" }
            );
            setSuidFiles(suid.trim().split("\n")
                    .filter(Boolean)
                    .slice(0, 50));
        } catch { /* ignore */ }

        // Find world-writable files in sensitive directories
        try {
            const ww = await cockpit.spawn(
                ["find", "/etc", "/usr", "-perm", "-o+w", "-type", "f"],
                { err: "ignore", superuser: "try" }
            );
            setWorldWritable(ww.trim().split("\n")
                    .filter(Boolean)
                    .slice(0, 50));
        } catch { /* ignore */ }
    };

    const runAIDEScan = async () => {
        setScanning(true);
        setError("");
        setScanOutput("");
        try {
            const output = await cockpit.spawn(["aide", "--check"], { superuser: "require", err: "message" });
            setScanOutput(output);
            setSuccess(_("AIDE scan completed"));
        } catch (e: any) {
            // AIDE returns non-zero on detected changes
            if (e.message) {
                setScanOutput(e.message);
                setSuccess(_("AIDE scan completed - changes detected"));
            } else {
                setError(String(e));
            }
        }
        setScanning(false);
    };

    const runRkhunter = async () => {
        setScanning(true);
        setError("");
        setScanOutput("");
        try {
            const output = await cockpit.spawn(
                ["rkhunter", "--check", "--skip-keypress", "--report-warnings-only"],
                { superuser: "require", err: "message" }
            );
            setScanOutput(output || _("No warnings found."));
            setSuccess(_("Rootkit scan completed"));
        } catch (e: any) {
            if (e.message) {
                setScanOutput(e.message);
                setSuccess(_("Rootkit scan completed - warnings found"));
            } else {
                setError(String(e));
            }
        }
        setScanning(false);
    };

    const runChkrootkit = async () => {
        setScanning(true);
        setError("");
        setScanOutput("");
        try {
            const output = await cockpit.spawn(["chkrootkit"], { superuser: "require", err: "message" });
            setScanOutput(output);
            setSuccess(_("Rootkit scan completed"));
        } catch (e: any) {
            if (e.message) setScanOutput(e.message);
            setError(String(e));
        }
        setScanning(false);
    };

    if (loading) return <Spinner />;

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("Intrusion Detection")}</Title>

            {error && <Alert variant="danger" title={error} className="pf-v6-u-mb-md" />}
            {success && <Alert variant="success" title={success} className="pf-v6-u-mb-md" />}

            <Card className="pf-v6-u-mb-md">
                <CardTitle>{_("Scanning Tools")}</CardTitle>
                <CardBody>
                    {backends.length === 0
                        ? (
                            <Alert variant="info" title={_("No IDS tools detected. Consider installing aide, rkhunter, or chkrootkit.")} />
                        )
                        : (
                            <DescriptionList isHorizontal>
                                {backends.includes("aide") && (
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>AIDE</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            <Button onClick={runAIDEScan} isLoading={scanning} isDisabled={scanning}>
                                                {_("Run Integrity Check")}
                                            </Button>
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                )}
                                {backends.includes("rkhunter") && (
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>rkhunter</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            <Button onClick={runRkhunter} isLoading={scanning} isDisabled={scanning}>
                                                {_("Scan for Rootkits")}
                                            </Button>
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                )}
                                {backends.includes("chkrootkit") && (
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>chkrootkit</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            <Button onClick={runChkrootkit} isLoading={scanning} isDisabled={scanning}>
                                                {_("Check for Rootkits")}
                                            </Button>
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                )}
                            </DescriptionList>
                        )}
                </CardBody>
            </Card>

            <Grid hasGutter>
                <GridItem span={6}>
                    <Card className="pf-v6-u-mb-md">
                        <CardTitle>{_("SUID/SGID Files")} ({suidFiles.length})</CardTitle>
                        <CardBody>
                            <div className="log-viewer">
                                {suidFiles.length > 0 ? suidFiles.join("\n") : _("No SUID files found.")}
                            </div>
                        </CardBody>
                    </Card>
                </GridItem>

                <GridItem span={6}>
                    <Card className="pf-v6-u-mb-md">
                        <CardTitle>{_("World-Writable Files")} ({worldWritable.length})</CardTitle>
                        <CardBody>
                            <div className="log-viewer">
                                {worldWritable.length > 0
                                    ? worldWritable.join("\n")
                                    : <span className="security-status-good">{_("None found in /etc, /usr")}</span>}
                            </div>
                        </CardBody>
                    </Card>
                </GridItem>
            </Grid>

            {scanOutput && (
                <Card>
                    <CardTitle>{_("Scan Output")}</CardTitle>
                    <CardBody>
                        <div className="log-viewer">{scanOutput}</div>
                    </CardBody>
                </Card>
            )}
        </>
    );
};
