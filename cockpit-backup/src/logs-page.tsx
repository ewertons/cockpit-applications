import React, { useCallback, useEffect, useState, useRef } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";
import { Select, SelectOption, SelectList } from "@patternfly/react-core/dist/esm/components/Select/index.js";
import { MenuToggle, MenuToggleElement } from "@patternfly/react-core/dist/esm/components/MenuToggle/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface LogEntry {
    timestamp: string;
    unit: string;
    message: string;
    priority: number; // 0-7, syslog priority
}

type LogFilter = "all" | "errors" | "scheduled" | "manual";

export const LogsPage = () => {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState("");
    const [typeFilter, setTypeFilter] = useState<LogFilter>("all");
    const [typeFilterOpen, setTypeFilterOpen] = useState(false);
    const [following, setFollowing] = useState(false);
    const followProc = useRef<any>(null);
    const logEndRef = useRef<HTMLDivElement>(null);
    const logContainerRef = useRef<HTMLDivElement>(null);

    const fetchLogs = useCallback(async () => {
        setLoading(true);
        try {
            // Fetch journal entries for all cockpit-backup related units
            const output = await cockpit.spawn(
                ["journalctl",
                    "--no-pager",
                    "--output=json",
                    "-n", "500",
                    "--unit=cockpit-backup-*",
                    "--unit=cockpit-backup-run-*",
                ],
                { superuser: "try", err: "ignore" }
            );

            const entries: LogEntry[] = [];
            for (const line of output.trim().split('\n')) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    entries.push({
                        timestamp: entry.__REALTIME_TIMESTAMP
                            ? new Date(parseInt(entry.__REALTIME_TIMESTAMP) / 1000).toLocaleString()
                            : entry._SOURCE_REALTIME_TIMESTAMP
                                ? new Date(parseInt(entry._SOURCE_REALTIME_TIMESTAMP) / 1000).toLocaleString()
                                : "",
                        unit: entry._SYSTEMD_UNIT || entry.SYSLOG_IDENTIFIER || "unknown",
                        message: entry.MESSAGE || "",
                        priority: parseInt(entry.PRIORITY || "6"),
                    });
                } catch { /* skip non-JSON lines */ }
            }
            setLogs(entries);
        } catch (e: any) {
            // If no entries found, journalctl may exit with error
            setLogs([]);
        }
        setLoading(false);
    }, []);

    useEffect(() => { fetchLogs() }, [fetchLogs]);

    const startFollow = useCallback(() => {
        if (followProc.current) return;
        setFollowing(true);
        localStorage.setItem("cockpit-backup-follow", "true");

        // Scroll to bottom immediately
        setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

        const proc = cockpit.spawn(
            ["journalctl",
                "--no-pager",
                "--output=json",
                "-f",
                "-n", "0",
                "--unit=cockpit-backup-*",
                "--unit=cockpit-backup-run-*",
            ],
            { superuser: "try", err: "ignore" }
        );

        proc.stream((data: string) => {
            const newEntries: LogEntry[] = [];
            for (const line of data.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    newEntries.push({
                        timestamp: entry.__REALTIME_TIMESTAMP
                            ? new Date(parseInt(entry.__REALTIME_TIMESTAMP) / 1000).toLocaleString()
                            : "",
                        unit: entry._SYSTEMD_UNIT || entry.SYSLOG_IDENTIFIER || "unknown",
                        message: entry.MESSAGE || "",
                        priority: parseInt(entry.PRIORITY || "6"),
                    });
                } catch { /* skip */ }
            }
            if (newEntries.length > 0) {
                setLogs(prev => [...prev, ...newEntries]);
                setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
            }
        });

        followProc.current = proc;
    }, []);

    const stopFollow = useCallback(() => {
        if (followProc.current) {
            try { followProc.current.close() } catch { /* */ }
            followProc.current = null;
        }
        setFollowing(false);
        localStorage.setItem("cockpit-backup-follow", "false");
    }, []);

    useEffect(() => {
        // On unmount, close the process but DON'T reset localStorage
        return () => {
            if (followProc.current) {
                try { followProc.current.close() } catch { /* */ }
                followProc.current = null;
            }
        };
    }, []);

    // Auto-start follow after initial load if preference was saved
    const autoFollowStarted = useRef(false);
    useEffect(() => {
        if (!loading && !autoFollowStarted.current) {
            autoFollowStarted.current = true;
            if (localStorage.getItem("cockpit-backup-follow") === "true") {
                setTimeout(() => {
                    logEndRef.current?.scrollIntoView();
                    startFollow();
                }, 150);
            }
        }
    }, [loading, startFollow]);

    const priorityLabel = (priority: number) => {
        if (priority <= 3) return <Label color="red">{_("Error")}</Label>;
        if (priority === 4) return <Label color="orange">{_("Warning")}</Label>;
        return null;
    };

    const unitLabel = (unit: string) => {
        if (unit.includes("cockpit-backup-run-")) {
            return <Label color="blue" isCompact>{_("Manual")}</Label>;
        }
        if (unit.includes("cockpit-backup-")) {
            return <Label color="cyan" isCompact>{_("Scheduled")}</Label>;
        }
        return <Label isCompact>{unit}</Label>;
    };

    const filtered = logs.filter(entry => {
        if (typeFilter === "errors" && entry.priority > 3) return false;
        if (typeFilter === "scheduled" && !entry.unit.match(/^cockpit-backup-[^r]/)) return false;
        if (typeFilter === "manual" && !entry.unit.includes("cockpit-backup-run-")) return false;
        if (filter) {
            const f = filter.toLowerCase();
            return entry.message.toLowerCase().includes(f) ||
                entry.unit.toLowerCase().includes(f);
        }
        return true;
    });

    if (loading) return <Spinner aria-label={_("Loading logs")} />;

    return (
        <>
            <div className="page-header">
                <div className="page-header-actions">
                    <SearchInput
                        placeholder={_("Filter logs…")}
                        value={filter}
                        onChange={(_e, val) => setFilter(val)}
                        onClear={() => setFilter("")}
                        style={{ maxWidth: "250px" }}
                    />
                    <Select
                        isOpen={typeFilterOpen}
                        selected={typeFilter}
                        onSelect={(_e, val) => { setTypeFilter(val as LogFilter); setTypeFilterOpen(false) }}
                        onOpenChange={setTypeFilterOpen}
                        toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                            <MenuToggle ref={toggleRef} onClick={() => setTypeFilterOpen(!typeFilterOpen)} isExpanded={typeFilterOpen} style={{ minWidth: "10rem" }}>
                                {typeFilter === "all" ? _("All entries") :
                                    typeFilter === "errors" ? _("Errors only") :
                                        typeFilter === "scheduled" ? _("Scheduled runs") :
                                            _("Manual runs")}
                            </MenuToggle>
                        )}
                    >
                        <SelectList>
                            <SelectOption value="all">{_("All entries")}</SelectOption>
                            <SelectOption value="errors">{_("Errors only")}</SelectOption>
                            <SelectOption value="scheduled">{_("Scheduled runs")}</SelectOption>
                            <SelectOption value="manual">{_("Manual runs")}</SelectOption>
                        </SelectList>
                    </Select>
                    {!following
                        ? <Button variant="secondary" onClick={startFollow}>{_("Follow")}</Button>
                        : <Button variant="warning" onClick={stopFollow}>{_("Stop following")}</Button>}
                    <Button variant="secondary" onClick={fetchLogs}>{_("Refresh")}</Button>
                </div>
            </div>

            {filtered.length === 0
                ? (
                    <EmptyState>
                        <EmptyStateBody>
                            {logs.length === 0
                                ? _("No backup activity logged yet. Logs will appear here after backups run.")
                                : _("No log entries match the current filter.")}
                        </EmptyStateBody>
                    </EmptyState>
                )
                : (
                    <Card isFlat>
                        <CardBody style={{ padding: 0, maxHeight: "70vh", overflowY: "auto" }}>
                            <div className="log-entries">
                                {filtered.map((entry, i) => (
                                    <div key={i} className={`log-entry${entry.priority <= 3 ? " log-error" : entry.priority === 4 ? " log-warning" : ""}`}>
                                        <span className="log-timestamp">{entry.timestamp}</span>
                                        {unitLabel(entry.unit)}
                                        {priorityLabel(entry.priority)}
                                        <span className="log-message">{entry.message}</span>
                                    </div>
                                ))}
                                <div ref={logEndRef} />
                            </div>
                        </CardBody>
                    </Card>
                )}
        </>
    );
};
