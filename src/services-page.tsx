import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface ServiceInfo {
    name: string;
    displayName: string;
    description: string;
    activeState: string;
    subState: string;
    unitFileState: string;
}

const SERVICES = [
    { unit: "git-daemon.service", displayName: "Git Daemon", description: _("Serves repositories over the git:// protocol") },
    { unit: "sshd.service", displayName: "SSH Server", description: _("Provides SSH access for git push/pull") },
];

export const ServicesPage = () => {
    const [services, setServices] = useState<ServiceInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [actionInProgress, setActionInProgress] = useState<string | null>(null);

    const systemd = cockpit.dbus("org.freedesktop.systemd1", { superuser: "try" });

    const loadServices = useCallback(() => {
        setLoading(true);
        setError("");

        const promises = SERVICES.map(svc => {
            return systemd.call(
                "/org/freedesktop/systemd1",
                "org.freedesktop.systemd1.Manager",
                "GetUnit",
                [svc.unit]
            ).then((result: [string]) => {
                const unitPath = result[0];
                return systemd.call(
                    unitPath,
                    "org.freedesktop.DBus.Properties",
                    "GetAll",
                    ["org.freedesktop.systemd1.Unit"]
                ).then((propsResult: [Record<string, { v: unknown }>]) => {
                    const props = propsResult[0];
                    return {
                        name: svc.unit,
                        displayName: svc.displayName,
                        description: svc.description,
                        activeState: String(props.ActiveState?.v || "unknown"),
                        subState: String(props.SubState?.v || "unknown"),
                        unitFileState: String(props.UnitFileState?.v || "unknown"),
                    };
                });
            }).catch(() => ({
                name: svc.unit,
                displayName: svc.displayName,
                description: svc.description,
                activeState: "not-found",
                subState: "not-found",
                unitFileState: "not-found",
            }));
        });

        Promise.all(promises).then(results => {
            setServices(results);
            setLoading(false);
        }).catch((ex: cockpit.BasicError) => {
            setError(ex.message || String(ex));
            setLoading(false);
        });
    }, [systemd]);

    useEffect(() => { loadServices() }, [loadServices]);

    const toggleService = (svc: ServiceInfo) => {
        setActionInProgress(svc.name);
        const method = svc.activeState === "active" ? "StopUnit" : "StartUnit";

        systemd.call(
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
            method,
            [svc.name, "replace"]
        ).then(() => {
            // Wait a moment for the state to change
            setTimeout(loadServices, 1000);
            setActionInProgress(null);
        }).catch((ex: cockpit.BasicError) => {
            setError(ex.message || String(ex));
            setActionInProgress(null);
        });
    };

    const restartService = (svc: ServiceInfo) => {
        setActionInProgress(svc.name);

        systemd.call(
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
            "RestartUnit",
            [svc.name, "replace"]
        ).then(() => {
            setTimeout(loadServices, 1000);
            setActionInProgress(null);
        }).catch((ex: cockpit.BasicError) => {
            setError(ex.message || String(ex));
            setActionInProgress(null);
        });
    };

    const stateColor = (state: string): "green" | "red" | "grey" | "orange" => {
        switch (state) {
        case "active": return "green";
        case "failed": return "red";
        case "inactive": return "grey";
        case "not-found": return "orange";
        default: return "grey";
        }
    };

    if (loading) return <Spinner aria-label={_("Loading services")} />;

    return (
        <>
            <CardTitle>{_("Service Management")}</CardTitle>

            {error && <Alert variant="danger" title={error} isInline style={{ marginBottom: "1rem" }} />}

            {services.map(svc => (
                <Card key={svc.name} isCompact style={{ marginBottom: "1rem" }}>
                    <CardTitle>
                        {svc.displayName}
                        <Label color={stateColor(svc.activeState)} style={{ marginLeft: "1rem" }}>
                            {svc.activeState === "not-found" ? _("Not installed") : `${svc.activeState} (${svc.subState})`}
                        </Label>
                    </CardTitle>
                    <CardBody>
                        <p>{svc.description}</p>

                        <DescriptionList isHorizontal isCompact style={{ marginTop: "0.5rem" }}>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Unit")}</DescriptionListTerm>
                                <DescriptionListDescription>{svc.name}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Enabled")}</DescriptionListTerm>
                                <DescriptionListDescription>{svc.unitFileState}</DescriptionListDescription>
                            </DescriptionListGroup>
                        </DescriptionList>

                        {svc.activeState !== "not-found" && (
                            <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                                <Switch
                                    id={`switch-${svc.name}`}
                                    label={_("Running")}
                                    labelOff={_("Stopped")}
                                    isChecked={svc.activeState === "active"}
                                    onChange={() => toggleService(svc)}
                                    isDisabled={actionInProgress === svc.name}
                                />
                                <Button
                                    variant="secondary"
                                    onClick={() => restartService(svc)}
                                    isDisabled={svc.activeState !== "active" || actionInProgress === svc.name}
                                    isLoading={actionInProgress === svc.name}
                                >
                                    {_("Restart")}
                                </Button>
                            </div>
                        )}
                    </CardBody>
                </Card>
            ))}
        </>
    );
};
