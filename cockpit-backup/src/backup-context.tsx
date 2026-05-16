import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import cockpit from 'cockpit';
import {
    BackupJob, BackupProgress, Destination, destEnvVars,
    startBackupUnit, getRunningBackupUnits, jobIdFromUnit,
    isBackupUnitRunning, getBackupUnitResult, BACKUP_UNIT_PREFIX,
    loadJobs
} from './restic.js';

const _ = cockpit.gettext;

export interface RunningBackup {
    jobId: string;
    jobName: string;
    progress: number;
    status: string;
    startedAt: number;
}

export interface BackupResult {
    jobId: string;
    success: boolean;
    message: string;
    finishedAt: number;
}

interface BackupContextType {
    runningBackups: Record<string, RunningBackup>;
    results: Record<string, BackupResult>;
    startBackup: (job: BackupJob, dest: Destination | undefined) => void;
    clearResult: (jobId: string) => void;
}

const BackupContext = createContext<BackupContextType>({
    runningBackups: {},
    results: {},
    startBackup: () => {},
    clearResult: () => {},
});

export function BackupProvider({ children }: { children: React.ReactNode }) {
    const [runningBackups, setRunningBackups] = useState<Record<string, RunningBackup>>({});
    const [results, setResults] = useState<Record<string, BackupResult>>({});
    const journalProcs = useRef<Record<string, any>>({});

    // Monitor a running backup unit via journalctl
    const monitorUnit = useCallback((jobId: string, _jobName: string) => {
        // Avoid double-monitoring
        if (journalProcs.current[jobId]) return;

        const unitName = `${BACKUP_UNIT_PREFIX}-${jobId}.service`;
        const proc = cockpit.spawn(
            ["journalctl", "-u", unitName, "-f", "--output=cat", "-n", "0"],
            { superuser: "try", err: "ignore" }
        );
        journalProcs.current[jobId] = proc;

        proc.stream((data: string) => {
            for (const line of data.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line) as BackupProgress;
                    if (msg.message_type === 'status') {
                        const pct = Math.round((msg.percent_done || 0) * 100);
                        const files = msg.files_done || 0;
                        const total = msg.total_files || 0;
                        setRunningBackups(prev => ({
                            ...prev,
                            [jobId]: {
                                ...prev[jobId],
                                progress: pct,
                                status: cockpit.format(_("$0% — $1/$2 files"), pct, files, total),
                            }
                        }));
                    } else if (msg.message_type === 'summary') {
                        setRunningBackups(prev => ({
                            ...prev,
                            [jobId]: { ...prev[jobId], progress: 100, status: _("Finishing...") }
                        }));
                    }
                } catch { /* ignore non-JSON lines */ }
            }
        });

        // When journal stream ends, check if the unit finished
        proc.then(() => checkUnitFinished(jobId));
        proc.catch(() => checkUnitFinished(jobId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Poll for unit completion (since journal stream may end before we get the result)
    const checkUnitFinished = useCallback(async (jobId: string) => {
        delete journalProcs.current[jobId];

        // Small delay to let systemd finalize the unit state
        await new Promise(resolve => setTimeout(resolve, 1000));

        const still = await isBackupUnitRunning(jobId);
        if (still) {
            // Journal disconnected but unit still running — reconnect
            const existing = runningBackups[jobId];
            monitorUnit(jobId, existing?.jobName || jobId);
            return;
        }

        const result = await getBackupUnitResult(jobId);
        setRunningBackups(prev => { const r = { ...prev }; delete r[jobId]; return r });
        setResults(prev => ({
            ...prev,
            [jobId]: { jobId, success: result.success, message: result.message, finishedAt: Date.now() }
        }));
    }, [runningBackups, monitorUnit]);

    // On mount, detect already-running backup units
    useEffect(() => {
        (async () => {
            const units = await getRunningBackupUnits();
            if (units.length === 0) return;

            // Load jobs to get names
            const jobs = await loadJobs();
            const jobMap = new Map(jobs.map(j => [j.id, j]));

            for (const unitName of units) {
                const jobId = jobIdFromUnit(unitName);
                const job = jobMap.get(jobId);
                const jobName = job?.name || jobId;

                setRunningBackups(prev => ({
                    ...prev,
                    [jobId]: { jobId, jobName, progress: 0, status: _("Running..."), startedAt: Date.now() }
                }));
                monitorUnit(jobId, jobName);
            }
        })();

        // Cleanup journal procs on unmount
        const currentProcs = journalProcs.current;
        return () => {
            for (const proc of Object.values(currentProcs)) {
                try { proc.close() } catch { /* */ }
            }
        };
    }, [monitorUnit]);

    const startBackup = useCallback(async (job: BackupJob, dest: Destination | undefined) => {
        if (runningBackups[job.id]) return; // already running

        setRunningBackups(prev => ({
            ...prev,
            [job.id]: { jobId: job.id, jobName: job.name, progress: 0, status: _("Starting..."), startedAt: Date.now() }
        }));
        setResults(prev => { const r = { ...prev }; delete r[job.id]; return r });

        try {
            await startBackupUnit(
                job.id,
                job.name,
                job.sources,
                job.repository,
                job.password_file,
                {
                    excludes: job.excludes,
                    excludePatterns: job.exclude_patterns,
                    excludeIfPresent: job.exclude_if_present,
                    excludeLargerThan: job.exclude_larger_than,
                    excludeCaches: job.exclude_caches,
                    tags: job.tags,
                    oneFileSystem: job.one_file_system,
                },
                dest ? destEnvVars(dest) : undefined,
            );
            // Unit started — begin monitoring journal
            monitorUnit(job.id, job.name);
        } catch (err: any) {
            setRunningBackups(prev => { const r = { ...prev }; delete r[job.id]; return r });
            setResults(prev => ({
                ...prev,
                [job.id]: { jobId: job.id, success: false, message: err.message || String(err), finishedAt: Date.now() }
            }));
        }
    }, [runningBackups, monitorUnit]);

    const clearResult = useCallback((jobId: string) => {
        setResults(prev => { const r = { ...prev }; delete r[jobId]; return r });
    }, []);

    return (
        <BackupContext.Provider value={{ runningBackups, results, startBackup, clearResult }}>
            {children}
        </BackupContext.Provider>
    );
}

export function useBackups() {
    return useContext(BackupContext);
}
