import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface ListeningPort {
    protocol: string;
    address: string;
    port: string;
    process: string;
    pid: string;
    state: string;
}

export const OpenPortsPage = () => {
    const [ports, setPorts] = useState<ListeningPort[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadPorts();
    }, []);

    const loadPorts = async () => {
        setLoading(true);
        try {
            const output = await cockpit.spawn(["ss", "-tlnup"], { err: "ignore", superuser: "try" });
            const lines = output.trim().split("\n")
                    .slice(1); // skip header
            const parsed: ListeningPort[] = lines.map(line => {
                const parts = line.split(/\s+/);
                const proto = parts[0] || "";
                const local = parts[3] || "";
                const localParts = local.split(":");
                const port = localParts[localParts.length - 1] || "";
                const addr = localParts.slice(0, -1).join(":") || "*";

                // Extract process info
                const processMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
                const process = processMatch ? processMatch[1] : "";
                const pid = processMatch ? processMatch[2] : "";

                return {
                    protocol: proto,
                    address: addr,
                    port,
                    process,
                    pid,
                    state: parts[1] || "",
                };
            }).filter(p => p.port);

            // Sort by port number
            parsed.sort((a, b) => parseInt(a.port) - parseInt(b.port));
            setPorts(parsed);
        } catch {
            setPorts([]);
        }
        setLoading(false);
    };

    if (loading) return <Spinner />;

    // Classify ports
    const wellKnown: Record<string, string> = {
        22: "SSH",
        80: "HTTP",
        443: "HTTPS",
        25: "SMTP",
        53: "DNS",
        3306: "MySQL",
        5432: "PostgreSQL",
        6379: "Redis",
        8080: "HTTP-Alt",
        9090: "Cockpit",
        21: "FTP",
        110: "POP3",
        143: "IMAP",
        993: "IMAPS",
        995: "POP3S",
        587: "SMTP-Sub",
        3389: "RDP",
    };

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("Open Ports & Listening Services")}</Title>

            <div className="pf-v6-u-mb-md">
                <Button variant="secondary" onClick={loadPorts}>{_("Refresh")}</Button>
            </div>

            <Card>
                <CardTitle>{_("Listening Ports")} ({ports.length})</CardTitle>
                <CardBody>
                    <table className="pf-v6-c-table pf-m-compact">
                        <thead>
                            <tr>
                                <th>{_("Port")}</th>
                                <th>{_("Protocol")}</th>
                                <th>{_("Address")}</th>
                                <th>{_("Service")}</th>
                                <th>{_("Process")}</th>
                                <th>{_("PID")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {ports.map((p, i) => (
                                <tr key={i}>
                                    <td><strong>{p.port}</strong></td>
                                    <td>{p.protocol}</td>
                                    <td>{p.address}</td>
                                    <td>{wellKnown[p.port] || ""}</td>
                                    <td>{p.process || _("(unknown)")}</td>
                                    <td>{p.pid}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </CardBody>
            </Card>
        </>
    );
};
