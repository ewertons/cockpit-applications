import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { DescriptionList, DescriptionListGroup, DescriptionListTerm, DescriptionListDescription } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { Popover } from "@patternfly/react-core/dist/esm/components/Popover/index.js";
import { OutlinedQuestionCircleIcon } from "@patternfly/react-icons/dist/esm/icons";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface Fail2BanJail {
    name: string;
    enabled: boolean;
    currentlyBanned: number;
    totalBanned: number;
    currentlyFailed: number;
    filter: string;
}

export const Fail2BanPage = () => {
    const [installed, setInstalled] = useState(false);
    const [active, setActive] = useState(false);
    const [jails, setJails] = useState<Fail2BanJail[]>([]);
    const [bannedIPs, setBannedIPs] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [unbanIP, setUnbanIP] = useState("");
    const [installing, setInstalling] = useState(false);

    useEffect(() => {
        loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const loadStatus = async () => {
        setLoading(true);
        try {
            const status = await cockpit.spawn(["systemctl", "is-active", "fail2ban"], { err: "ignore" });
            setInstalled(true);
            setActive(status.trim() === "active");
            if (status.trim() === "active") {
                await loadJails();
                await loadBannedIPs();
            }
        } catch {
            // Check if fail2ban-client exists
            try {
                await cockpit.spawn(["which", "fail2ban-client"], { err: "ignore" });
                setInstalled(true);
            } catch {
                setInstalled(false);
            }
        }
        setLoading(false);
    };

    const loadJails = async () => {
        try {
            const output = await cockpit.spawn(["fail2ban-client", "status"], { err: "ignore", superuser: "try" });
            const jailMatch = output.match(/Jail list:\s*(.*)/);
            if (!jailMatch) return;

            const jailNames = jailMatch[1].split(",").map(s => s.trim())
                    .filter(Boolean);
            const jailDetails: Fail2BanJail[] = [];

            for (const name of jailNames) {
                try {
                    const jailStatus = await cockpit.spawn(["fail2ban-client", "status", name], { err: "ignore", superuser: "try" });
                    const banned = parseInt((jailStatus.match(/Currently banned:\s*(\d+)/) || ["", "0"])[1]);
                    const totalBanned = parseInt((jailStatus.match(/Total banned:\s*(\d+)/) || ["", "0"])[1]);
                    const failed = parseInt((jailStatus.match(/Currently failed:\s*(\d+)/) || ["", "0"])[1]);
                    const filter = (jailStatus.match(/Filter:\s*(\S+)/) || ["", ""])[1];
                    jailDetails.push({
                        name,
                        enabled: true,
                        currentlyBanned: banned,
                        totalBanned,
                        currentlyFailed: failed,
                        filter,
                    });
                } catch { /* skip jail */ }
            }
            setJails(jailDetails);
        } catch (e) {
            setError(String(e));
        }
    };

    const loadBannedIPs = async () => {
        try {
            const output = await cockpit.spawn(["fail2ban-client", "banned"], { err: "ignore", superuser: "try" });
            // Parse banned IPs from output
            const ips: string[] = [];
            const matches = output.matchAll(/'([^']+)'/g);
            for (const m of matches) {
                ips.push(m[1]);
            }
            setBannedIPs(ips);
        } catch {
            setBannedIPs([]);
        }
    };

    const installFail2Ban = async () => {
        setInstalling(true);
        setError("");
        try {
            // Detect package manager and install
            try {
                await cockpit.spawn(["which", "dnf"], { err: "ignore" });
                await cockpit.spawn(["dnf", "install", "-y", "fail2ban"], { superuser: "require", err: "message" });
            } catch {
                try {
                    await cockpit.spawn(["which", "apt-get"], { err: "ignore" });
                    await cockpit.spawn(["apt-get", "install", "-y", "fail2ban"], { superuser: "require", err: "message" });
                } catch {
                    try {
                        await cockpit.spawn(["which", "yum"], { err: "ignore" });
                        await cockpit.spawn(["yum", "install", "-y", "fail2ban"], { superuser: "require", err: "message" });
                    } catch {
                        throw new Error(_("Could not detect package manager. Install fail2ban manually."));
                    }
                }
            }
            setSuccess(_("Fail2Ban installed successfully"));
            await loadStatus();
        } catch (e) {
            setError(String(e));
        }
        setInstalling(false);
    };

    const toggleService = async () => {
        setError("");
        setSuccess("");
        try {
            if (active) {
                await cockpit.spawn(["systemctl", "stop", "fail2ban"], { superuser: "require" });
                setSuccess(_("Fail2Ban stopped"));
            } else {
                await cockpit.spawn(["systemctl", "start", "fail2ban"], { superuser: "require" });
                setSuccess(_("Fail2Ban started"));
            }
            setActive(!active);
            if (!active) {
                await loadJails();
                await loadBannedIPs();
            }
        } catch (e) {
            setError(String(e));
        }
    };

    const handleUnban = async () => {
        if (!unbanIP) return;
        setError("");
        setSuccess("");
        try {
            await cockpit.spawn(["fail2ban-client", "unban", unbanIP], { superuser: "require" });
            setSuccess(_("Unbanned: ") + unbanIP);
            setUnbanIP("");
            await loadBannedIPs();
            await loadJails();
        } catch (e) {
            setError(String(e));
        }
    };

    if (loading) return <Spinner />;

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("Fail2Ban")}</Title>

            {error && <Alert variant="danger" title={error} className="pf-v6-u-mb-md" />}
            {success && <Alert variant="success" title={success} className="pf-v6-u-mb-md" />}

            <HelperText className="pf-v6-u-mb-md">
                <HelperTextItem variant="indeterminate">
                    {_("Fail2Ban monitors log files for malicious activity (e.g. repeated failed login attempts) and automatically bans offending IP addresses using firewall rules.")}
                </HelperTextItem>
            </HelperText>

            {!installed
                ? (
                    <Alert variant="warning" title={_("Fail2Ban is not installed.")}>
                        <Button variant="primary" className="pf-v6-u-mt-sm" onClick={installFail2Ban} isLoading={installing} isDisabled={installing}>
                            {installing ? _("Installing…") : _("Install Fail2Ban")}
                        </Button>
                    </Alert>
                )
                : (
                    <>
                        <Card className="pf-v6-u-mb-md">
                            <CardTitle>{_("Service Status")}</CardTitle>
                            <CardBody>
                                <DescriptionList isHorizontal>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Status")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            <Switch
                                            id="f2b-toggle"
                                            label={_("Active")}
                                            labelOff={_("Inactive")}
                                            isChecked={active}
                                            onChange={toggleService}
                                            />
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>
                                            {_("Active Jails")}{" "}
                                            <Popover bodyContent={_("Jails are monitoring rules. Each jail watches a specific service's log file for suspicious patterns and bans IPs that exceed the failure threshold.")}>
                                                <Button variant="plain" isInline aria-label={_("More info about jails")}><OutlinedQuestionCircleIcon /></Button>
                                            </Popover>
                                        </DescriptionListTerm>
                                        <DescriptionListDescription>{jails.length}</DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>
                                            {_("Currently Banned IPs")}{" "}
                                            <Popover bodyContent={_("IP addresses currently blocked by firewall rules due to exceeding the allowed number of failed attempts within the configured time window.")}>
                                                <Button variant="plain" isInline aria-label={_("More info about banned IPs")}><OutlinedQuestionCircleIcon /></Button>
                                            </Popover>
                                        </DescriptionListTerm>
                                        <DescriptionListDescription>
                                            <span className={bannedIPs.length > 0 ? "security-status-warning" : ""}>
                                                {bannedIPs.length}
                                            </span>
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                </DescriptionList>
                            </CardBody>
                        </Card>

                        {active && (
                            <>
                                <Card className="pf-v6-u-mb-md">
                                    <CardTitle>
                                        {_("Jails")}{" "}
                                        <Popover bodyContent={_("Each jail monitors a specific service (e.g. SSH, Apache) for repeated authentication failures. When an IP exceeds the 'maxretry' threshold within the 'findtime' window, it gets banned for the configured 'bantime'.")}>
                                            <Button variant="plain" isInline aria-label={_("More info about jails")}><OutlinedQuestionCircleIcon /></Button>
                                        </Popover>
                                    </CardTitle>
                                    <CardBody>
                                        <table className="pf-v6-c-table pf-m-compact">
                                            <thead>
                                                <tr>
                                                    <th>{_("Jail")}</th>
                                                    <th>{_("Currently Banned")}</th>
                                                    <th>{_("Total Banned")}</th>
                                                    <th>{_("Currently Failed")}</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {jails.map(j => (
                                                    <tr key={j.name}>
                                                        <td><strong>{j.name}</strong></td>
                                                        <td>{j.currentlyBanned}</td>
                                                        <td>{j.totalBanned}</td>
                                                        <td>{j.currentlyFailed}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </CardBody>
                                </Card>

                                {bannedIPs.length > 0 && (
                                    <Card className="pf-v6-u-mb-md">
                                        <CardTitle>{_("Banned IPs")}</CardTitle>
                                        <CardBody>
                                            <div className="log-viewer">
                                                {bannedIPs.join("\n")}
                                            </div>
                                            <div className="pf-v6-u-mt-md">
                                                <FormGroup label={_("Unban IP Address")}>
                                                    <TextInput value={unbanIP} onChange={(_e, val) => setUnbanIP(val)} placeholder="192.168.1.100" />
                                                </FormGroup>
                                                <Button className="pf-v6-u-mt-sm" onClick={handleUnban} isDisabled={!unbanIP}>
                                                    {_("Unban")}
                                                </Button>
                                            </div>
                                        </CardBody>
                                    </Card>
                                )}
                            </>
                        )}
                    </>
                )}
        </>
    );
};
