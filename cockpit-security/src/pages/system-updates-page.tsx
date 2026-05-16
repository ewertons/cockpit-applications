import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { DescriptionList, DescriptionListGroup, DescriptionListTerm, DescriptionListDescription } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface UpdateInfo {
    packageManager: string;
    availableUpdates: string[];
    securityUpdates: string[];
    lastUpdate: string;
    autoUpdates: boolean;
}

export const SystemUpdatesPage = () => {
    const [info, setInfo] = useState<UpdateInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [updating, setUpdating] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [output, setOutput] = useState("");

    useEffect(() => {
        loadUpdateInfo();
    }, []);

    const loadUpdateInfo = async () => {
        setLoading(true);
        const result: UpdateInfo = {
            packageManager: "unknown",
            availableUpdates: [],
            securityUpdates: [],
            lastUpdate: "",
            autoUpdates: false,
        };

        // Detect package manager and check updates
        try {
            // Try apt (Debian/Ubuntu)
            await cockpit.spawn(["which", "apt-get"], { err: "ignore" });
            result.packageManager = "apt";
            try {
                await cockpit.spawn(["apt-get", "update", "-qq"], { superuser: "try", err: "ignore" });
                const upgradable = await cockpit.spawn(["apt", "list", "--upgradable"], { err: "ignore" });
                result.availableUpdates = upgradable.trim().split("\n")
                        .filter(l => l.includes("/"))
                        .map(l => l.split("/")[0]);

                // Check for security updates
                const secOutput = await cockpit.spawn(
                    ["apt-get", "-s", "upgrade"],
                    { err: "ignore" }
                );
                result.securityUpdates = secOutput.split("\n")
                        .filter(l => l.includes("-security"))
                        .map(l => l.trim());
            } catch { /* ignore */ }

            // Check unattended-upgrades
            try {
                await cockpit.spawn(["dpkg", "-l", "unattended-upgrades"], { err: "ignore" });
                result.autoUpdates = true;
            } catch {
                result.autoUpdates = false;
            }

            // Last update time
            try {
                const stat = await cockpit.spawn(["stat", "-c", "%y", "/var/lib/apt/periodic/update-stamp"], { err: "ignore" });
                result.lastUpdate = stat.trim().split(".")[0];
            } catch { /* ignore */ }
        } catch {
            // Try dnf/yum (RHEL/Fedora)
            try {
                await cockpit.spawn(["which", "dnf"], { err: "ignore" });
                result.packageManager = "dnf";
                try {
                    const updates = await cockpit.spawn(["dnf", "check-update", "-q"], { err: "ignore", superuser: "try" });
                    result.availableUpdates = updates.trim().split("\n")
                            .filter(l => l.trim() && !l.startsWith("Last"))
                            .map(l => l.split(/\s+/)[0]);
                } catch (e: any) {
                    // dnf check-update returns exit code 100 when updates are available
                    if (e.exit_status === 100 && e.message) {
                        result.availableUpdates = e.message.trim().split("\n")
                                .filter((l: string) => l.trim())
                                .map((l: string) => l.split(/\s+/)[0]);
                    }
                }

                try {
                    const secUpdates = await cockpit.spawn(["dnf", "updateinfo", "list", "--security", "-q"], { err: "ignore", superuser: "try" });
                    result.securityUpdates = secUpdates.trim().split("\n")
                            .filter(Boolean);
                } catch { /* ignore */ }

                // Check dnf-automatic
                try {
                    const autoStatus = await cockpit.spawn(["systemctl", "is-active", "dnf-automatic.timer"], { err: "ignore" });
                    result.autoUpdates = autoStatus.trim() === "active";
                } catch { /* ignore */ }
            } catch {
                // Try zypper (SUSE)
                try {
                    await cockpit.spawn(["which", "zypper"], { err: "ignore" });
                    result.packageManager = "zypper";
                } catch {
                    result.packageManager = "unknown";
                }
            }
        }

        setInfo(result);
        setLoading(false);
    };

    const runUpdate = async () => {
        setUpdating(true);
        setError("");
        setSuccess("");
        setOutput("");
        try {
            let cmd: string[];
            if (info?.packageManager === "apt") {
                cmd = ["apt-get", "upgrade", "-y"];
            } else if (info?.packageManager === "dnf") {
                cmd = ["dnf", "upgrade", "-y"];
            } else if (info?.packageManager === "zypper") {
                cmd = ["zypper", "update", "-y"];
            } else {
                setError(_("Unknown package manager"));
                setUpdating(false);
                return;
            }
            const result = await cockpit.spawn(cmd, { superuser: "require", err: "message" });
            setOutput(result);
            setSuccess(_("System updated successfully"));
            await loadUpdateInfo();
        } catch (e: any) {
            setError(e.message || String(e));
            if (e.message) setOutput(e.message);
        }
        setUpdating(false);
    };

    const runSecurityUpdate = async () => {
        setUpdating(true);
        setError("");
        setSuccess("");
        try {
            let cmd: string[];
            if (info?.packageManager === "apt") {
                cmd = ["apt-get", "upgrade", "-y", "-o", "Dpkg::Options::=--force-confdef"];
            } else if (info?.packageManager === "dnf") {
                cmd = ["dnf", "upgrade", "--security", "-y"];
            } else {
                setError(_("Security-only updates not supported for this package manager"));
                setUpdating(false);
                return;
            }
            const result = await cockpit.spawn(cmd, { superuser: "require", err: "message" });
            setOutput(result);
            setSuccess(_("Security updates applied"));
            await loadUpdateInfo();
        } catch (e: any) {
            setError(e.message || String(e));
        }
        setUpdating(false);
    };

    if (loading) return <Spinner />;

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("System Updates")}</Title>

            {error && <Alert variant="danger" title={error} className="pf-v6-u-mb-md" />}
            {success && <Alert variant="success" title={success} className="pf-v6-u-mb-md" />}

            {info && (
                <>
                    <Card className="pf-v6-u-mb-md">
                        <CardTitle>{_("Update Status")}</CardTitle>
                        <CardBody>
                            <DescriptionList isHorizontal>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Package Manager")}</DescriptionListTerm>
                                    <DescriptionListDescription>{info.packageManager}</DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Available Updates")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        <span className={info.availableUpdates.length > 0 ? "security-status-warning" : "security-status-good"}>
                                            {info.availableUpdates.length} {_("packages")}
                                        </span>
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Security Updates")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        <span className={info.securityUpdates.length > 0 ? "security-status-danger" : "security-status-good"}>
                                            {info.securityUpdates.length} {_("packages")}
                                        </span>
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Automatic Updates")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        {info.autoUpdates
                                            ? <span className="security-status-good">{_("Enabled")}</span>
                                            : <span className="security-status-warning">{_("Disabled")}</span>}
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                                {info.lastUpdate && (
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Last Update Check")}</DescriptionListTerm>
                                        <DescriptionListDescription>{info.lastUpdate}</DescriptionListDescription>
                                    </DescriptionListGroup>
                                )}
                            </DescriptionList>

                            <div className="pf-v6-u-mt-md">
                                <Button variant="primary" onClick={runUpdate} isLoading={updating} isDisabled={updating} className="pf-v6-u-mr-sm">
                                    {_("Update All")}
                                </Button>
                                <Button variant="warning" onClick={runSecurityUpdate} isLoading={updating} isDisabled={updating}>
                                    {_("Security Updates Only")}
                                </Button>
                            </div>
                        </CardBody>
                    </Card>

                    {info.availableUpdates.length > 0 && (
                        <Card className="pf-v6-u-mb-md">
                            <CardTitle>{_("Packages to Update")}</CardTitle>
                            <CardBody>
                                <div className="log-viewer">
                                    {info.availableUpdates.join("\n")}
                                </div>
                            </CardBody>
                        </Card>
                    )}

                    {output && (
                        <Card>
                            <CardTitle>{_("Update Output")}</CardTitle>
                            <CardBody>
                                <div className="log-viewer">{output}</div>
                            </CardBody>
                        </Card>
                    )}
                </>
            )}
        </>
    );
};
