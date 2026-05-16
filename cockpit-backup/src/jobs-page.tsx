import React, { useCallback, useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { EmptyState, EmptyStateBody, EmptyStateFooter, EmptyStateActions } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip/index.js";
import { Progress, ProgressSize } from "@patternfly/react-core/dist/esm/components/Progress/index.js";

import cockpit from 'cockpit';
import {
    BackupJob, loadJobs, saveJobs, loadDestinations, Destination,
    enableJobSchedule, disableJobSchedule, getTimerStatus
} from './restic.js';
import { useBackups } from './backup-context.jsx';

const _ = cockpit.gettext;

interface JobsPageProps {
    jobId?: string;
}

export const JobsPage = ({ jobId }: JobsPageProps) => {
    const [jobs, setJobs] = useState<BackupJob[]>([]);
    const [destinations, setDestinations] = useState<Destination[]>([]);
    const [loading, setLoading] = useState(true);
    const [showDialog, setShowDialog] = useState(false);
    const [editJob, setEditJob] = useState<BackupJob | null>(null);
    const [filter, setFilter] = useState("");
    const [timerStatuses, setTimerStatuses] = useState<Record<string, { active: boolean; next_run?: string }>>({});

    // Delete confirmation
    const [deleteTarget, setDeleteTarget] = useState<BackupJob | null>(null);
    const [deleting, setDeleting] = useState(false);

    // Shared backup state
    const { runningBackups, results, startBackup, clearResult } = useBackups();

    const refresh = useCallback(async () => {
        setLoading(true);
        const [j, d] = await Promise.all([loadJobs(), loadDestinations()]);
        setJobs(j);
        setDestinations(d);

        const statuses: Record<string, { active: boolean; next_run?: string }> = {};
        for (const job of j) {
            if (job.schedule) {
                statuses[job.id] = await getTimerStatus(job);
            }
        }
        setTimerStatuses(statuses);
        setLoading(false);
    }, []);

    useEffect(() => { refresh() }, [refresh]);

    const handleCreate = () => {
        setEditJob(null);
        setShowDialog(true);
    };

    const handleEdit = (job: BackupJob) => {
        setEditJob(job);
        setShowDialog(true);
    };

    const handleDelete = async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        await disableJobSchedule(deleteTarget);
        const updated = jobs.filter(j => j.id !== deleteTarget.id);
        await saveJobs(updated);
        setDeleteTarget(null);
        setDeleting(false);
        refresh();
    };

    const handleRunNow = async (job: BackupJob) => {
        const dest = destinations.find(d => d.path === job.repository);
        startBackup(job, dest);
    };

    const handleSave = async (job: BackupJob) => {
        let updated;
        if (editJob) {
            updated = jobs.map(j => j.id === job.id ? job : j);
        } else {
            updated = [...jobs, job];
        }
        await saveJobs(updated);

        if (job.enabled && job.schedule) {
            await enableJobSchedule(job);
        } else {
            await disableJobSchedule(job);
        }

        setShowDialog(false);
        refresh();
    };

    if (loading) return <Spinner aria-label={_("Loading backup jobs")} />;

    const filtered = jobs.filter(j => !filter || j.name.toLowerCase().includes(filter.toLowerCase()));

    return (
        <>
            {jobs.length === 0
                ? (
                    <EmptyState>
                        <EmptyStateBody>
                            {_("No backup jobs configured yet. Create a job to start protecting your data.")}
                        </EmptyStateBody>
                        <EmptyStateFooter>
                            <EmptyStateActions>
                                <Button variant="primary" onClick={handleCreate}>
                                    {_("Create Job")}
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
                                    placeholder={_("Filter jobs…")}
                                    value={filter}
                                    onChange={(_e, val) => setFilter(val)}
                                    onClear={() => setFilter("")}
                                    style={{ maxWidth: "250px" }}
                                />
                                <Button variant="primary" onClick={handleCreate}>
                                    {_("Create Job")}
                                </Button>
                            </div>
                        </div>
                        <div className="job-cards">
                        {filtered.map(job => (
                            <Card key={job.id} isCompact isFlat style={{ padding: "0.5rem" }}>
                                <CardBody style={{ padding: "0.5rem" }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                                        <div style={{ flex: 1 }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
                                                <Button variant="link" isInline onClick={() => handleEdit(job)} style={{ fontWeight: "bold", fontSize: "1.05rem" }}>
                                                    {job.name}
                                                </Button>
                                                {job.enabled
                                                    ? <Label color="green">{_("Enabled")}</Label>
                                                    : <Label color="grey">{_("Disabled")}</Label>}
                                                {timerStatuses[job.id]?.active && <Label color="blue">{_("Scheduled")}</Label>}
                                            </div>

                                            <DescriptionList isHorizontal isCompact>
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>{_("Sources")}</DescriptionListTerm>
                                                    <DescriptionListDescription>
                                                        <span style={{ fontFamily: "var(--pf-t--global--font--family--mono)", fontSize: "var(--pf-t--global--font--size--sm)" }}>
                                                            {job.sources.join(', ')}
                                                        </span>
                                                    </DescriptionListDescription>
                                                </DescriptionListGroup>
                                                <DescriptionListGroup>
                                                    <DescriptionListTerm>{_("Destination")}</DescriptionListTerm>
                                                    <DescriptionListDescription>
                                                        <span style={{ fontFamily: "var(--pf-t--global--font--family--mono)", fontSize: "var(--pf-t--global--font--size--sm)" }}>
                                                            {job.repository}
                                                        </span>
                                                    </DescriptionListDescription>
                                                </DescriptionListGroup>
                                                {job.schedule && (
                                                    <DescriptionListGroup>
                                                        <DescriptionListTerm>{_("Schedule")}</DescriptionListTerm>
                                                        <DescriptionListDescription>
                                                            <span className="schedule-badge">{job.schedule}</span>
                                                            {timerStatuses[job.id]?.next_run &&
                                                                <span className="snapshot-time" style={{ marginLeft: "0.5rem" }}>
                                                                    {_("Next")}: {timerStatuses[job.id].next_run}
                                                                </span>}
                                                        </DescriptionListDescription>
                                                    </DescriptionListGroup>
                                                )}
                                                {job.excludes.length > 0 && (
                                                    <DescriptionListGroup>
                                                        <DescriptionListTerm>{_("Excludes")}</DescriptionListTerm>
                                                        <DescriptionListDescription>
                                                            {job.excludes.length} {_("rules")}
                                                        </DescriptionListDescription>
                                                    </DescriptionListGroup>
                                                )}
                                                {job.retention && Object.values(job.retention).some(Boolean) && (
                                                    <DescriptionListGroup>
                                                        <DescriptionListTerm>{_("Retention")}</DescriptionListTerm>
                                                        <DescriptionListDescription>
                                                            {Object.entries(job.retention)
                                                                .filter(([_, v]) => v)
                                                                .map(([k, v]) => `${k.replace('keep_', '')}: ${v}`)
                                                                .join(', ')}
                                                        </DescriptionListDescription>
                                                    </DescriptionListGroup>
                                                )}
                                            </DescriptionList>
                                        </div>

                                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                            <Button variant="secondary" size="sm" onClick={() => handleRunNow(job)}
                                                isDisabled={!!runningBackups[job.id]} isLoading={!!runningBackups[job.id]}>
                                                {runningBackups[job.id] ? _("Running...") : _("Run Now")}
                                            </Button>
                                            <Button variant="secondary" size="sm" onClick={() => handleEdit(job)}>
                                                {_("Edit")}
                                            </Button>
                                            <Button variant="danger" size="sm" onClick={() => setDeleteTarget(job)}>
                                                {_("Delete")}
                                            </Button>
                                        </div>
                                    </div>
                                    {runningBackups[job.id] && (
                                        <Progress
                                            value={runningBackups[job.id].progress}
                                            title={runningBackups[job.id].status}
                                            size={ProgressSize.sm}
                                            style={{ marginTop: "0.5rem" }}
                                        />
                                    )}
                                    {results[job.id] && (
                                        <Alert variant={results[job.id].success ? "success" : "danger"}
                                            isInline isPlain
                                            title={results[job.id].message}
                                            style={{ marginTop: "0.5rem" }}
                                            actionClose={<Button variant="plain" onClick={() => clearResult(job.id)}>✕</Button>} />
                                    )}
                                </CardBody>
                            </Card>
                        ))}
                        </div>
                    </>
                )}

            {showDialog && (
                <JobDialog
                    destinations={destinations}
                    job={editJob}
                    onSave={handleSave}
                    onClose={() => setShowDialog(false)}
                />
            )}

            {deleteTarget && (
                <Modal variant="small" isOpen onClose={() => setDeleteTarget(null)}>
                    <ModalHeader title={_("Delete Backup Job")} />
                    <ModalBody>
                        <Alert variant="warning" title={_("This action cannot be undone.")} isInline />
                        <p style={{ marginTop: "0.5rem" }}>
                            {cockpit.format(_("Are you sure you want to delete the backup job \"$0\"? Its scheduled timer will also be removed."), deleteTarget.name)}
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

// --- Job creation/edit dialog ---

interface JobDialogProps {
    job: BackupJob | null;
    destinations: Destination[];
    onSave: (job: BackupJob) => void;
    onClose: () => void;
}

function JobDialog({ job, destinations, onSave, onClose }: JobDialogProps) {
    const isEdit = !!job;

    const [name, setName] = useState(job?.name || '');
    const [sources, setSources] = useState(job?.sources.join('\n') || '');
    const [repository, setRepository] = useState(job?.repository || (destinations[0]?.path || ''));
    const [excludes, setExcludes] = useState(job?.excludes.join('\n') || '');
    const [excludePatterns, setExcludePatterns] = useState(job?.exclude_patterns.join('\n') || '');
    const [excludeIfPresent, setExcludeIfPresent] = useState(job?.exclude_if_present.join('\n') || '');
    const [excludeLargerThan, setExcludeLargerThan] = useState(job?.exclude_larger_than || '');
    const [excludeCaches, setExcludeCaches] = useState(job?.exclude_caches || false);
    const [tags, setTags] = useState(job?.tags.join(', ') || '');
    const [schedule, setSchedule] = useState(job?.schedule || '');
    const [schedulePreset, setSchedulePreset] = useState(() => {
        const presets = ['hourly', 'daily', '*-*-* 02:00:00', 'weekly', 'Mon *-*-* 03:00:00', 'monthly'];
        const s = job?.schedule || '';
        return presets.includes(s) ? s : (s ? 'custom' : '');
    });
    const [enabled, setEnabled] = useState(job?.enabled ?? true);
    const [oneFileSystem, setOneFileSystem] = useState(job?.one_file_system || false);
    const [keepLast, setKeepLast] = useState(String(job?.retention?.keep_last || ''));
    const [keepDaily, setKeepDaily] = useState(String(job?.retention?.keep_daily || ''));
    const [keepWeekly, setKeepWeekly] = useState(String(job?.retention?.keep_weekly || ''));
    const [keepMonthly, setKeepMonthly] = useState(String(job?.retention?.keep_monthly || ''));
    const [keepYearly, setKeepYearly] = useState(String(job?.retention?.keep_yearly || ''));

    const handleSubmit = () => {
        const dest = destinations.find(d => d.path === repository);
        const newJob: BackupJob = {
            id: job?.id || crypto.randomUUID(),
            name,
            sources: sources.split('\n').map(s => s.trim()).filter(Boolean),
            repository,
            password_file: job?.password_file || dest?.password_file || '',
            excludes: excludes.split('\n').map(s => s.trim()).filter(Boolean),
            exclude_patterns: excludePatterns.split('\n').map(s => s.trim()).filter(Boolean),
            exclude_if_present: excludeIfPresent.split('\n').map(s => s.trim()).filter(Boolean),
            exclude_larger_than: excludeLargerThan || undefined,
            exclude_caches: excludeCaches,
            tags: tags.split(',').map(s => s.trim()).filter(Boolean),
            schedule: schedule || undefined,
            retention: {
                keep_last: keepLast ? parseInt(keepLast) : undefined,
                keep_daily: keepDaily ? parseInt(keepDaily) : undefined,
                keep_weekly: keepWeekly ? parseInt(keepWeekly) : undefined,
                keep_monthly: keepMonthly ? parseInt(keepMonthly) : undefined,
                keep_yearly: keepYearly ? parseInt(keepYearly) : undefined,
            },
            enabled,
            one_file_system: oneFileSystem,
        };
        onSave(newJob);
    };

    return (
        <Modal variant="large" isOpen onClose={onClose}>
            <ModalHeader title={isEdit ? _("Edit Backup Job") : _("Create Backup Job")} />
            <ModalBody>
                <div className="job-form">
                    <FormGroup label={_("Job Name")} isRequired fieldId="job-name">
                        <TextInput id="job-name" value={name} onChange={(_ev, val) => setName(val)}
                            placeholder={_("Daily system backup")} />
                    </FormGroup>

                    <FormGroup label={_("Source Directories")} fieldId="job-sources"
                        helperText={_("One path per line. These directories will be backed up.")}>
                        <TextArea id="job-sources" value={sources} onChange={(_ev, val) => setSources(val)} rows={4}
                            placeholder={"/home\n/etc\n/var/lib"} />
                    </FormGroup>

                    <FormGroup label={_("Destination Repository")} fieldId="job-repo"
                        helperText={_("Select a configured destination or enter a restic repository path")}>
                        <TextInput id="job-repo" value={repository} onChange={(_ev, val) => setRepository(val)}
                            placeholder="/backup/repo or sftp:user@host:/path or s3:bucket/path" />
                        {destinations.length > 0 && (
                            <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                                {destinations.map(d => (
                                    <Button key={d.id} variant="tertiary" size="sm" onClick={() => setRepository(d.path)}
                                        isActive={repository === d.path}>
                                        {d.name}
                                    </Button>
                                ))}
                            </div>
                        )}
                    </FormGroup>

                    <FormGroup label={_("Schedule")} fieldId="job-schedule"
                        helperText={_("How often backups run automatically. Leave empty for manual-only.")}>  
                        <FormSelect id="job-schedule-preset" value={schedulePreset}
                            onChange={(_ev, val) => {
                                setSchedulePreset(val);
                                if (val !== 'custom') setSchedule(val);
                                else setSchedule('');
                            }}>
                            <FormSelectOption value="" label={_("None (manual only)")} />
                            <FormSelectOption value="hourly" label={_("Every hour")} />
                            <FormSelectOption value="daily" label={_("Every day at midnight")} />
                            <FormSelectOption value="*-*-* 02:00:00" label={_("Every day at 2:00 AM")} />
                            <FormSelectOption value="weekly" label={_("Every week (Monday midnight)")} />
                            <FormSelectOption value="Mon *-*-* 03:00:00" label={_("Every Monday at 3:00 AM")} />
                            <FormSelectOption value="monthly" label={_("Every month (1st at midnight)")} />
                            <FormSelectOption value="custom" label={_("Custom (systemd OnCalendar)…")} />
                        </FormSelect>
                        {schedulePreset === 'custom' && (
                            <TextInput id="job-schedule" value={schedule} onChange={(_ev, val) => setSchedule(val)}
                                placeholder="*-*-* 04:30:00"
                                style={{ marginTop: "0.5rem" }} />
                        )}
                    </FormGroup>

                    <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
                        <Switch id="job-enabled" label={_("Enabled")} isChecked={enabled}
                            onChange={(_ev, val) => setEnabled(val)} />
                        <Switch id="job-caches" label={_("Exclude caches")} isChecked={excludeCaches}
                            onChange={(_ev, val) => setExcludeCaches(val)} />
                        <Tooltip content={_("Don't cross filesystem boundaries. If backing up /, won't descend into /mnt, /media, or other mounted drives.")}>
                            <Switch id="job-onefs" label={_("Stay on one filesystem")} isChecked={oneFileSystem}
                                onChange={(_ev, val) => setOneFileSystem(val)} />
                        </Tooltip>
                    </div>

                    <FormGroup label={_("Exclude Paths")} fieldId="job-excludes"
                        helperText={_("One path per line")}>
                        <TextArea id="job-excludes" value={excludes} onChange={(_ev, val) => setExcludes(val)} rows={3}
                            placeholder={"/tmp\n/var/cache\n/proc"} />
                    </FormGroup>

                    <FormGroup label={_("Exclude Patterns")} fieldId="job-patterns"
                        helperText={_("Glob patterns, one per line")}>
                        <TextArea id="job-patterns" value={excludePatterns} onChange={(_ev, val) => setExcludePatterns(val)} rows={2}
                            placeholder={"*.tmp\n*.log\n.cache/**"} />
                    </FormGroup>

                    <FormGroup label={_("Exclude if File Present")} fieldId="job-ifpresent"
                        helperText={_("Skip directories containing these marker files")}>
                        <TextInput id="job-ifpresent" value={excludeIfPresent} onChange={(_ev, val) => setExcludeIfPresent(val)}
                            placeholder=".nobackup" />
                    </FormGroup>

                    <FormGroup label={_("Exclude Files Larger Than")} fieldId="job-maxsize"
                        helperText={_("e.g. 100M, 1G, 500K")}>
                        <TextInput id="job-maxsize" value={excludeLargerThan} onChange={(_ev, val) => setExcludeLargerThan(val)}
                            placeholder="100M" style={{ maxWidth: "150px" }} />
                    </FormGroup>

                    <FormGroup label={_("Tags")} fieldId="job-tags"
                        helperText={_("Comma-separated tags to identify these snapshots")}>
                        <TextInput id="job-tags" value={tags} onChange={(_ev, val) => setTags(val)}
                            placeholder="system, daily" />
                    </FormGroup>

                    <Card isFlat isCompact>
                        <CardTitle>{_("Retention Policy")}</CardTitle>
                        <CardBody>
                            <p style={{ marginBottom: "0.75rem", color: "var(--pf-t--global--text--color--subtle)", fontSize: "var(--pf-t--global--font--size--sm)" }}>
                                {_("Automatically remove old snapshots. Leave empty to keep all.")}
                            </p>
                            <div className="retention-grid">
                                <FormGroup label={_("Last")} fieldId="keep-last">
                                    <TextInput id="keep-last" type="number" value={keepLast} onChange={(_ev, val) => setKeepLast(val)} placeholder="—" />
                                </FormGroup>
                                <FormGroup label={_("Daily")} fieldId="keep-daily">
                                    <TextInput id="keep-daily" type="number" value={keepDaily} onChange={(_ev, val) => setKeepDaily(val)} placeholder="—" />
                                </FormGroup>
                                <FormGroup label={_("Weekly")} fieldId="keep-weekly">
                                    <TextInput id="keep-weekly" type="number" value={keepWeekly} onChange={(_ev, val) => setKeepWeekly(val)} placeholder="—" />
                                </FormGroup>
                                <FormGroup label={_("Monthly")} fieldId="keep-monthly">
                                    <TextInput id="keep-monthly" type="number" value={keepMonthly} onChange={(_ev, val) => setKeepMonthly(val)} placeholder="—" />
                                </FormGroup>
                                <FormGroup label={_("Yearly")} fieldId="keep-yearly">
                                    <TextInput id="keep-yearly" type="number" value={keepYearly} onChange={(_ev, val) => setKeepYearly(val)} placeholder="—" />
                                </FormGroup>
                            </div>
                        </CardBody>
                    </Card>
                </div>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={handleSubmit} isDisabled={!name.trim() || !sources.trim()}>
                    {isEdit ? _("Save Changes") : _("Create Job")}
                </Button>
                <Button variant="link" onClick={onClose}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
