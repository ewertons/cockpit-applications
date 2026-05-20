import React, { useCallback, useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { EmptyState, EmptyStateBody, EmptyStateFooter, EmptyStateActions } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";
import CheckCircleIcon from "@patternfly/react-icons/dist/esm/icons/check-circle-icon";

import cockpit from 'cockpit';
import {
    ResticSnapshot, loadDestinations, loadJobs, BackupJob, Destination, destEnvVars,
    listSnapshots, deleteSnapshot, restoreSnapshot
} from './restic.js';
import { SnapshotFileBrowser } from './snapshot-file-browser.js';

const _ = cockpit.gettext;

interface SnapshotsPageProps {
    snapshotId?: string;
}

export const SnapshotsPage = ({ snapshotId: _snapshotId }: SnapshotsPageProps) => {
    const [snapshots, setSnapshots] = useState<ResticSnapshot[]>([]);
    const [destinations, setDestinations] = useState<Destination[]>([]);
    const [jobs, setJobs] = useState<BackupJob[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState("");

    // Restore dialog
    const [restoreTarget, setRestoreTarget] = useState<ResticSnapshot | null>(null);

    // Delete confirmation
    const [deleteTarget, setDeleteTarget] = useState<ResticSnapshot | null>(null);
    const [deleting, setDeleting] = useState(false);

    // Map snapshot ID to destination name
    const [snapshotDestMap, setSnapshotDestMap] = useState<Record<string, string>>({});

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [d, j] = await Promise.all([loadDestinations(), loadJobs()]);
            setDestinations(d);
            setJobs(j);

            const allSnapshots: ResticSnapshot[] = [];
            const destMap: Record<string, string> = {};
            for (const dest of d) {
                if (dest.initialized) {
                    try {
                        const snaps = await listSnapshots(dest.path, dest.password_file, destEnvVars(dest));
                        for (const snap of snaps) {
                            destMap[snap.id] = dest.name;
                        }
                        allSnapshots.push(...snaps);
                    } catch (e: any) {
                        console.warn(`Failed to list snapshots for ${dest.name}:`, e.message);
                    }
                }
            }
            allSnapshots.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
            setSnapshots(allSnapshots);
            setSnapshotDestMap(destMap);
        } catch (e: any) {
            setError(e.message || String(e));
        }
        setLoading(false);
    }, []);

    useEffect(() => { refresh() }, [refresh]);

    const handleDelete = async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        for (const dest of destinations) {
            try {
                await deleteSnapshot(deleteTarget.id, dest.path, dest.password_file, destEnvVars(dest));
                break;
            } catch { /* try next */ }
        }
        setDeleteTarget(null);
        setDeleting(false);
        refresh();
    };

    const formatTime = (time: string) => {
        const d = new Date(time);
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        let relative = "";
        if (diffHours < 1) relative = _("just now");
        else if (diffHours < 24) relative = cockpit.format(_("$0 hours ago"), String(diffHours));
        else if (diffDays < 7) relative = cockpit.format(_("$0 days ago"), String(diffDays));
        else relative = d.toLocaleDateString();

        return { full: d.toLocaleString(), relative };
    };

    if (loading) return <Spinner aria-label={_("Loading snapshots")} />;

    if (error) {
        return <Alert variant="danger" title={_("Error loading snapshots")} isInline>{error}</Alert>;
    }

    const filtered = snapshots.filter(s => {
        if (!filter) return true;
        const f = filter.toLowerCase();
        return s.short_id.toLowerCase().includes(f) ||
            s.paths.some(p => p.toLowerCase().includes(f)) ||
            s.hostname.toLowerCase().includes(f) ||
            (s.tags && s.tags.some(t => t.toLowerCase().includes(f)));
    });

    // Group snapshots by job name
    const RETENTION_LABELS = ["daily", "weekly", "monthly", "long"];

    const normPath = (p: string) => p.replace(/\/+$/, '');

    const matchSnapshotToJob = (snap: ResticSnapshot): string | null => {
        // First try: explicit job:<name> tag
        const jobTag = snap.tags?.find(t => t.startsWith("job:"));
        if (jobTag) return jobTag.slice(4);
        // Second: match by paths + repository
        const snapNorm = snap.paths.map(normPath);
        for (const job of jobs) {
            const jobNorm = new Set(job.sources.map(normPath));
            const pathMatch = snapNorm.length > 0 && snapNorm.every(p => jobNorm.has(p));
            const destName = snapshotDestMap[snap.id];
            const dest = destinations.find(d => d.name === destName);
            const repoMatch = dest && job.repository === dest.path;
            if (pathMatch && repoMatch) return job.name;
        }
        return null;
    };

    const groups: Record<string, ResticSnapshot[]> = {};
    for (const snap of filtered) {
        const jobName = matchSnapshotToJob(snap) || _("Other");
        if (!groups[jobName]) groups[jobName] = [];
        groups[jobName].push(snap);
    }

    const getRetentionLabel = (snap: ResticSnapshot): string | null => {
        if (!snap.tags) return null;
        for (const tag of snap.tags) {
            const lower = tag.toLowerCase();
            if (RETENTION_LABELS.includes(lower)) return tag;
        }
        return null;
    };

    const retentionColor = (label: string): "blue" | "green" | "orange" | "purple" => {
        switch (label.toLowerCase()) {
            case "daily": return "blue";
            case "weekly": return "green";
            case "monthly": return "orange";
            case "long": return "purple";
            default: return "blue";
        }
    };

    return (
        <>
            {snapshots.length === 0
                ? (
                    <EmptyState>
                        <EmptyStateBody>
                            {_("No snapshots found. Run a backup job to create your first snapshot.")}
                        </EmptyStateBody>
                        <EmptyStateFooter>
                            <EmptyStateActions>
                                <Button variant="primary" onClick={() => cockpit.location.go(["jobs"])}>
                                    {_("Go to Backup Jobs")}
                                </Button>
                            </EmptyStateActions>
                        </EmptyStateFooter>
                    </EmptyState>
                )
                : (
                    <>
                        <div className="page-header">
                            <div className="page-header-actions">
                                <SearchInput
                                    placeholder={_("Filter by ID, path, host, tag…")}
                                    value={filter}
                                    onChange={(_e, val) => setFilter(val)}
                                    onClear={() => setFilter("")}
                                    style={{ maxWidth: "300px" }}
                                />
                                <Button variant="secondary" onClick={refresh}>
                                    {_("Refresh")}
                                </Button>
                            </div>
                        </div>
                        <div className="snapshot-groups">
                            {Object.entries(groups).map(([jobName, snaps]) => (
                                <Card key={jobName} isFlat>
                                    <CardHeader>
                                        <CardTitle>
                                            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                                <CheckCircleIcon color="var(--pf-t--global--color--status--success--default)" />
                                                {jobName}
                                            </span>
                                        </CardTitle>
                                    </CardHeader>
                                    <CardBody style={{ padding: "0 1rem 1rem" }}>
                                        <table className="snapshot-table">
                                            <tbody>
                                                {snaps.map(snap => {
                                                    const time = formatTime(snap.time);
                                                    const retention = getRetentionLabel(snap);
                                                    return (
                                                        <tr key={snap.id}>
                                                            <td className="snap-id">
                                                                <Label color="blue" isCompact style={{ fontFamily: "var(--pf-t--global--font--family--mono)" }}>
                                                                    {snap.short_id}
                                                                </Label>
                                                            </td>
                                                            <td className="snap-time">{time.full}</td>
                                                            <td className="snap-relative">({time.relative})</td>
                                                            <td className="snap-retention">
                                                                {retention && <Label color={retentionColor(retention)} isCompact>{retention}</Label>}
                                                            </td>
                                                            <td className="snap-actions">
                                                                <Button variant="secondary" onClick={() => setRestoreTarget(snap)}>
                                                                    {_("Restore")}
                                                                </Button>
                                                                <Button variant="danger" onClick={() => setDeleteTarget(snap)}>
                                                                    {_("Delete")}
                                                                </Button>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </CardBody>
                                </Card>
                            ))}
                        </div>
                    </>
                )}

            {restoreTarget && (
                <RestoreDialog
                    snapshot={restoreTarget}
                    destinations={destinations}
                    onClose={() => setRestoreTarget(null)}
                    onDone={() => { setRestoreTarget(null); refresh() }}
                />
            )}

            {deleteTarget && (
                <Modal variant="small" isOpen onClose={() => setDeleteTarget(null)}>
                    <ModalHeader title={_("Delete Snapshot")} />
                    <ModalBody>
                        <Alert variant="warning" title={_("This action cannot be undone.")} isInline />
                        <p style={{ marginTop: "0.5rem" }}>
                            {cockpit.format(
                                _("Delete snapshot $0 from $1?"),
                                deleteTarget.short_id,
                                new Date(deleteTarget.time).toLocaleString()
                            )}
                        </p>
                        <p style={{ marginTop: "0.25rem", fontSize: "var(--pf-t--global--font--size--sm)", color: "var(--pf-t--global--text--color--subtle)" }}>
                            {_("The backup data for this point-in-time will be permanently removed after pruning.")}
                        </p>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={handleDelete} isLoading={deleting} isDisabled={deleting}>
                            {_("Delete")}
                        </Button>
                        <Button variant="link" onClick={() => setDeleteTarget(null)}>
                            {_("Cancel")}
                        </Button>
                    </ModalFooter>
                </Modal>
            )}
        </>
    );
};

// --- Restore dialog ---

interface RestoreDialogProps {
    snapshot: ResticSnapshot;
    destinations: Destination[];
    onClose: () => void;
    onDone: () => void;
}

function RestoreDialog({ snapshot, destinations, onClose, onDone }: RestoreDialogProps) {
    const [target, setTarget] = useState('/');
    const [include, setInclude] = useState('');
    const [exclude, setExclude] = useState('');
    const [restoring, setRestoring] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const [showBrowser, setShowBrowser] = useState(false);

    const handleRestore = async () => {
        setRestoring(true);
        setError(null);

        try {
            for (const dest of destinations) {
                try {
                    await restoreSnapshot(
                        snapshot.id,
                        target,
                        dest.path,
                        dest.password_file,
                        {
                            include: include ? include.split('\n').filter(Boolean) : undefined,
                            exclude: exclude ? exclude.split('\n').filter(Boolean) : undefined,
                        },
                        destEnvVars(dest),
                    );
                    setSuccess(true);
                    setTimeout(onDone, 2000);
                    return;
                } catch { /* try next destination */ }
            }
            setError(_("Could not find snapshot in any configured repository."));
        } catch (e: any) {
            setError(e.message || String(e));
        }
        setRestoring(false);
    };

    return (
        <Modal variant="medium" isOpen onClose={onClose}>
            <ModalHeader title={cockpit.format(_("Restore Snapshot $0"), snapshot.short_id)} />
            <ModalBody>
                {error && <Alert variant="danger" title={_("Restore failed")} isInline style={{ marginBottom: "1rem" }}>{error}</Alert>}
                {success && <Alert variant="success" title={_("Restore completed successfully!")} isInline style={{ marginBottom: "1rem" }} />}

                <DescriptionList isHorizontal isCompact style={{ marginBottom: "1rem" }}>
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Snapshot")}</DescriptionListTerm>
                        <DescriptionListDescription>{snapshot.short_id} — {new Date(snapshot.time).toLocaleString()}</DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Original paths")}</DescriptionListTerm>
                        <DescriptionListDescription>{snapshot.paths.join(', ')}</DescriptionListDescription>
                    </DescriptionListGroup>
                </DescriptionList>

                <FormGroup
label={_("Restore Target Directory")} fieldId="restore-target"
                    helperText={_("Where to restore files. Use '/' to restore to original locations.")}
                >
                    <TextInput id="restore-target" value={target} onChange={(_ev, val) => setTarget(val)} />
                </FormGroup>

                <FormGroup
label={_("Include Paths (optional)")} fieldId="restore-include"
                    helperText={_("Only restore these paths, one per line. Leave empty to restore everything.")}
                >
                    <TextArea
id="restore-include" value={include} onChange={(_ev, val) => setInclude(val)} rows={3}
                        placeholder={"/home/user/documents\n/etc/nginx"}
                    />
                </FormGroup>

                <Button variant="secondary" onClick={() => setShowBrowser(true)} style={{ marginTop: "0.5rem", marginBottom: "1rem" }}>
                    {_("Browse…")}
                </Button>

                {showBrowser && (
                    <SnapshotFileBrowser
                        snapshot={snapshot}
                        destinations={destinations}
                        onSelect={(paths) => {
                            const current = include ? include.split('\n').filter(Boolean) : [];
                            const merged = [...new Set([...current, ...paths])];
                            setInclude(merged.join('\n'));
                            setShowBrowser(false);
                        }}
                        onClose={() => setShowBrowser(false)}
                    />
                )}

                <FormGroup
label={_("Exclude Paths (optional)")} fieldId="restore-exclude"
                    helperText={_("Skip these paths during restore, one per line")}
                >
                    <TextArea id="restore-exclude" value={exclude} onChange={(_ev, val) => setExclude(val)} rows={3} />
                </FormGroup>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={handleRestore} isLoading={restoring} isDisabled={restoring || success || !target.trim()}>
                    {_("Restore")}
                </Button>
                <Button variant="link" onClick={onClose}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
