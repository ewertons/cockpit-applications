import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { ActionList, ActionListItem } from "@patternfly/react-core/dist/esm/components/ActionList/index.js";
import { DescriptionList, DescriptionListGroup, DescriptionListTerm, DescriptionListDescription } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface FirewallZone {
    name: string;
    interfaces: string[];
    services: string[];
    ports: string[];
}

type FirewallBackend = "firewalld" | "ufw" | "nftables" | "none";

export const FirewallPage = () => {
    const [backend, setBackend] = useState<FirewallBackend>("none");
    const [active, setActive] = useState(false);
    const [loading, setLoading] = useState(true);
    const [zones, setZones] = useState<FirewallZone[]>([]);
    const [ufwRules, setUfwRules] = useState<string[]>([]);
    const [newPort, setNewPort] = useState("");
    const [newService, setNewService] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    useEffect(() => {
        detectBackend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const detectBackend = async () => {
        setLoading(true);
        try {
            const fw = await cockpit.spawn(["systemctl", "is-active", "firewalld"], { err: "ignore" });
            if (fw.trim() === "active") {
                setBackend("firewalld");
                setActive(true);
                await loadFirewalldZones();
                setLoading(false);
                return;
            }
        } catch { /* not firewalld */ }

        try {
            const ufw = await cockpit.spawn(["ufw", "status", "verbose"], { err: "ignore", superuser: "try" });
            if (ufw.includes("Status: active")) {
                setBackend("ufw");
                setActive(true);
                await loadUfwRules();
                setLoading(false);
                return;
            } else if (ufw.includes("Status: inactive")) {
                setBackend("ufw");
                setActive(false);
                setLoading(false);
                return;
            }
        } catch { /* not ufw */ }

        try {
            const nft = await cockpit.spawn(["systemctl", "is-active", "nftables"], { err: "ignore" });
            if (nft.trim() === "active") {
                setBackend("nftables");
                setActive(true);
            }
        } catch { /* not nftables */ }

        setLoading(false);
    };

    const loadFirewalldZones = async () => {
        try {
            const zoneList = await cockpit.spawn(["firewall-cmd", "--get-active-zones"], { err: "ignore", superuser: "try" });
            const zoneNames: string[] = [];
            const lines = zoneList.trim().split("\n");
            for (const line of lines) {
                if (!line.startsWith(" ") && !line.startsWith("\t") && line.trim()) {
                    zoneNames.push(line.trim());
                }
            }

            const zoneDetails: FirewallZone[] = [];
            for (const name of zoneNames) {
                try {
                    const info = await cockpit.spawn(["firewall-cmd", "--zone=" + name, "--list-all"], { err: "ignore", superuser: "try" });
                    const services = (info.match(/services:\s*(.*)/) || ["", ""])[1].trim().split(/\s+/)
                            .filter(Boolean);
                    const ports = (info.match(/ports:\s*(.*)/) || ["", ""])[1].trim().split(/\s+/)
                            .filter(Boolean);
                    const ifaces = (info.match(/interfaces:\s*(.*)/) || ["", ""])[1].trim().split(/\s+/)
                            .filter(Boolean);
                    zoneDetails.push({ name, services, ports, interfaces: ifaces });
                } catch { /* skip zone */ }
            }
            setZones(zoneDetails);
        } catch (e) {
            setError(String(e));
        }
    };

    const loadUfwRules = async () => {
        try {
            const rules = await cockpit.spawn(["ufw", "status", "numbered"], { err: "ignore", superuser: "try" });
            const ruleLines = rules.split("\n").filter(l => l.match(/^\[\s*\d+\]/));
            setUfwRules(ruleLines);
        } catch (e) {
            setError(String(e));
        }
    };

    const toggleFirewall = async () => {
        setError("");
        setSuccess("");
        try {
            if (backend === "firewalld") {
                if (active) {
                    await cockpit.spawn(["systemctl", "stop", "firewalld"], { superuser: "require" });
                } else {
                    await cockpit.spawn(["systemctl", "start", "firewalld"], { superuser: "require" });
                }
            } else if (backend === "ufw") {
                if (active) {
                    await cockpit.spawn(["ufw", "disable"], { superuser: "require" });
                } else {
                    await cockpit.spawn(["ufw", "--force", "enable"], { superuser: "require" });
                }
            }
            setActive(!active);
            setSuccess(active ? _("Firewall disabled") : _("Firewall enabled"));
        } catch (e) {
            setError(String(e));
        }
    };

    const addPort = async () => {
        if (!newPort) return;
        setError("");
        setSuccess("");
        try {
            if (backend === "firewalld") {
                await cockpit.spawn(["firewall-cmd", "--permanent", "--add-port=" + newPort + "/tcp"], { superuser: "require" });
                await cockpit.spawn(["firewall-cmd", "--reload"], { superuser: "require" });
                await loadFirewalldZones();
            } else if (backend === "ufw") {
                await cockpit.spawn(["ufw", "allow", newPort + "/tcp"], { superuser: "require" });
                await loadUfwRules();
            }
            setSuccess(_("Port added: ") + newPort);
            setNewPort("");
        } catch (e) {
            setError(String(e));
        }
    };

    const addService = async () => {
        if (!newService) return;
        setError("");
        setSuccess("");
        try {
            if (backend === "firewalld") {
                await cockpit.spawn(["firewall-cmd", "--permanent", "--add-service=" + newService], { superuser: "require" });
                await cockpit.spawn(["firewall-cmd", "--reload"], { superuser: "require" });
                await loadFirewalldZones();
            } else if (backend === "ufw") {
                await cockpit.spawn(["ufw", "allow", newService], { superuser: "require" });
                await loadUfwRules();
            }
            setSuccess(_("Service allowed: ") + newService);
            setNewService("");
        } catch (e) {
            setError(String(e));
        }
    };

    if (loading) return <Spinner />;

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("Firewall Management")}</Title>

            {error && <Alert variant="danger" title={error} className="pf-v6-u-mb-md" />}
            {success && <Alert variant="success" title={success} className="pf-v6-u-mb-md" />}

            {backend === "none"
                ? (
                    <Alert variant="warning" title={_("No firewall backend detected. Install firewalld, ufw, or nftables.")} />
                )
                : (
                    <>
                        <Card className="pf-v6-u-mb-md">
                            <CardTitle>{_("Firewall Status")}</CardTitle>
                            <CardBody>
                                <DescriptionList isHorizontal>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Backend")}</DescriptionListTerm>
                                        <DescriptionListDescription>{backend}</DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Status")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            <Switch
                                            id="firewall-toggle"
                                            label={_("Active")}
                                            labelOff={_("Inactive")}
                                            isChecked={active}
                                            onChange={toggleFirewall}
                                            />
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                </DescriptionList>
                            </CardBody>
                        </Card>

                        <Card className="pf-v6-u-mb-md">
                            <CardTitle>{_("Add Rule")}</CardTitle>
                            <CardBody>
                                <ActionList>
                                    <ActionListItem>
                                        <FormGroup label={_("Port (e.g. 8080)")}>
                                            <TextInput value={newPort} onChange={(_e, val) => setNewPort(val)} />
                                        </FormGroup>
                                    </ActionListItem>
                                    <ActionListItem>
                                        <Button onClick={addPort} isDisabled={!newPort}>{_("Allow Port")}</Button>
                                    </ActionListItem>
                                    <ActionListItem>
                                        <FormGroup label={_("Service (e.g. http)")}>
                                            <TextInput value={newService} onChange={(_e, val) => setNewService(val)} />
                                        </FormGroup>
                                    </ActionListItem>
                                    <ActionListItem>
                                        <Button onClick={addService} isDisabled={!newService}>{_("Allow Service")}</Button>
                                    </ActionListItem>
                                </ActionList>
                            </CardBody>
                        </Card>

                        {backend === "firewalld" && zones.length > 0 && (
                            <Card>
                                <CardTitle>{_("Active Zones")}</CardTitle>
                                <CardBody>
                                    {zones.map(zone => (
                                        <div key={zone.name} className="pf-v6-u-mb-md">
                                            <Title headingLevel="h3">{zone.name}</Title>
                                            <DescriptionList isHorizontal isCompact>
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>{_("Interfaces")}</DescriptionListTerm>
                                                    <DescriptionListDescription>{zone.interfaces.join(", ") || _("none")}</DescriptionListDescription>
                                                </DescriptionListGroup>
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>{_("Services")}</DescriptionListTerm>
                                                    <DescriptionListDescription>{zone.services.join(", ") || _("none")}</DescriptionListDescription>
                                                </DescriptionListGroup>
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>{_("Ports")}</DescriptionListTerm>
                                                    <DescriptionListDescription>{zone.ports.join(", ") || _("none")}</DescriptionListDescription>
                                                </DescriptionListGroup>
                                            </DescriptionList>
                                        </div>
                                    ))}
                                </CardBody>
                            </Card>
                        )}

                        {backend === "ufw" && ufwRules.length > 0 && (
                            <Card>
                                <CardTitle>{_("UFW Rules")}</CardTitle>
                                <CardBody>
                                    <div className="log-viewer">
                                        {ufwRules.join("\n")}
                                    </div>
                                </CardBody>
                            </Card>
                        )}
                    </>
                )}
        </>
    );
};
