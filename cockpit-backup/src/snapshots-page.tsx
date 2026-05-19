import React, { useCallback, useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody } from "@patternfly/react-core/dist/esm/components/Card/index.js";
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
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip/index.js";
import { Icon } from "@patternfly/react-core/dist/esm/components/Icon/index.js";
import InfoCircleIcon from "@patternfly/react-icons/dist/esm/icons/info-circle-icon";

import cockpit from 'cockpit';
import {
    ResticSnapshot, loadDestinations, Destination, destEnvVars,
    listSnapshots, deleteSnapshot, restoreSnapshot
} from './restic.js';

const _ = cockpit.gettext;

interface SnapshotsPageProps {
    snapshotId?: string;
}

export const SnapshotsPage = ({ snapshotId: _snapshotId }: SnapshotsPageProps) => {
    const [snapshots, setSnapshots] = useState<ResticSnapshot[]>([]);
    const [destinations, setDestinations] = useState<Destination[]>([]);
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
            const d = await loadDestinations();
            setDestinations(d);

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
                        <div className="snapshot-cards">
                            {filtered.map(snap => {
                                const time = formatTime(snap.time);
                                const destName = snapshotDestMap[snap.id] || _("Unknown");
                                const durationTag = snap.tags?.find(t => t.startsWith("duration:"));
                                const duration = durationTag ? durationTag.replace("duration:", "") : null;
                                const displayTags = snap.tags?.filter(t => !t.startsWith("duration:"));
                                return (
                                    <Card key={snap.id} isCompact isFlat style={{ padding: "0.5rem" }}>
                                        <CardBody style={{ padding: "0.5rem" }}>
                                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                <div style={{ display: "flex", gap: "0.75rem", flex: 1, alignItems: "flex-start" }}>
                                                    <Label color="blue" style={{ fontFamily: "var(--pf-t--global--font--family--mono)", flexShrink: 0, marginTop: "0.1rem" }}>
                                                        {snap.short_id}
                                                    </Label>
                                                    <div>
                                                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.25rem" }}>
                                                            <span title={time.full} className="snapshot-time">
                                                                {time.full}
                                                            </span>
                                                            <span className="snapshot-time">({time.relative})</span>
                                                            {displayTags && displayTags.map(tag => (
                                                                <Label key={tag} color="purple">{tag}</Label>
                                                            ))}
                                                        </div>
                                                        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "var(--pf-t--global--font--size--sm)", color: "var(--pf-t--global--text--color--subtle)", fontFamily: "var(--pf-t--global--font--family--mono)" }}>
                                                            <span>{snap.hostname}:{snap.paths.join(', ')}</span>
                                                            <span style={{ fontFamily: "var(--pf-t--global--font--family--body)" }}>→</span>
                                                            <span style={{ fontFamily: "var(--pf-t--global--font--family--body)", fontWeight: 500 }}>{destName}</span>
                                                            {duration && <span style={{ fontFamily: "var(--pf-t--global--font--family--body)" }}>({duration})</span>}
                                                            <Tooltip content={_("Format: host:path → destination (h:mm)")}>
                                                                <Icon size="sm" style={{ color: "var(--pf-t--global--icon--color--subtle)", cursor: "pointer" }}>
                                                                    <InfoCircleIcon />
                                                                </Icon>
                                                            </Tooltip>
                                                        </div>
                                                    </div>
                                                </div>

                                                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                                    <Button variant="primary" size="sm" onClick={() => setRestoreTarget(snap)}>
                                                        {_("Restore")}
                                                    </Button>
                                                    <Button variant="danger" size="sm" onClick={() => setDeleteTarget(snap)}>
                                                        {_("Delete")}
                                                    </Button>
                                                </div>
                                            </div>
                                        </CardBody>
                                    </Card>
                                );
                            })}
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
