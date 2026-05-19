import React, { useCallback, useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { EmptyState, EmptyStateBody, EmptyStateFooter, EmptyStateActions } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Progress } from "@patternfly/react-core/dist/esm/components/Progress/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
// import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";

import cockpit from 'cockpit';
import { loadJobs, loadDestinations, BackupJob, Destination, getTimerStatus, repoStats, ResticRepoStats, destEnvVars, BACKUP_UNIT_PREFIX } from './restic.js';
import { useBackups } from './backup-context.jsx';

const _ = cockpit.gettext;

interface JobStatus {
    job: BackupJob;
    timerActive: boolean;
    nextRun?: string;
    lastRun?: string;
    running: boolean;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export const StatusPage = () => {
    const [jobStatuses, setJobStatuses] = useState<JobStatus[]>([]);
    const [repoStatsMap, setRepoStatsMap] = useState<Record<string, ResticRepoStats>>({});
    const [destinations, setDestinations] = useState<Destination[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const { runningBackups } = useBackups();

    const initialLoadDone = React.useRef(false);

    const refresh = useCallback(async () => {
        if (!initialLoadDone.current) {
            setLoading(true);
        }
        setError(null);
        try {
            const [jobs, dests] = await Promise.all([loadJobs(), loadDestinations()]);
            setDestinations(dests);

            const statuses: JobStatus[] = [];
            for (const job of jobs) {
                const timer = await getTimerStatus(job);
                let running = false;
                try {
                    // Check both scheduled service and manual run unit
                    const output = await cockpit.spawn(
                        ["systemctl", "is-active",
                            `cockpit-backup-${job.id}.service`,
                            `${BACKUP_UNIT_PREFIX}-${job.id}.service`],
                        { superuser: "try", err: "ignore" }
                    );
                    running = output.trim().split('\n')
                            .some((l: string) => l.trim() === "active" || l.trim() === "activating");
                } catch { /* not running */ }

                statuses.push({
                    job,
                    timerActive: timer.active,
                    nextRun: timer.next_run,
                    lastRun: timer.last_run,
                    running,
                });
            }
            setJobStatuses(statuses);

            const stats: Record<string, ResticRepoStats> = {};
            for (const dest of dests) {
                if (dest.initialized) {
                    try {
                        stats[dest.id] = await repoStats(dest.path, dest.password_file, destEnvVars(dest));
                    } catch { /* skip */ }
                }
            }
            setRepoStatsMap(stats);
        } catch (e: any) {
            setError(e.message || String(e));
        }
        setLoading(false);
        initialLoadDone.current = true;
    }, []);

    useEffect(() => { refresh() }, [refresh]);

    // Auto-refresh every 10 seconds
    useEffect(() => {
        const interval = setInterval(refresh, 10000);
        return () => clearInterval(interval);
    }, [refresh]);

    if (loading) return <Spinner aria-label={_("Loading dashboard")} />;

    const hasData = jobStatuses.length > 0 || destinations.length > 0;
    const activeBackups = Object.values(runningBackups);
    const runningJobs = jobStatuses.filter(s => s.running);
    const totalSize = Object.values(repoStatsMap).reduce((sum, s) => sum + (s.total_size || 0), 0);
    const totalFiles = Object.values(repoStatsMap).reduce((sum, s) => sum + (s.total_file_count || 0), 0);

    if (!hasData) {
        return (
            <EmptyState>
                <EmptyStateBody>
                    {_("Welcome to Cockpit Backup! Get started by adding a destination and creating a backup job.")}
                </EmptyStateBody>
                <EmptyStateFooter>
                    <EmptyStateActions>
                        <Button variant="primary" onClick={() => cockpit.location.go(["destinations"])}>
                            {_("Add Destination")}
                        </Button>
                        <Button variant="secondary" onClick={() => cockpit.location.go(["jobs"])}>
                            {_("Create Backup Job")}
                        </Button>
                    </EmptyStateActions>
                </EmptyStateFooter>
            </EmptyState>
        );
    }

    return (
        <>
            <div className="page-header">
                <div className="page-header-actions">
                    <Button variant="secondary" onClick={refresh}>
                        {_("Refresh")}
                    </Button>
                </div>
            </div>

            {error && <Alert variant="danger" title={_("Error")} isInline style={{ marginBottom: "1rem" }}>{error}</Alert>}

            {/* Summary stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
                <Card isCompact isFlat>
                    <CardBody className="stat-card">
                        <div className="stat-value">{jobStatuses.length}</div>
                        <div className="stat-label">{_("Backup Jobs")}</div>
                    </CardBody>
                </Card>
                <Card isCompact isFlat>
                    <CardBody className="stat-card">
                        <div className="stat-value">{destinations.length}</div>
                        <div className="stat-label">{_("Destinations")}</div>
                    </CardBody>
                </Card>
                {activeBackups.length > 0 && (
                    <Card isCompact isFlat>
                        <CardBody className="stat-card">
                            <div className="stat-value" style={{ color: "var(--pf-t--global--color--status--info--default)" }}>{activeBackups.length}</div>
                            <div className="stat-label">{_("Backups Running")}</div>
                        </CardBody>
                    </Card>
                )}
                <Card isCompact isFlat>
                    <CardBody className="stat-card">
                        <div className="stat-value">{totalSize > 0 ? formatBytes(totalSize) : "—"}</div>
                        <div className="stat-label">{_("Total Backup Size")}</div>
                    </CardBody>
                </Card>
                <Card isCompact isFlat>
                    <CardBody className="stat-card">
                        <div className="stat-value">{totalFiles > 0 ? totalFiles.toLocaleString() : "—"}</div>
                        <div className="stat-label">{_("Files Protected")}</div>
                    </CardBody>
                </Card>
            </div>

            {/* Running backups */}
            {(activeBackups.length > 0 || runningJobs.length > 0) && (
                <Card isCompact className="status-section">
                    <CardTitle>
                        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            {_("Running Backups")}
                            <Label color="blue">{activeBackups.length || runningJobs.length}</Label>
                        </span>
                    </CardTitle>
                    <CardBody>
                        {activeBackups.map(backup => (
                            <div key={backup.jobId} style={{ marginBottom: "0.75rem" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.25rem" }}>
                                    <strong>{backup.jobName}</strong>
                                    <Label color="blue">{_("In Progress")}</Label>
                                </div>
                                <Progress value={backup.progress} title={backup.status} />
                            </div>
                        ))}
                        {runningJobs.filter(s => !runningBackups[s.job.id]).map(status => (
                            <div key={status.job.id} style={{ marginBottom: "0.75rem" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.25rem" }}>
                                    <strong>{status.job.name}</strong>
                                    <Label color="blue">{_("In Progress")}</Label>
                                </div>
                                <Progress value={undefined} title={status.job.sources.join(', ')} />
                            </div>
                        ))}
                    </CardBody>
                </Card>
            )}

            {/* Scheduled jobs */}
            <Card isCompact className="status-section">
                <CardTitle>{_("Scheduled Jobs")}</CardTitle>
                <CardBody>
                    {jobStatuses.length === 0
                        ? (
                            <p style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
                                {_("No backup jobs configured.")}
                                {" "}
                                <Button variant="link" isInline onClick={() => cockpit.location.go(["jobs"])}>{_("Create one")}</Button>
                            </p>
                        )
                        : jobStatuses.map(status => (
                            <div key={status.job.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.5rem 0", borderBottom: "1px solid var(--pf-t--global--border--color--default)" }}>
                                <div>
                                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                                        <Button variant="link" isInline onClick={() => cockpit.location.go(["jobs"])} style={{ fontWeight: "bold" }}>
                                            {status.job.name}
                                        </Button>
                                        {status.job.enabled
                                            ? <Label color="green">{_("Active")}</Label>
                                            : <Label color="grey">{_("Disabled")}</Label>}
                                        {status.running && <Label color="blue">{_("Running")}</Label>}
                                    </div>
                                    <div style={{ fontSize: "var(--pf-t--global--font--size--sm)", color: "var(--pf-t--global--text--color--subtle)", marginTop: "0.125rem" }}>
                                        {status.job.schedule
                                            ? (
                                                <>
                                                    <span className="schedule-badge">{status.job.schedule}</span>
                                                    {status.nextRun && <span style={{ marginLeft: "0.75rem" }}>{_("Next")}: {status.nextRun}</span>}
                                                    {status.lastRun && status.lastRun !== "n/a" && <span style={{ marginLeft: "0.75rem" }}>{_("Last")}: {status.lastRun}</span>}
                                                </>
                                            )
                                            : _("Manual only")}
                                    </div>
                                </div>
                                <div style={{ fontSize: "var(--pf-t--global--font--size--sm)", color: "var(--pf-t--global--text--color--subtle)" }}>
                                    {status.job.sources.join(', ')}
                                </div>
                            </div>
                        ))}
                </CardBody>
            </Card>

            {/* Repository health */}
            {destinations.length > 0 && (
                <Card isCompact className="status-section">
                    <CardTitle>{_("Repository Health")}</CardTitle>
                    <CardBody>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "0.75rem" }}>
                            {destinations.map(dest => {
                                const stats = repoStatsMap[dest.id];
                                return (
                                    <Card key={dest.id} isFlat isCompact isPlain>
                                        <CardBody style={{ padding: "0.5rem 0.75rem" }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
                                                <strong>{dest.name}</strong>
                                                <Label color={dest.initialized ? "green" : "orange"}>
                                                    {dest.initialized ? _("OK") : _("Not init")}
                                                </Label>
                                            </div>
                                            <div style={{ fontSize: "var(--pf-t--global--font--size--sm)", color: "var(--pf-t--global--text--color--subtle)" }}>
                                                {stats
                                                    ? cockpit.format(_("$0 · $1 files"), formatBytes(stats.total_size || 0), (stats.total_file_count || 0).toLocaleString())
                                                    : _("Stats unavailable")}
                                            </div>
                                        </CardBody>
                                    </Card>
                                );
                            })}
                        </div>
                    </CardBody>
                </Card>
            )}
        </>
    );
};
