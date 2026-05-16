import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Grid, GridItem } from "@patternfly/react-core/dist/esm/layouts/Grid/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface UserInfo {
    name: string;
    uid: number;
    gid: number;
    home: string;
    shell: string;
    groups: string[];
    lastLogin: string;
    passwordAge: string;
    locked: boolean;
}

export const UserSecurityPage = () => {
    const [users, setUsers] = useState<UserInfo[]>([]);
    const [sudoers, setSudoers] = useState<string[]>([]);
    const [recentLogins, setRecentLogins] = useState<string[]>([]);
    const [failedLogins, setFailedLogins] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const loadData = async () => {
        setLoading(true);
        await Promise.all([loadUsers(), loadSudoers(), loadRecentLogins(), loadFailedLogins()]);
        setLoading(false);
    };

    const loadUsers = async () => {
        try {
            const passwd = await cockpit.file("/etc/passwd").read();
            const allUsers = passwd.trim().split("\n")
                    .map(line => {
                        const parts = line.split(":");
                        return {
                            name: parts[0],
                            uid: parseInt(parts[2]),
                            gid: parseInt(parts[3]),
                            home: parts[5],
                            shell: parts[6],
                            groups: [],
                            lastLogin: "",
                            passwordAge: "",
                            locked: false,
                        };
                    });
            // Filter to human users (uid >= 1000) and root
            const humanUsers = allUsers.filter(u => u.uid >= 1000 || u.uid === 0);

            // Get groups for each user
            for (const user of humanUsers) {
                try {
                    const groups = await cockpit.spawn(["groups", user.name], { err: "ignore" });
                    user.groups = groups.split(":")[1]?.trim().split(/\s+/) || [];
                } catch { /* skip */ }
            }

            // Check locked status
            try {
                const shadow = await cockpit.file("/etc/shadow", { superuser: "try" }).read();
                if (shadow) {
                    for (const user of humanUsers) {
                        const line = shadow.split("\n").find(l => l.startsWith(user.name + ":"));
                        if (line) {
                            const hashField = line.split(":")[1];
                            user.locked = hashField.startsWith("!") || hashField.startsWith("*");
                            // Password age
                            const lastChange = parseInt(line.split(":")[2]);
                            if (lastChange > 0) {
                                const days = Math.floor(Date.now() / 86400000) - lastChange;
                                user.passwordAge = `${days} days`;
                            }
                        }
                    }
                }
            } catch { /* no access to shadow */ }

            setUsers(humanUsers);
        } catch (e) {
            setError(String(e));
        }
    };

    const loadSudoers = async () => {
        try {
            // Check who is in sudo/wheel group
            const groupFile = await cockpit.file("/etc/group").read();
            const sudoLine = groupFile.split("\n").find(l => l.startsWith("sudo:") || l.startsWith("wheel:"));
            if (sudoLine) {
                const members = sudoLine.split(":")[3]?.split(",").filter(Boolean) || [];
                setSudoers(members);
            }
        } catch { /* ignore */ }
    };

    const loadRecentLogins = async () => {
        try {
            const output = await cockpit.spawn(["last", "-n", "20", "-a"], { err: "ignore" });
            setRecentLogins(output.trim().split("\n")
                    .filter(l => l && !l.startsWith("wtmp")));
        } catch { /* ignore */ }
    };

    const loadFailedLogins = async () => {
        try {
            const output = await cockpit.spawn(["lastb", "-n", "20", "-a"], { err: "ignore", superuser: "try" });
            setFailedLogins(output.trim().split("\n")
                    .filter(l => l && !l.startsWith("btmp")));
        } catch { /* ignore */ }
    };

    if (loading) return <Spinner />;

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("Users & Authentication Security")}</Title>

            {error && <Alert variant="danger" title={error} className="pf-v6-u-mb-md" />}

            <Grid hasGutter>
                <GridItem span={12}>
                    <Card className="pf-v6-u-mb-md">
                        <CardTitle>{_("User Accounts")}</CardTitle>
                        <CardBody>
                            <table className="pf-v6-c-table pf-m-compact">
                                <thead>
                                    <tr>
                                        <th>{_("User")}</th>
                                        <th>{_("UID")}</th>
                                        <th>{_("Shell")}</th>
                                        <th>{_("Groups")}</th>
                                        <th>{_("Password Age")}</th>
                                        <th>{_("Status")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {users.map(u => (
                                        <tr key={u.name}>
                                            <td>
                                                <strong>{u.name}</strong>
                                                {sudoers.includes(u.name) && <span className="security-status-warning"> (sudo)</span>}
                                            </td>
                                            <td>{u.uid}</td>
                                            <td>{u.shell}</td>
                                            <td>{u.groups.join(", ")}</td>
                                            <td>{u.passwordAge || _("unknown")}</td>
                                            <td>
                                                {u.locked
                                                    ? <span className="security-status-warning">{_("Locked")}</span>
                                                    : <span className="security-status-good">{_("Active")}</span>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </CardBody>
                    </Card>
                </GridItem>

                <GridItem span={6}>
                    <Card className="pf-v6-u-mb-md">
                        <CardTitle>{_("Recent Logins")}</CardTitle>
                        <CardBody>
                            <div className="log-viewer">
                                {recentLogins.length > 0 ? recentLogins.join("\n") : _("No recent logins found.")}
                            </div>
                        </CardBody>
                    </Card>
                </GridItem>

                <GridItem span={6}>
                    <Card className="pf-v6-u-mb-md">
                        <CardTitle>{_("Failed Login Attempts")}</CardTitle>
                        <CardBody>
                            <div className="log-viewer">
                                {failedLogins.length > 0
                                    ? failedLogins.join("\n")
                                    : <span className="security-status-good">{_("No failed logins recorded.")}</span>}
                            </div>
                        </CardBody>
                    </Card>
                </GridItem>
            </Grid>
        </>
    );
};
