import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { DescriptionList, DescriptionListGroup, DescriptionListTerm, DescriptionListDescription } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

type MACBackend = "selinux" | "apparmor" | "none";

interface SELinuxStatus {
    mode: string;
    policy: string;
    booleans: { name: string; active: boolean }[];
}

interface AppArmorProfile {
    name: string;
    mode: string;
}

export const SELinuxPage = () => {
    const [backend, setBackend] = useState<MACBackend>("none");
    const [selinux, setSELinux] = useState<SELinuxStatus | null>(null);
    const [apparmor, setAppArmor] = useState<AppArmorProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    useEffect(() => {
        detectBackend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const detectBackend = async () => {
        setLoading(true);
        try {
            const getenforce = await cockpit.spawn(["getenforce"], { err: "ignore" });
            if (getenforce.trim()) {
                setBackend("selinux");
                await loadSELinux();
                setLoading(false);
                return;
            }
        } catch { /* not selinux */ }

        try {
            await cockpit.spawn(["aa-status"], { err: "ignore", superuser: "try" });
            setBackend("apparmor");
            await loadAppArmor();
        } catch {
            setBackend("none");
        }
        setLoading(false);
    };

    const loadSELinux = async () => {
        try {
            const mode = await cockpit.spawn(["getenforce"], { err: "ignore" });
            const sestatus = await cockpit.spawn(["sestatus"], { err: "ignore" });
            const policyMatch = sestatus.match(/Loaded policy name:\s*(\S+)/);

            // Get some common booleans
            const boolOut = await cockpit.spawn(["getsebool", "-a"], { err: "ignore" });
            const booleans = boolOut.trim().split("\n")
                    .slice(0, 50)
                    .map(line => {
                        const parts = line.split("-->");
                        return {
                            name: parts[0]?.trim() || "",
                            active: parts[1]?.trim() === "on",
                        };
                    })
                    .filter(b => b.name);

            setSELinux({
                mode: mode.trim(),
                policy: policyMatch ? policyMatch[1] : "unknown",
                booleans,
            });
        } catch (e) {
            setError(String(e));
        }
    };

    const loadAppArmor = async () => {
        try {
            const status = await cockpit.spawn(["aa-status"], { err: "ignore", superuser: "try" });
            const profiles: AppArmorProfile[] = [];
            let currentMode = "";
            for (const line of status.split("\n")) {
                if (line.includes("profiles are in enforce mode")) currentMode = "enforce";
                else if (line.includes("profiles are in complain mode")) currentMode = "complain";
                else if (line.includes("processes are unconfined")) currentMode = "";
                else if (line.trim().startsWith("/") || line.trim().match(/^\S+\s+\(/)) {
                    const name = line.trim().replace(/\s*\(.*\)/, "");
                    if (name && currentMode) {
                        profiles.push({ name, mode: currentMode });
                    }
                }
            }
            setAppArmor(profiles);
        } catch (e) {
            setError(String(e));
        }
    };

    const setSELinuxMode = async (enforcing: boolean) => {
        setError("");
        setSuccess("");
        try {
            await cockpit.spawn(["setenforce", enforcing ? "1" : "0"], { superuser: "require" });
            setSuccess(enforcing ? _("SELinux set to Enforcing") : _("SELinux set to Permissive"));
            await loadSELinux();
        } catch (e) {
            setError(String(e));
        }
    };

    const toggleSEBool = async (name: string, enable: boolean) => {
        setError("");
        try {
            await cockpit.spawn(["setsebool", "-P", name, enable ? "on" : "off"], { superuser: "require" });
            await loadSELinux();
        } catch (e) {
            setError(String(e));
        }
    };

    if (loading) return <Spinner />;

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("Mandatory Access Control")}</Title>

            {error && <Alert variant="danger" title={error} className="pf-v6-u-mb-md" />}
            {success && <Alert variant="success" title={success} className="pf-v6-u-mb-md" />}

            {backend === "none" && (
                <Alert variant="info" title={_("No MAC system detected. Consider installing SELinux or AppArmor.")} />
            )}

            {backend === "selinux" && selinux && (
                <>
                    <Card className="pf-v6-u-mb-md">
                        <CardTitle>{_("SELinux Status")}</CardTitle>
                        <CardBody>
                            <DescriptionList isHorizontal>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Mode")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        <span className={selinux.mode === "Enforcing" ? "security-status-good" : "security-status-warning"}>
                                            {selinux.mode}
                                        </span>
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Policy")}</DescriptionListTerm>
                                    <DescriptionListDescription>{selinux.policy}</DescriptionListDescription>
                                </DescriptionListGroup>
                            </DescriptionList>
                            <div className="pf-v6-u-mt-md">
                                <Button
                                    variant="primary"
                                    onClick={() => setSELinuxMode(selinux.mode !== "Enforcing")}
                                >
                                    {selinux.mode === "Enforcing" ? _("Set Permissive") : _("Set Enforcing")}
                                </Button>
                            </div>
                        </CardBody>
                    </Card>

                    <Card>
                        <CardTitle>{_("SELinux Booleans")}</CardTitle>
                        <CardBody>
                            <div style={{ maxHeight: "400px", overflowY: "auto" }}>
                                <table className="pf-v6-c-table pf-m-compact">
                                    <thead>
                                        <tr>
                                            <th>{_("Boolean")}</th>
                                            <th>{_("Status")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {selinux.booleans.map(b => (
                                            <tr key={b.name}>
                                                <td>{b.name}</td>
                                                <td>
                                                    <Switch
                                                        id={`sebool-${b.name}`}
                                                        isChecked={b.active}
                                                        onChange={() => toggleSEBool(b.name, !b.active)}
                                                        label={_("on")}
                                                        labelOff={_("off")}
                                                    />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </CardBody>
                    </Card>
                </>
            )}

            {backend === "apparmor" && (
                <Card>
                    <CardTitle>{_("AppArmor Profiles")}</CardTitle>
                    <CardBody>
                        <div style={{ maxHeight: "500px", overflowY: "auto" }}>
                            <table className="pf-v6-c-table pf-m-compact">
                                <thead>
                                    <tr>
                                        <th>{_("Profile")}</th>
                                        <th>{_("Mode")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {apparmor.map((p, i) => (
                                        <tr key={i}>
                                            <td>{p.name}</td>
                                            <td>
                                                <span className={p.mode === "enforce" ? "security-status-good" : "security-status-warning"}>
                                                    {p.mode}
                                                </span>
                                            </td>
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
