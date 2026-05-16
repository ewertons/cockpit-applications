import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Grid, GridItem } from "@patternfly/react-core/dist/esm/layouts/Grid/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { DescriptionList, DescriptionListGroup, DescriptionListTerm, DescriptionListDescription } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface SecurityStatus {
    firewall: "active" | "inactive" | "unknown";
    selinux: string;
    fail2ban: "active" | "inactive" | "unknown";
    auditd: "active" | "inactive" | "unknown";
    sshRootLogin: string;
    pendingUpdates: number;
    activeConnections: number;
    failedLogins: number;
    lastBoot: string;
}

export const OverviewPage = () => {
    const [status, setStatus] = useState<SecurityStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [alerts, setAlerts] = useState<string[]>([]);

    useEffect(() => {
        loadStatus();
    }, []);

    const loadStatus = async () => {
        setLoading(true);
        const result: SecurityStatus = {
            firewall: "unknown",
            selinux: "unknown",
            fail2ban: "unknown",
            auditd: "unknown",
            sshRootLogin: "unknown",
            pendingUpdates: 0,
            activeConnections: 0,
            failedLogins: 0,
            lastBoot: "",
        };
        const newAlerts: string[] = [];

        try {
            // Check firewall (try firewalld, then ufw, then iptables)
            try {
                const fw = await cockpit.spawn(["systemctl", "is-active", "firewalld"], { err: "ignore" });
                result.firewall = fw.trim() === "active" ? "active" : "inactive";
            } catch {
                try {
                    const ufw = await cockpit.spawn(["ufw", "status"], { err: "ignore" });
                    result.firewall = ufw.includes("active") ? "active" : "inactive";
                } catch {
                    try {
                        const nft = await cockpit.spawn(["systemctl", "is-active", "nftables"], { err: "ignore" });
                        result.firewall = nft.trim() === "active" ? "active" : "inactive";
                    } catch {
                        result.firewall = "unknown";
                    }
                }
            }
            if (result.firewall !== "active") {
                newAlerts.push(_("Firewall is not active"));
            }

            // Check SELinux/AppArmor
            try {
                const se = await cockpit.spawn(["getenforce"], { err: "ignore" });
                result.selinux = "SELinux: " + se.trim();
                if (se.trim() === "Disabled" || se.trim() === "Permissive") {
                    newAlerts.push(_("SELinux is not enforcing"));
                }
            } catch {
                try {
                    const aa = await cockpit.spawn(["aa-status", "--json"], { err: "ignore", superuser: "try" });
                    const aaData = JSON.parse(aa);
                    result.selinux = `AppArmor: ${aaData.profiles ? Object.keys(aaData.profiles).length : 0} profiles`;
                } catch {
                    result.selinux = _("Neither SELinux nor AppArmor detected");
                    newAlerts.push(_("No mandatory access control system active"));
                }
            }

            // Check Fail2Ban
            try {
                const f2b = await cockpit.spawn(["systemctl", "is-active", "fail2ban"], { err: "ignore" });
                result.fail2ban = f2b.trim() === "active" ? "active" : "inactive";
            } catch {
                result.fail2ban = "inactive";
            }
            if (result.fail2ban !== "active") {
                newAlerts.push(_("Fail2Ban is not running"));
            }

            // Check auditd
            try {
                const aud = await cockpit.spawn(["systemctl", "is-active", "auditd"], { err: "ignore" });
                result.auditd = aud.trim() === "active" ? "active" : "inactive";
            } catch {
                result.auditd = "unknown";
            }

            // Check SSH root login
            try {
                const sshConf = await cockpit.file("/etc/ssh/sshd_config").read();
                const match = sshConf.match(/^\s*PermitRootLogin\s+(\S+)/m);
                result.sshRootLogin = match ? match[1] : "default (yes)";
                if (result.sshRootLogin === "yes" || result.sshRootLogin === "default (yes)") {
                    newAlerts.push(_("SSH root login is permitted"));
                }
            } catch {
                result.sshRootLogin = "unknown";
            }

            // Active connections
            try {
                const ss = await cockpit.spawn(["ss", "-tunp"], { err: "ignore" });
                result.activeConnections = Math.max(0, ss.split("\n").length - 2);
            } catch {
                result.activeConnections = 0;
            }

            // Failed logins (last 24h)
            try {
                const failed = await cockpit.spawn(
                    ["journalctl", "--since", "24 hours ago", "-u", "sshd", "--grep", "Failed|Invalid", "--no-pager", "-q"],
                    { err: "ignore", superuser: "try" }
                );
                result.failedLogins = failed.trim() ? failed.trim().split("\n").length : 0;
            } catch {
                result.failedLogins = 0;
            }

            // Last boot
            try {
                const uptime = await cockpit.spawn(["uptime", "-s"], { err: "ignore" });
                result.lastBoot = uptime.trim();
            } catch {
                result.lastBoot = "unknown";
            }
        } catch (e) {
            console.error("Error loading security status:", e);
        }

        setStatus(result);
        setAlerts(newAlerts);
        setLoading(false);
    };

    if (loading) {
        return <Spinner />;
    }

    const statusBadge = (state: string) => {
        if (state === "active") return <span className="security-status-good">● {_("Active")}</span>;
        if (state === "inactive") return <span className="security-status-danger">● {_("Inactive")}</span>;
        return <span className="security-status-warning">● {_("Unknown")}</span>;
    };

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("Security Overview")}</Title>

            {alerts.length > 0 && (
                <Alert variant="warning" title={_("Security Alerts")} className="pf-v6-u-mb-md">
                    <ul>
                        {alerts.map((a, i) => <li key={i}>{a}</li>)}
                    </ul>
                </Alert>
            )}

            <Grid hasGutter>
                <GridItem span={6}>
                    <Card className="security-dashboard-card">
                        <CardTitle>{_("Services Status")}</CardTitle>
                        <CardBody>
                            <DescriptionList isHorizontal>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Firewall")}</DescriptionListTerm>
                                    <DescriptionListDescription>{statusBadge(status!.firewall)}</DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Fail2Ban")}</DescriptionListTerm>
                                    <DescriptionListDescription>{statusBadge(status!.fail2ban)}</DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Audit Daemon")}</DescriptionListTerm>
                                    <DescriptionListDescription>{statusBadge(status!.auditd)}</DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("MAC System")}</DescriptionListTerm>
                                    <DescriptionListDescription>{status!.selinux}</DescriptionListDescription>
                                </DescriptionListGroup>
                            </DescriptionList>
                        </CardBody>
                    </Card>
                </GridItem>

                <GridItem span={6}>
                    <Card className="security-dashboard-card">
                        <CardTitle>{_("Quick Stats")}</CardTitle>
                        <CardBody>
                            <DescriptionList isHorizontal>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Active Connections")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        <span className="security-stat-value">{status!.activeConnections}</span>
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Failed Logins (24h)")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        <span className={`security-stat-value ${status!.failedLogins > 10 ? 'security-status-danger' : ''}`}>
                                            {status!.failedLogins}
                                        </span>
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("SSH Root Login")}</DescriptionListTerm>
                                    <DescriptionListDescription>{status!.sshRootLogin}</DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("System Up Since")}</DescriptionListTerm>
                                    <DescriptionListDescription>{status!.lastBoot}</DescriptionListDescription>
                                </DescriptionListGroup>
                            </DescriptionList>
                        </CardBody>
                    </Card>
                </GridItem>
            </Grid>
        </>
    );
};
