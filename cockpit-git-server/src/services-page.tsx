import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface ServiceDef {
    units: string[]; // possible unit names (first found wins)
    displayName: string;
    description: string;
    packages: { apt: string; dnf: string };
    port?: number; // port to check in firewall
}

interface ServiceInfo extends ServiceDef {
    unit: string; // resolved unit name
    activeState: string;
    subState: string;
    unitFileState: string;
    installed: boolean;
    firewallBlocked?: boolean; // true if port is blocked by ufw
}

const SERVICES: ServiceDef[] = [
    {
        units: ["git-daemon.service"],
        displayName: "Git Daemon",
        description: _("Serves repositories over the git:// protocol"),
        packages: { apt: "git-daemon-sysvinit", dnf: "git-daemon" },
        port: 9418,
    },
    {
        units: ["ssh.service", "sshd.service"],
        displayName: "SSH Server",
        description: _("Provides SSH access for git push/pull"),
        packages: { apt: "openssh-server", dnf: "openssh-server" },
        port: 22,
    },
];

type PkgManager = "apt" | "dnf" | null;

export const ServicesPage = () => {
    const [services, setServices] = useState<ServiceInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [actionInProgress, setActionInProgress] = useState<string | null>(null);
    const [pkgManager, setPkgManager] = useState<PkgManager>(null);

    // Uninstall confirmation modal
    const [uninstallTarget, setUninstallTarget] = useState<ServiceInfo | null>(null);
    const [uninstalling, setUninstalling] = useState(false);

    // Firewall open confirmation modal
    const [firewallTarget, setFirewallTarget] = useState<ServiceInfo | null>(null);
    const [openingFirewall, setOpeningFirewall] = useState(false);

    // Detect package manager once
    useEffect(() => {
        cockpit.spawn(["which", "apt-get"], { err: "ignore" })
                .then(() => setPkgManager("apt"))
                .catch(() => {
                    cockpit.spawn(["which", "dnf"], { err: "ignore" })
                            .then(() => setPkgManager("dnf"))
                            .catch(() => setPkgManager(null));
                });
    }, []);

    const loadServices = useCallback(() => {
        setLoading(true);
        setError("");

        // For each service, try each possible unit name to find the right one
        const findUnit = async (svc: ServiceDef): Promise<{ unit: string; installed: boolean }> => {
            // First check if the package is actually installed
            const pkg = pkgManager === "apt" ? svc.packages.apt : svc.packages.dnf;
            if (pkgManager === "apt") {
                try {
                    const fmt = "-f=$" + "{Status}";
                    const out = await cockpit.spawn(["dpkg-query", "-W", fmt, pkg], { err: "ignore" });
                    if (!out.includes("install ok installed")) {
                        return { unit: svc.units[0], installed: false };
                    }
                } catch {
                    return { unit: svc.units[0], installed: false };
                }
            } else if (pkgManager === "dnf") {
                try {
                    await cockpit.spawn(["rpm", "-q", pkg], { err: "ignore" });
                } catch {
                    return { unit: svc.units[0], installed: false };
                }
            }

            for (const unit of svc.units) {
                try {
                    await cockpit.spawn(["systemctl", "cat", unit], { err: "ignore" });
                    return { unit, installed: true };
                } catch {
                    // try next
                }
            }
            return { unit: svc.units[0], installed: false };
        };

        const promises = SERVICES.map(async svc => {
            const { unit, installed } = await findUnit(svc);

            if (!installed) {
                return {
                    ...svc,
                    unit,
                    installed: false,
                    activeState: "not-installed",
                    subState: "not-installed",
                    unitFileState: "not-installed",
                };
            }

            const props: Record<string, string> = {};
            try {
                const output: string = await cockpit.spawn(
                    ["systemctl", "show", unit, "--property=ActiveState,SubState,UnitFileState"],
                    { err: "ignore" }
                );
                output.trim().split("\n")
                        .forEach(line => {
                            const [key, ...rest] = line.split("=");
                            if (key) props[key] = rest.join("=");
                        });
            } catch { /* use defaults */ }

            // Check firewall status for this service's port
            let firewallBlocked = false;
            if (svc.port) {
                try {
                    const ufwOut: string = await cockpit.spawn(
                        ["ufw", "status"], { superuser: "try", err: "ignore" }
                    );
                    if (ufwOut.includes("Status: active")) {
                        // Check if this port is allowed
                        const portStr = `${svc.port}`;
                        const lines = ufwOut.split("\n");
                        const allowed = lines.some(l =>
                            (l.includes(portStr + "/tcp") || l.includes(portStr + " ")) &&
                            l.includes("ALLOW")
                        );
                        if (!allowed) firewallBlocked = true;
                    }
                } catch { /* ufw not available, skip */ }
            }

            return {
                ...svc,
                unit,
                installed: true,
                activeState: props.ActiveState || "unknown",
                subState: props.SubState || "unknown",
                unitFileState: props.UnitFileState || "unknown",
                firewallBlocked,
            };
        });

        Promise.all(promises).then(results => {
            setServices(results);
            setLoading(false);
        })
                .catch((ex: cockpit.BasicError) => {
                    setError(ex.message || String(ex));
                    setLoading(false);
                });
    }, [pkgManager]);

    useEffect(() => { loadServices() }, [loadServices]);

    const toggleService = (svc: ServiceInfo) => {
        setActionInProgress(svc.unit);
        const action = svc.activeState === "active" ? "stop" : "start";

        cockpit.spawn(["systemctl", action, svc.unit], { superuser: "require", err: "message" })
                .then(() => {
                    setTimeout(loadServices, 1000);
                    setActionInProgress(null);
                })
                .catch((ex: cockpit.BasicError) => {
                    setError(ex.message || String(ex));
                    setActionInProgress(null);
                });
    };

    const restartService = (svc: ServiceInfo) => {
        setActionInProgress(svc.unit);

        cockpit.spawn(["systemctl", "restart", svc.unit], { superuser: "require", err: "message" })
                .then(() => {
                    setTimeout(loadServices, 1000);
                    setActionInProgress(null);
                })
                .catch((ex: cockpit.BasicError) => {
                    setError(ex.message || String(ex));
                    setActionInProgress(null);
                });
    };

    const installPackage = (svc: ServiceInfo) => {
        if (!pkgManager) {
            setError(_("No supported package manager found (apt or dnf)."));
            return;
        }
        setActionInProgress(svc.unit);
        setError("");

        const pkg = pkgManager === "apt" ? svc.packages.apt : svc.packages.dnf;
        const cmd = pkgManager === "apt"
            ? ["apt-get", "install", "-y", pkg]
            : ["dnf", "install", "-y", pkg];

        cockpit.spawn(cmd, { superuser: "require", err: "message" })
                .then(() => {
                    // Post-install: configure git-daemon to use /srv/git
                    if (svc.unit === "git-daemon.service") {
                        return cockpit.spawn(["bash", "-c",
                            "sed -i 's/GIT_DAEMON_ENABLE=false/GIT_DAEMON_ENABLE=true/' /etc/default/git-daemon; " +
                            "sed -i 's|GIT_DAEMON_BASE_PATH=.*|GIT_DAEMON_BASE_PATH=/srv/git|' /etc/default/git-daemon; " +
                            "sed -i 's|GIT_DAEMON_DIRECTORY=.*|GIT_DAEMON_DIRECTORY=/srv/git|' /etc/default/git-daemon; " +
                            "sed -i 's/GIT_DAEMON_USER=.*/GIT_DAEMON_USER=git/' /etc/default/git-daemon; " +
                            "grep -q 'GIT_DAEMON_OPTIONS' /etc/default/git-daemon && " +
                            "sed -i 's|GIT_DAEMON_OPTIONS=.*|GIT_DAEMON_OPTIONS=\"--enable=receive-pack\"|' /etc/default/git-daemon || " +
                            "echo 'GIT_DAEMON_OPTIONS=\"--enable=receive-pack\"' >> /etc/default/git-daemon; " +
                            "systemctl restart git-daemon"
                        ], { superuser: "require", err: "ignore" });
                    }
                    return Promise.resolve("");
                })
                .then(() => {
                    setTimeout(loadServices, 2000);
                    setActionInProgress(null);
                })
                .catch((ex: cockpit.BasicError) => {
                    setError(ex.message || String(ex));
                    setActionInProgress(null);
                });
    };

    const uninstallPackage = (svc: ServiceInfo) => {
        if (!pkgManager) {
            setError(_("No supported package manager found (apt or dnf)."));
            return;
        }
        setUninstalling(true);
        setError("");

        const pkg = pkgManager === "apt" ? svc.packages.apt : svc.packages.dnf;
        const cmd = pkgManager === "apt"
            ? ["apt-get", "purge", "-y", pkg]
            : ["dnf", "remove", "-y", pkg];

        cockpit.spawn(cmd, { superuser: "require", err: "message" })
                .then(() => cockpit.spawn(["systemctl", "daemon-reload"], { superuser: "require", err: "ignore" }))
                .then(() => {
                    // Remove firewall rule if port was opened
                    if (svc.port) {
                        return cockpit.spawn(["ufw", "delete", "allow", `${svc.port}/tcp`], { superuser: "require", err: "ignore" })
                                .catch(() => ""); // ignore if ufw not installed
                    }
                    return Promise.resolve("");
                })
                .then(() => {
                    setUninstallTarget(null);
                    setUninstalling(false);
                    setTimeout(loadServices, 2000);
                })
                .catch((ex: cockpit.BasicError) => {
                    setError(ex.message || String(ex));
                    setUninstallTarget(null);
                    setUninstalling(false);
                });
    };

    const openFirewallPort = (svc: ServiceInfo) => {
        if (!svc.port) return;
        setOpeningFirewall(true);
        setError("");

        // Check if ufw is available first
        cockpit.spawn(["which", "ufw"], { err: "ignore" })
                .then(() => cockpit.spawn(["ufw", "allow", `${svc.port}/tcp`, "comment", svc.displayName], { superuser: "require", err: "message" }))
                .then(() => {
                    setFirewallTarget(null);
                    setOpeningFirewall(false);
                    setTimeout(loadServices, 1000);
                })
                .catch((ex: cockpit.BasicError) => {
                    setError(ex.message ? ex.message : _("Failed to open port. Is ufw installed?"));
                    setFirewallTarget(null);
                    setOpeningFirewall(false);
                });
    };

    const stateColor = (state: string): "green" | "red" | "grey" | "orange" => {
        switch (state) {
        case "active": return "green";
        case "failed": return "red";
        case "inactive": return "grey";
        case "not-installed": return "orange";
        default: return "grey";
        }
    };

    const stateLabel = (svc: ServiceInfo): string => {
        if (!svc.installed) return _("Not installed");
        return `${svc.activeState} (${svc.subState})`;
    };

    if (loading) return <Spinner aria-label={_("Loading services")} />;

    return (
        <>
            {error && <Alert variant="danger" title={error} isInline style={{ marginBottom: "1rem" }} />}

            {services.map(svc => (
                <Card key={svc.unit} isCompact style={{ marginBottom: "1rem" }}>
                    <CardTitle>
                        {svc.displayName}
                        <Label color={stateColor(svc.activeState)} style={{ marginLeft: "1rem" }}>
                            {stateLabel(svc)}
                        </Label>
                    </CardTitle>
                    <CardBody>
                        <p>{svc.description}</p>

                        <DescriptionList isHorizontal isCompact style={{ marginTop: "0.5rem" }}>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Unit")}</DescriptionListTerm>
                                <DescriptionListDescription>{svc.unit}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Installed")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <Label color={svc.installed ? "green" : "orange"}>
                                        {svc.installed ? _("Yes") : _("No")}
                                    </Label>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            {svc.installed && (
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Enabled")}</DescriptionListTerm>
                                    <DescriptionListDescription>{svc.unitFileState}</DescriptionListDescription>
                                </DescriptionListGroup>
                            )}
                        </DescriptionList>

                        {svc.installed && svc.firewallBlocked && (
                            <Alert
                                variant="warning"
                                isInline
                                title={cockpit.format(_("Port $0/tcp is blocked by the firewall. External clients cannot connect."), String(svc.port))}
                                style={{ marginTop: "0.75rem" }}
                                actionLinks={
                                    <Button variant="link" onClick={() => setFirewallTarget(svc)}>
                                        {_("Open port")}
                                    </Button>
                                }
                            />
                        )}

                        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                            {svc.installed
                                ? (
                                    <>
                                        <Switch
                                            id={`switch-${svc.unit}`}
                                            label={_("Running")}
                                            labelOff={_("Stopped")}
                                            isChecked={svc.activeState === "active"}
                                            onChange={() => toggleService(svc)}
                                            isDisabled={actionInProgress === svc.unit}
                                        />
                                        <Button
                                            variant="secondary"
                                            onClick={() => restartService(svc)}
                                            isDisabled={svc.activeState !== "active" || actionInProgress === svc.unit}
                                            isLoading={actionInProgress === svc.unit}
                                        >
                                            {_("Restart")}
                                        </Button>
                                        <Button
                                            variant="danger"
                                            onClick={() => setUninstallTarget(svc)}
                                            isDisabled={actionInProgress === svc.unit}
                                        >
                                            {_("Uninstall")}
                                        </Button>
                                    </>
                                )
                                : (
                                    <Button
                                        variant="primary"
                                        onClick={() => installPackage(svc)}
                                        isLoading={actionInProgress === svc.unit}
                                        isDisabled={actionInProgress === svc.unit || !pkgManager}
                                    >
                                        {_("Install")}
                                    </Button>
                                )}
                        </div>
                    </CardBody>
                </Card>
            ))}

            {uninstallTarget && (
                <Modal variant="small" isOpen onClose={() => setUninstallTarget(null)}>
                    <ModalHeader title={cockpit.format(_("Uninstall $0?"), uninstallTarget.displayName)} />
                    <ModalBody>
                        <Alert variant="warning" title={_("This will remove the package from the system.")} isInline />
                        <p style={{ marginTop: "0.5rem" }}>
                            {cockpit.format(
                                _("Package: $0"),
                                pkgManager === "apt" ? uninstallTarget.packages.apt : uninstallTarget.packages.dnf
                            )}
                        </p>
                        <p style={{ marginTop: "0.25rem" }}>
                            {_("The service will be stopped and removed. Are you sure?")}
                        </p>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={() => uninstallPackage(uninstallTarget)} isLoading={uninstalling} isDisabled={uninstalling}>
                            {_("Uninstall")}
                        </Button>
                        <Button variant="link" onClick={() => setUninstallTarget(null)}>
                            {_("Cancel")}
                        </Button>
                    </ModalFooter>
                </Modal>
            )}

            {firewallTarget && (
                <Modal variant="small" isOpen onClose={() => setFirewallTarget(null)}>
                    <ModalHeader title={cockpit.format(_("Open firewall port for $0?"), firewallTarget.displayName)} />
                    <ModalBody>
                        <p>
                            {cockpit.format(
                                _("This will allow incoming connections on port $0/tcp through the firewall (ufw)."),
                                String(firewallTarget.port)
                            )}
                        </p>
                        <p style={{ marginTop: "0.5rem" }}>
                            {_("This makes the service accessible from other machines on the network.")}
                        </p>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="primary" onClick={() => openFirewallPort(firewallTarget)} isLoading={openingFirewall} isDisabled={openingFirewall}>
                            {_("Open Port")}
                        </Button>
                        <Button variant="link" onClick={() => setFirewallTarget(null)}>
                            {_("Cancel")}
                        </Button>
                    </ModalFooter>
                </Modal>
            )}
        </>
    );
};
