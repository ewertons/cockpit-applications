import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { DescriptionList, DescriptionListGroup, DescriptionListTerm, DescriptionListDescription } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface SSHConfig {
    permitRootLogin: string;
    passwordAuthentication: string;
    pubkeyAuthentication: string;
    port: string;
    maxAuthTries: string;
    permitEmptyPasswords: string;
    x11Forwarding: string;
    protocol: string;
    loginGraceTime: string;
    clientAliveInterval: string;
    clientAliveCountMax: string;
    allowUsers: string;
    allowGroups: string;
}

export const SSHHardeningPage = () => {
    const [config, setConfig] = useState<SSHConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [rawConfig, setRawConfig] = useState("");

    useEffect(() => {
        loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const loadConfig = async () => {
        setLoading(true);
        try {
            const content = await cockpit.file("/etc/ssh/sshd_config").read();
            setRawConfig(content);
            parseConfig(content);
        } catch {
            setError(_("Cannot read SSH configuration"));
        }
        setLoading(false);
    };

    const parseConfig = (content: string) => {
        const get = (key: string): string => {
            const match = content.match(new RegExp(`^\\s*${key}\\s+(\\S+)`, "mi"));
            return match ? match[1] : "";
        };

        setConfig({
            permitRootLogin: get("PermitRootLogin") || "yes (default)",
            passwordAuthentication: get("PasswordAuthentication") || "yes (default)",
            pubkeyAuthentication: get("PubkeyAuthentication") || "yes (default)",
            port: get("Port") || "22 (default)",
            maxAuthTries: get("MaxAuthTries") || "6 (default)",
            permitEmptyPasswords: get("PermitEmptyPasswords") || "no (default)",
            x11Forwarding: get("X11Forwarding") || "no (default)",
            protocol: get("Protocol") || "2",
            loginGraceTime: get("LoginGraceTime") || "120 (default)",
            clientAliveInterval: get("ClientAliveInterval") || "0 (default)",
            clientAliveCountMax: get("ClientAliveCountMax") || "3 (default)",
            allowUsers: get("AllowUsers") || "",
            allowGroups: get("AllowGroups") || "",
        });
    };

    const applySetting = async (key: string, value: string) => {
        setError("");
        setSuccess("");
        try {
            let content = rawConfig;
            const regex = new RegExp(`^\\s*#?\\s*${key}\\s+.*$`, "mi");
            if (content.match(regex)) {
                content = content.replace(regex, `${key} ${value}`);
            } else {
                content += `\n${key} ${value}\n`;
            }

            await cockpit.file("/etc/ssh/sshd_config", { superuser: "require" }).replace(content);
            setRawConfig(content);
            parseConfig(content);
            setSuccess(_("Setting applied: ") + key + " = " + value);
        } catch (e) {
            setError(String(e));
        }
    };

    const restartSSHD = async () => {
        setError("");
        try {
            await cockpit.spawn(["systemctl", "restart", "sshd"], { superuser: "require" });
            setSuccess(_("SSHD restarted successfully"));
        } catch (e) {
            setError(String(e));
        }
    };

    const hardenAll = async () => {
        setError("");
        setSuccess("");
        try {
            let content = rawConfig;
            const settings: Record<string, string> = {
                PermitRootLogin: "no",
                PasswordAuthentication: "no",
                PermitEmptyPasswords: "no",
                X11Forwarding: "no",
                MaxAuthTries: "3",
                LoginGraceTime: "60",
                ClientAliveInterval: "300",
                ClientAliveCountMax: "2",
            };

            for (const [key, value] of Object.entries(settings)) {
                const regex = new RegExp(`^\\s*#?\\s*${key}\\s+.*$`, "mi");
                if (content.match(regex)) {
                    content = content.replace(regex, `${key} ${value}`);
                } else {
                    content += `\n${key} ${value}\n`;
                }
            }

            await cockpit.file("/etc/ssh/sshd_config", { superuser: "require" }).replace(content);
            setRawConfig(content);
            parseConfig(content);
            setSuccess(_("All hardening settings applied. Restart SSHD to activate."));
        } catch (e) {
            setError(String(e));
        }
    };

    if (loading) return <Spinner />;

    const isSecure = (setting: string, goodValues: string[]): boolean => {
        return goodValues.some(v => setting.toLowerCase().startsWith(v.toLowerCase()));
    };

    const statusIcon = (setting: string, goodValues: string[]) => {
        if (isSecure(setting, goodValues)) {
            return <span className="security-status-good">✓ {setting}</span>;
        }
        return <span className="security-status-danger">✗ {setting}</span>;
    };

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("SSH Hardening")}</Title>

            {error && <Alert variant="danger" title={error} className="pf-v6-u-mb-md" />}
            {success && <Alert variant="success" title={success} className="pf-v6-u-mb-md" />}

            <div className="pf-v6-u-mb-md">
                <Button variant="danger" onClick={hardenAll} className="pf-v6-u-mr-sm">
                    {_("Apply All Hardening")}
                </Button>
                <Button variant="primary" onClick={restartSSHD}>
                    {_("Restart SSHD")}
                </Button>
            </div>

            {config && (
                <Card className="pf-v6-u-mb-md">
                    <CardTitle>{_("Current Configuration")}</CardTitle>
                    <CardBody>
                        <DescriptionList isHorizontal>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Permit Root Login")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {statusIcon(config.permitRootLogin, ["no", "prohibit-password"])}
                                    <Button variant="link" size="sm" onClick={() => applySetting("PermitRootLogin", "no")}>
                                        {_("Disable")}
                                    </Button>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Password Auth")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {statusIcon(config.passwordAuthentication, ["no"])}
                                    <Button variant="link" size="sm" onClick={() => applySetting("PasswordAuthentication", "no")}>
                                        {_("Disable")}
                                    </Button>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Pubkey Auth")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {statusIcon(config.pubkeyAuthentication, ["yes"])}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Port")}</DescriptionListTerm>
                                <DescriptionListDescription>{config.port}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Max Auth Tries")}</DescriptionListTerm>
                                <DescriptionListDescription>{config.maxAuthTries}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Empty Passwords")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {statusIcon(config.permitEmptyPasswords, ["no"])}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("X11 Forwarding")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {statusIcon(config.x11Forwarding, ["no"])}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Login Grace Time")}</DescriptionListTerm>
                                <DescriptionListDescription>{config.loginGraceTime}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Client Alive Interval")}</DescriptionListTerm>
                                <DescriptionListDescription>{config.clientAliveInterval}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Allow Users")}</DescriptionListTerm>
                                <DescriptionListDescription>{config.allowUsers || _("(not set - all users allowed)")}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Allow Groups")}</DescriptionListTerm>
                                <DescriptionListDescription>{config.allowGroups || _("(not set - all groups allowed)")}</DescriptionListDescription>
                            </DescriptionListGroup>
                        </DescriptionList>
                    </CardBody>
                </Card>
            )}
        </>
    );
};
