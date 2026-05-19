import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Progress, ProgressMeasureLocation, ProgressVariant } from "@patternfly/react-core/dist/esm/components/Progress/index.js";
import { CheckCircleIcon, ExclamationCircleIcon, ExclamationTriangleIcon, QuestionCircleIcon, ShieldAltIcon, RedoIcon } from "@patternfly/react-icons/dist/esm/icons";

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
            // Check firewall (try firewalld, then ufw, then nftables)
            try {
                const fw = await cockpit.spawn(["systemctl", "show", "-p", "ActiveState", "--value", "firewalld"], { err: "ignore" });
                if (fw.trim() === "active") {
                    result.firewall = "active";
                } else {
                    // firewalld exists but isn't active, try ufw
                    throw new Error("not active");
                }
            } catch {
                try {
                    const ufw = await cockpit.spawn(["ufw", "status"], { err: "ignore", superuser: "try" });
                    result.firewall = ufw.includes("active") ? "active" : "inactive";
                } catch {
                    try {
                        const nft = await cockpit.spawn(["systemctl", "show", "-p", "ActiveState", "--value", "nftables"], { err: "ignore" });
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
                const f2b = await cockpit.spawn(["systemctl", "show", "-p", "ActiveState", "--value", "fail2ban"], { err: "ignore" });
                result.fail2ban = f2b.trim() === "active" ? "active" : "inactive";
            } catch {
                result.fail2ban = "inactive";
            }
            if (result.fail2ban !== "active") {
                newAlerts.push(_("Fail2Ban is not running"));
            }

            // Check auditd
            try {
                const aud = await cockpit.spawn(["systemctl", "show", "-p", "ActiveState", "--value", "auditd"], { err: "ignore" });
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
        return <Spinner aria-label={_("Loading security overview")} />;
    }

    // Compute a security score (0-100)
    const computeScore = (): number => {
        if (!status) return 0;
        let score = 0;
        const total = 5;
        if (status.firewall === "active") score++;
        if (status.fail2ban === "active") score++;
        if (status.auditd === "active") score++;
        if (status.sshRootLogin === "no" || status.sshRootLogin === "prohibit-password") score++;
        if (status.selinux.includes("Enforcing") || status.selinux.includes("AppArmor")) score++;
        return Math.round((score / total) * 100);
    };

    const score = computeScore();
    const scoreVariant = score >= 80 ? ProgressVariant.success : score >= 50 ? ProgressVariant.warning : ProgressVariant.danger;

    const statusLabel = (state: "active" | "inactive" | "unknown") => {
        if (state === "active") {
            return (
                <Label color="green" icon={<CheckCircleIcon />}>
                    {_("Active")}
                </Label>
            );
        }
        if (state === "inactive") {
            return (
                <Label color="red" icon={<ExclamationCircleIcon />}>
                    {_("Inactive")}
                </Label>
            );
        }
        return (
            <Label color="gold" icon={<QuestionCircleIcon />}>
                {_("Unknown")}
            </Label>
        );
    };

    const sshLabel = (value: string) => {
        if (value === "no" || value === "prohibit-password") {
            return <Label color="green" icon={<CheckCircleIcon />}>{value}</Label>;
        }
        return <Label color="red" icon={<ExclamationCircleIcon />}>{value}</Label>;
    };

    const serviceRows = [
        { name: _("Firewall"), status: status!.firewall, page: "firewall" },
        { name: _("Fail2Ban"), status: status!.fail2ban, page: "fail2ban" },
        { name: _("Audit Daemon"), status: status!.auditd, page: "audit-log" },
    ];

    return (
        <>
            {/* Page header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <ShieldAltIcon style={{ fontSize: "1.5rem", color: score >= 80 ? "var(--pf-t--global--color--status--success--default)" : score >= 50 ? "var(--pf-t--global--color--status--warning--default)" : "var(--pf-t--global--color--status--danger--default)" }} />
                    <Title headingLevel="h1">{_("Security Overview")}</Title>
                </div>
                <Button variant="secondary" icon={<RedoIcon />} onClick={loadStatus}>
                    {_("Refresh")}
                </Button>
            </div>

            {/* Alert banner */}
            {alerts.length > 0 && (
                <Alert variant="warning" title={_("Security Alerts")} isInline style={{ marginBottom: "1.5rem" }}>
                    {alerts.map((a, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: i > 0 ? "0.25rem" : 0 }}>
                            <ExclamationTriangleIcon />
                            <span>{a}</span>
                        </div>
                    ))}
                </Alert>
            )}

            {/* Stat cards row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
                <Card isCompact>
                    <CardBody className="stat-card">
                        <div style={{ marginBottom: "0.5rem" }}>
                            <ShieldAltIcon style={{ fontSize: "1.5rem", color: score >= 80 ? "var(--pf-t--global--color--status--success--default)" : score >= 50 ? "var(--pf-t--global--color--status--warning--default)" : "var(--pf-t--global--color--status--danger--default)" }} />
                        </div>
                        <div className="stat-value">{score}%</div>
                        <div className="stat-label">{_("Security Score")}</div>
                    </CardBody>
                </Card>
                <Card isCompact>
                    <CardBody className="stat-card">
                        <div className="stat-value" style={{ color: alerts.length > 0 ? "var(--pf-t--global--color--status--warning--default)" : "var(--pf-t--global--color--status--success--default)" }}>
                            {alerts.length}
                        </div>
                        <div className="stat-label">{_("Active Alerts")}</div>
                    </CardBody>
                </Card>
                <Card isCompact>
                    <CardBody className="stat-card">
                        <div className="stat-value">{status!.activeConnections}</div>
                        <div className="stat-label">{_("Active Connections")}</div>
                    </CardBody>
                </Card>
                <Card isCompact>
                    <CardBody className="stat-card">
                        <div className="stat-value" style={{ color: status!.failedLogins > 10 ? "var(--pf-t--global--color--status--danger--default)" : undefined }}>
                            {status!.failedLogins}
                        </div>
                        <div className="stat-label">{_("Failed Logins (24h)")}</div>
                    </CardBody>
                </Card>
                <Card isCompact>
                    <CardBody className="stat-card">
                        <div className="stat-value" style={{ fontSize: "var(--pf-t--global--font--size--md)" }}>{status!.lastBoot || "—"}</div>
                        <div className="stat-label">{_("System Up Since")}</div>
                    </CardBody>
                </Card>
            </div>

            {/* Security score progress */}
            <Card isCompact style={{ marginBottom: "1.5rem" }}>
                <CardTitle>{_("Security Posture")}</CardTitle>
                <CardBody>
                    <Progress
                        value={score}
                        title={_("Security Score")}
                        variant={scoreVariant}
                        measureLocation={ProgressMeasureLocation.outside}
                    />
                    <p style={{ marginTop: "0.75rem", fontSize: "var(--pf-t--global--font--size--sm)", color: "var(--pf-t--global--text--color--subtle)" }}>
                        {score >= 80
                            ? _("Good — core security services are active.")
                            : score >= 50
                                ? _("Fair — some services need attention.")
                                : _("Critical — multiple security issues detected.")}
                    </p>
                </CardBody>
            </Card>

            {/* Services status */}
            <Card isCompact style={{ marginBottom: "1.5rem" }}>
                <CardTitle>{_("Services Status")}</CardTitle>
                <CardBody>
                    {serviceRows.map((svc, i) => (
                        <div key={svc.page} style={{
                            display: "flex", justifyContent: "space-between", alignItems: "center",
                            padding: "0.625rem 0",
                            borderBottom: i < serviceRows.length - 1 ? "1px solid var(--pf-t--global--border--color--default)" : undefined
                        }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                                <strong>{svc.name}</strong>
                                {statusLabel(svc.status)}
                            </div>
                            <Button variant="link" isInline onClick={() => cockpit.location.go([svc.page])}>
                                {_("Manage")} &rsaquo;
                            </Button>
                        </div>
                    ))}
                    <div style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "0.625rem 0",
                        borderTop: "1px solid var(--pf-t--global--border--color--default)"
                    }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                            <strong>{_("MAC System")}</strong>
                            {status!.selinux.includes("Enforcing") || status!.selinux.includes("AppArmor")
                                ? <Label color="green" icon={<CheckCircleIcon />}>{status!.selinux}</Label>
                                : <Label color="gold" icon={<ExclamationTriangleIcon />}>{status!.selinux}</Label>}
                        </div>
                        <Button variant="link" isInline onClick={() => cockpit.location.go(["selinux"])}>
                            {_("Manage")} &rsaquo;
                        </Button>
                    </div>
                </CardBody>
            </Card>

            {/* SSH & Access */}
            <Card isCompact style={{ marginBottom: "1.5rem" }}>
                <CardTitle>{_("SSH & Access")}</CardTitle>
                <CardBody>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                            <strong>{_("Root Login")}</strong>
                            {sshLabel(status!.sshRootLogin)}
                        </div>
                        <Button variant="link" isInline onClick={() => cockpit.location.go(["ssh-hardening"])}>
                            {_("Harden SSH")} &rsaquo;
                        </Button>
                    </div>
                    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                        <Button variant="secondary" size="sm" onClick={() => cockpit.location.go(["user-security"])}>
                            {_("Users & Auth")}
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => cockpit.location.go(["open-ports"])}>
                            {_("Open Ports")}
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => cockpit.location.go(["certificates"])}>
                            {_("Certificates")}
                        </Button>
                    </div>
                </CardBody>
            </Card>

            {/* Quick actions */}
            <Card isCompact style={{ marginBottom: "1.5rem" }}>
                <CardTitle>{_("Quick Actions")}</CardTitle>
                <CardBody>
                    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                        <Button variant="primary" onClick={() => cockpit.location.go(["firewall"])}>
                            {_("Configure Firewall")}
                        </Button>
                        <Button variant="secondary" onClick={() => cockpit.location.go(["ssh-hardening"])}>
                            {_("Harden SSH")}
                        </Button>
                        <Button variant="secondary" onClick={() => cockpit.location.go(["audit-log"])}>
                            {_("View Audit Logs")}
                        </Button>
                        <Button variant="secondary" onClick={() => cockpit.location.go(["intrusion-detection"])}>
                            {_("Intrusion Detection")}
                        </Button>
                        <Button variant="secondary" onClick={() => cockpit.location.go(["system-updates"])}>
                            {_("System Updates")}
                        </Button>
                    </div>
                </CardBody>
            </Card>
        </>
    );
};
