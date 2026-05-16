import React, { useEffect, useState, useRef } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Grid, GridItem } from "@patternfly/react-core/dist/esm/layouts/Grid/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface Connection {
    protocol: string;
    localAddr: string;
    localPort: string;
    remoteAddr: string;
    remotePort: string;
    state: string;
    process: string;
}

interface TrafficStats {
    interface: string;
    rxBytes: number;
    txBytes: number;
    rxPackets: number;
    txPackets: number;
}

export const NetworkMonitorPage = () => {
    const [connections, setConnections] = useState<Connection[]>([]);
    const [traffic, setTraffic] = useState<TrafficStats[]>([]);
    const [loading, setLoading] = useState(true);
    const [autoRefresh, setAutoRefresh] = useState(true);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        loadData();
        if (autoRefresh) {
            intervalRef.current = setInterval(loadData, 5000);
        }
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRefresh]);

    const loadData = async () => {
        await Promise.all([loadConnections(), loadTraffic()]);
        setLoading(false);
    };

    const loadConnections = async () => {
        try {
            const ss = await cockpit.spawn(["ss", "-tunap"], { err: "ignore", superuser: "try" });
            const lines = ss.trim().split("\n")
                    .slice(1); // skip header
            const conns: Connection[] = lines.map(line => {
                const parts = line.split(/\s+/);
                const local = parts[3] || "";
                const remote = parts[4] || "";
                const localParts = local.split(":");
                const remoteParts = remote.split(":");
                return {
                    protocol: parts[0] || "",
                    localAddr: localParts.slice(0, -1).join(":") || "",
                    localPort: localParts[localParts.length - 1] || "",
                    remoteAddr: remoteParts.slice(0, -1).join(":") || "",
                    remotePort: remoteParts[remoteParts.length - 1] || "",
                    state: parts[1] || "",
                    process: parts[5] || parts[6] || "",
                };
            }).filter(c => c.protocol);
            setConnections(conns);
        } catch {
            setConnections([]);
        }
    };

    const loadTraffic = async () => {
        try {
            const netDev = await cockpit.file("/proc/net/dev").read();
            const lines = netDev.trim().split("\n")
                    .slice(2); // skip headers
            const stats: TrafficStats[] = lines.map(line => {
                const parts = line.trim().split(/[\s:]+/);
                return {
                    interface: parts[0],
                    rxBytes: parseInt(parts[1]) || 0,
                    txBytes: parseInt(parts[9]) || 0,
                    rxPackets: parseInt(parts[2]) || 0,
                    txPackets: parseInt(parts[10]) || 0,
                };
            }).filter(s => s.interface !== "lo");
            setTraffic(stats);
        } catch {
            setTraffic([]);
        }
    };

    const formatBytes = (bytes: number): string => {
        if (bytes === 0) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    };

    if (loading) return <Spinner />;

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("Network Monitor")}</Title>

            <div className="pf-v6-u-mb-md">
                <Button
                    variant={autoRefresh ? "primary" : "secondary"}
                    onClick={() => setAutoRefresh(!autoRefresh)}
                >
                    {autoRefresh ? _("Auto-refresh: ON (5s)") : _("Auto-refresh: OFF")}
                </Button>
                {" "}
                <Button variant="secondary" onClick={loadData}>{_("Refresh Now")}</Button>
            </div>

            <Grid hasGutter>
                <GridItem span={12}>
                    <Card className="pf-v6-u-mb-md">
                        <CardTitle>{_("Interface Traffic")}</CardTitle>
                        <CardBody>
                            <table className="pf-v6-c-table pf-m-compact">
                                <thead>
                                    <tr>
                                        <th>{_("Interface")}</th>
                                        <th>{_("RX Bytes")}</th>
                                        <th>{_("TX Bytes")}</th>
                                        <th>{_("RX Packets")}</th>
                                        <th>{_("TX Packets")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {traffic.map(t => (
                                        <tr key={t.interface}>
                                            <td><strong>{t.interface}</strong></td>
                                            <td>{formatBytes(t.rxBytes)}</td>
                                            <td>{formatBytes(t.txBytes)}</td>
                                            <td>{t.rxPackets.toLocaleString()}</td>
                                            <td>{t.txPackets.toLocaleString()}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </CardBody>
                    </Card>
                </GridItem>

                <GridItem span={12}>
                    <Card>
                        <CardTitle>{_("Active Connections")} ({connections.length})</CardTitle>
                        <CardBody>
                            <div style={{ maxHeight: "500px", overflowY: "auto" }}>
                                <table className="pf-v6-c-table pf-m-compact connection-table">
                                    <thead>
                                        <tr>
                                            <th>{_("Proto")}</th>
                                            <th>{_("Local Address")}</th>
                                            <th>{_("Port")}</th>
                                            <th>{_("Remote Address")}</th>
                                            <th>{_("Port")}</th>
                                            <th>{_("State")}</th>
                                            <th>{_("Process")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {connections.map((c, i) => (
                                            <tr key={i}>
                                                <td>{c.protocol}</td>
                                                <td>{c.localAddr}</td>
                                                <td>{c.localPort}</td>
                                                <td>{c.remoteAddr}</td>
                                                <td>{c.remotePort}</td>
                                                <td>{c.state}</td>
                                                <td>{c.process}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </CardBody>
                    </Card>
                </GridItem>
            </Grid>
        </>
    );
};
