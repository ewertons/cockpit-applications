import cockpit from 'cockpit';

// Types for restic JSON output

export interface ResticSnapshot {
    id: string;
    short_id: string;
    time: string;
    hostname: string;
    username: string;
    tags: string[] | null;
    paths: string[];
    program_version?: string;
}

export interface ResticRepoStats {
    total_size: number;
    total_file_count: number;
    snapshots_count?: number;
}

export interface BackupProgress {
    message_type: "status" | "summary";
    percent_done?: number;
    total_files?: number;
    files_done?: number;
    total_bytes?: number;
    bytes_done?: number;
    current_files?: string[];
    // summary fields
    files_new?: number;
    files_changed?: number;
    files_unmodified?: number;
    dirs_new?: number;
    dirs_changed?: number;
    dirs_unmodified?: number;
    data_added?: number;
    total_duration?: number;
    snapshot_id?: string;
}

export interface ForgetPolicy {
    keep_last?: number;
    keep_hourly?: number;
    keep_daily?: number;
    keep_weekly?: number;
    keep_monthly?: number;
    keep_yearly?: number;
    keep_within?: string; // e.g. "30d"
}

export interface BackupJob {
    id: string;
    name: string;
    sources: string[];
    repository: string;
    password_file: string;
    excludes: string[];
    exclude_patterns: string[];
    exclude_if_present: string[];
    exclude_larger_than?: string;
    exclude_caches: boolean;
    tags: string[];
    schedule?: string; // systemd OnCalendar format
    retention?: ForgetPolicy;
    enabled: boolean;
    one_file_system: boolean;
}

export interface Destination {
    id: string;
    name: string;
    type: "local" | "sftp" | "rest" | "s3" | "azure" | "gcs" | "b2";
    path: string; // full restic repo URI
    password_file: string;
    env_vars?: Record<string, string>; // cloud credentials env vars
    ssh_key?: string; // path to SSH private key (for sftp destinations)
    initialized: boolean;
}

// Build env vars map with SSH key merged in (as internal _SSH_KEY entry)
export function destEnvVars(dest: Destination): Record<string, string> | undefined {
    if (!dest.ssh_key && !dest.env_vars) return undefined;
    const vars: Record<string, string> = { ...dest.env_vars };
    if (dest.ssh_key) vars._SSH_KEY = dest.ssh_key;
    return vars;
}

const CONFIG_DIR = "/etc/cockpit-backup";
const JOBS_FILE = `${CONFIG_DIR}/jobs.json`;
const DESTINATIONS_FILE = `${CONFIG_DIR}/destinations.json`;
const PASSWORDS_DIR = `${CONFIG_DIR}/passwords`;

// Extract user@host from an sftp repo URL for use in sftp.command
function sftpHost(repo: string): string {
    if (repo.startsWith('sftp://')) {
        const match = repo.match(/^sftp:\/\/([^/]+)/);
        return match ? match[1] : '';
    } else if (repo.startsWith('sftp:')) {
        const rest = repo.slice(5);
        const idx = rest.indexOf(':');
        return idx !== -1 ? rest.slice(0, idx) : rest;
    }
    return '';
}

// Execute a restic command with JSON output
function resticCmd(args: string[], repo: string, passwordFile: string, envVars?: Record<string, string>): Promise<string> {
    const env: string[] = [];
    env.push(`RESTIC_REPOSITORY=${repo}`);
    env.push(`RESTIC_PASSWORD_FILE=${passwordFile}`);

    const extraArgs: string[] = [];
    if (envVars) {
        for (const [key, val] of Object.entries(envVars)) {
            if (key === '_SSH_KEY' && val) {
                const host = sftpHost(repo);
                if (host) {
                    extraArgs.push("-o", `sftp.command=ssh ${host} -i ${val} -o StrictHostKeyChecking=accept-new -s sftp`);
                }
            } else {
                env.push(`${key}=${val}`);
            }
        }
    }

    const cmd = ["env", ...env, "restic", ...extraArgs, ...args];
    return cockpit.spawn(cmd, { superuser: "try", err: "message" })
            .then((output: string) => output);
}

// Initialize a new restic repository
export async function initRepo(repo: string, passwordFile: string, envVars?: Record<string, string>): Promise<string> {
    return resticCmd(["init", "--json"], repo, passwordFile, envVars);
}

// List all snapshots in a repository
export async function listSnapshots(repo: string, passwordFile: string, envVars?: Record<string, string>): Promise<ResticSnapshot[]> {
    const output = await resticCmd(["snapshots", "--json"], repo, passwordFile, envVars);
    return JSON.parse(output);
}

// Get repository statistics
export async function repoStats(repo: string, passwordFile: string, envVars?: Record<string, string>): Promise<ResticRepoStats> {
    const output = await resticCmd(["stats", "--json"], repo, passwordFile, envVars);
    return JSON.parse(output);
}

// Build the full restic backup command (env + args) without executing
export function buildBackupCommand(
    sources: string[],
    repo: string,
    passwordFile: string,
    options: {
        excludes?: string[];
        excludePatterns?: string[];
        excludeIfPresent?: string[];
        excludeLargerThan?: string;
        excludeCaches?: boolean;
        tags?: string[];
        oneFileSystem?: boolean;
    },
    envVars?: Record<string, string>,
): { env: string[]; resticArgs: string[] } {
    const args: string[] = ["backup", "--json"];

    if (options.excludes) {
        for (const ex of options.excludes) {
            args.push("--exclude", ex);
        }
    }
    if (options.excludePatterns) {
        for (const pat of options.excludePatterns) {
            args.push("--exclude", pat);
        }
    }
    if (options.excludeIfPresent) {
        for (const f of options.excludeIfPresent) {
            args.push("--exclude-if-present", f);
        }
    }
    if (options.excludeLargerThan) {
        args.push("--exclude-larger-than", options.excludeLargerThan);
    }
    if (options.excludeCaches) {
        args.push("--exclude-caches");
    }
    if (options.tags) {
        for (const tag of options.tags) {
            args.push("--tag", tag);
        }
    }
    if (options.oneFileSystem) {
        args.push("--one-file-system");
    }

    args.push(...sources);

    const env: string[] = [];
    env.push(`RESTIC_REPOSITORY=${repo}`);
    env.push(`RESTIC_PASSWORD_FILE=${passwordFile}`);
    const extraArgs: string[] = [];
    if (envVars) {
        for (const [key, val] of Object.entries(envVars)) {
            if (key === '_SSH_KEY' && val) {
                const host = sftpHost(repo);
                if (host) {
                    extraArgs.push("-o", `sftp.command=ssh ${host} -i ${val} -o StrictHostKeyChecking=accept-new -s sftp`);
                }
            } else {
                env.push(`${key}=${val}`);
            }
        }
    }

    return { env, resticArgs: [...extraArgs, ...args] };
}

// Run a backup as a transient systemd unit (survives page reloads/logouts)
export const BACKUP_UNIT_PREFIX = "cockpit-backup-run";

export async function startBackupUnit(
    jobId: string,
    jobName: string,
    sources: string[],
    repo: string,
    passwordFile: string,
    options: {
        excludes?: string[];
        excludePatterns?: string[];
        excludeIfPresent?: string[];
        excludeLargerThan?: string;
        excludeCaches?: boolean;
        tags?: string[];
        oneFileSystem?: boolean;
    },
    envVars?: Record<string, string>,
): Promise<string> {
    const unitName = `${BACKUP_UNIT_PREFIX}-${jobId}`;
    const { env, resticArgs } = buildBackupCommand(sources, repo, passwordFile, options, envVars);

    const cmd = [
        "systemd-run",
        "--unit", unitName,
        `--description=Cockpit Backup: ${jobName}`,
        "--property=StandardOutput=journal",
        "--property=StandardError=journal",
        "--property=SyslogIdentifier=" + unitName,
        "--",
        "env", ...env,
        "restic", ...resticArgs,
    ];

    await cockpit.spawn(cmd, { superuser: "try", err: "message" });
    return unitName;
}

// List currently running backup units
export async function getRunningBackupUnits(): Promise<string[]> {
    try {
        // Check both running (Type=simple) and activating (Type=oneshot legacy) states
        const output = await cockpit.spawn(
            ["systemctl", "list-units", `${BACKUP_UNIT_PREFIX}-*.service`, "--state=running,activating", "--plain", "--no-legend"],
            { superuser: "try", err: "ignore" }
        );
        const units: string[] = [];
        for (const line of output.trim().split('\n')) {
            const name = line.trim().split(/\s+/)[0];
            if (name && name.endsWith('.service')) {
                units.push(name.replace('.service', ''));
            }
        }
        return units;
    } catch {
        return [];
    }
}

// Extract job ID from a unit name
export function jobIdFromUnit(unitName: string): string {
    return unitName.replace(`${BACKUP_UNIT_PREFIX}-`, '');
}

// Check if a specific backup unit is still running
export async function isBackupUnitRunning(jobId: string): Promise<boolean> {
    const unitName = `${BACKUP_UNIT_PREFIX}-${jobId}.service`;
    try {
        const output = await cockpit.spawn(
            ["systemctl", "is-active", unitName],
            { superuser: "try", err: "ignore" }
        );
        const state = output.trim();
        return state === "active" || state === "activating";
    } catch {
        return false;
    }
}

// Get the exit status of a finished backup unit
export async function getBackupUnitResult(jobId: string): Promise<{ success: boolean; message: string }> {
    const unitName = `${BACKUP_UNIT_PREFIX}-${jobId}.service`;
    try {
        const output = await cockpit.spawn(
            ["systemctl", "show", unitName, "--property=ActiveState,Result,ExecMainStatus"],
            { superuser: "try", err: "ignore" }
        );
        const props: Record<string, string> = {};
        for (const line of output.split('\n')) {
            const [key, ...val] = line.split('=');
            if (key) props[key.trim()] = val.join('=').trim();
        }
        const success = props.Result === "success" && props.ExecMainStatus === "0";
        return { success, message: success ? "Backup completed successfully." : `Backup failed (exit ${props.ExecMainStatus || "unknown"}).` };
    } catch (err: any) {
        return { success: false, message: err.message || String(err) };
    }
}

// Run a backup (legacy - direct cockpit.spawn, does NOT survive page reload)
export function runBackup(
    sources: string[],
    repo: string,
    passwordFile: string,
    options: {
        excludes?: string[];
        excludePatterns?: string[];
        excludeIfPresent?: string[];
        excludeLargerThan?: string;
        excludeCaches?: boolean;
        tags?: string[];
        oneFileSystem?: boolean;
    },
    envVars?: Record<string, string>,
    onProgress?: (progress: BackupProgress) => void
): cockpit.Spawn {
    const { env, resticArgs } = buildBackupCommand(sources, repo, passwordFile, options, envVars);
    const cmd = ["env", ...env, "restic", ...resticArgs];
    const proc = cockpit.spawn(cmd, { superuser: "try", err: "message" });

    if (onProgress) {
        proc.stream((data: string) => {
            for (const line of data.split('\n')) {
                if (line.trim()) {
                    try {
                        const msg = JSON.parse(line) as BackupProgress;
                        onProgress(msg);
                    } catch { /* ignore non-JSON lines */ }
                }
            }
        });
    }

    return proc;
}

// Restore a snapshot
export function restoreSnapshot(
    snapshotId: string,
    target: string,
    repo: string,
    passwordFile: string,
    options?: {
        include?: string[];
        exclude?: string[];
    },
    envVars?: Record<string, string>
): Promise<string> {
    const args: string[] = ["restore", snapshotId, "--target", target, "--json"];

    if (options?.include) {
        for (const inc of options.include) {
            args.push("--include", inc);
        }
    }
    if (options?.exclude) {
        for (const ex of options.exclude) {
            args.push("--exclude", ex);
        }
    }

    return resticCmd(args, repo, passwordFile, envVars);
}

// Forget snapshots with a retention policy
export async function forgetSnapshots(
    repo: string,
    passwordFile: string,
    policy: ForgetPolicy,
    prune: boolean = true,
    snapshotIds?: string[],
    envVars?: Record<string, string>
): Promise<string> {
    const args: string[] = ["forget", "--json"];

    if (policy.keep_last) args.push("--keep-last", String(policy.keep_last));
    if (policy.keep_hourly) args.push("--keep-hourly", String(policy.keep_hourly));
    if (policy.keep_daily) args.push("--keep-daily", String(policy.keep_daily));
    if (policy.keep_weekly) args.push("--keep-weekly", String(policy.keep_weekly));
    if (policy.keep_monthly) args.push("--keep-monthly", String(policy.keep_monthly));
    if (policy.keep_yearly) args.push("--keep-yearly", String(policy.keep_yearly));
    if (policy.keep_within) args.push("--keep-within", policy.keep_within);
    if (prune) args.push("--prune");

    if (snapshotIds) {
        args.push(...snapshotIds);
    }

    return resticCmd(args, repo, passwordFile, envVars);
}

// Delete a specific snapshot
export async function deleteSnapshot(
    snapshotId: string,
    repo: string,
    passwordFile: string,
    envVars?: Record<string, string>
): Promise<string> {
    return resticCmd(["forget", snapshotId, "--prune", "--json"], repo, passwordFile, envVars);
}

// Add a tag to a snapshot
export async function tagSnapshot(
    snapshotId: string,
    tag: string,
    repo: string,
    passwordFile: string,
    envVars?: Record<string, string>
): Promise<string> {
    return resticCmd(["tag", "--add", tag, snapshotId], repo, passwordFile, envVars);
}

// List files in a snapshot
export async function listSnapshotFiles(
    snapshotId: string,
    path: string,
    repo: string,
    passwordFile: string,
    envVars?: Record<string, string>
): Promise<string> {
    return resticCmd(["ls", snapshotId, path, "--json"], repo, passwordFile, envVars);
}

// Check repository integrity
export async function checkRepo(repo: string, passwordFile: string, envVars?: Record<string, string>): Promise<string> {
    return resticCmd(["check", "--json"], repo, passwordFile, envVars);
}

// Unlock a locked repository
export async function unlockRepo(repo: string, passwordFile: string, envVars?: Record<string, string>): Promise<string> {
    return resticCmd(["unlock"], repo, passwordFile, envVars);
}

// --- Configuration management ---

export async function loadJobs(): Promise<BackupJob[]> {
    try {
        const content = await cockpit.file(JOBS_FILE, { superuser: "try" }).read();
        return content ? JSON.parse(content) : [];
    } catch {
        return [];
    }
}

export async function saveJobs(jobs: BackupJob[]): Promise<void> {
    await cockpit.spawn(["mkdir", "-p", CONFIG_DIR], { superuser: "try" });
    await cockpit.file(JOBS_FILE, { superuser: "try" }).replace(JSON.stringify(jobs, null, 2));
}

export async function loadDestinations(): Promise<Destination[]> {
    try {
        const content = await cockpit.file(DESTINATIONS_FILE, { superuser: "try" }).read();
        return content ? JSON.parse(content) : [];
    } catch {
        return [];
    }
}

export async function saveDestinations(destinations: Destination[]): Promise<void> {
    await cockpit.spawn(["mkdir", "-p", CONFIG_DIR], { superuser: "try" });
    await cockpit.file(DESTINATIONS_FILE, { superuser: "try" }).replace(JSON.stringify(destinations, null, 2));
}

// Create a password file for a repository
export async function createPasswordFile(id: string, password: string): Promise<string> {
    const filePath = `${PASSWORDS_DIR}/${id}`;
    await cockpit.spawn(["mkdir", "-p", PASSWORDS_DIR], { superuser: "try" });
    await cockpit.file(filePath, { superuser: "try" }).replace(password);
    await cockpit.spawn(["chmod", "600", filePath], { superuser: "try" });
    return filePath;
}

// --- Systemd timer management ---

const SYSTEMD_DIR = "/etc/systemd/system";
const SERVICE_PREFIX = "cockpit-backup";

export async function enableJobSchedule(job: BackupJob): Promise<void> {
    if (!job.schedule) return;

    const serviceName = `${SERVICE_PREFIX}-${job.id}`;

    // Find the matching destination to get SSH key and env vars
    const destinations = await loadDestinations();
    const dest = destinations.find(d => d.path === job.repository);

    // Build environment lines
    const envLines: string[] = [
        `Environment="RESTIC_REPOSITORY=${job.repository}"`,
        `Environment="RESTIC_PASSWORD_FILE=${job.password_file}"`,
    ];
    if (dest?.env_vars) {
        for (const [key, val] of Object.entries(dest.env_vars)) {
            if (key !== '_SSH_KEY') {
                envLines.push(`Environment="${key}=${val}"`);
            }
        }
    }

    // Build the restic command arguments
    const args: string[] = ["backup", "--json"];
    for (const src of job.sources) {
        args.push(src);
    }
    for (const ex of job.excludes) {
        args.push("--exclude", ex);
    }
    for (const pat of job.exclude_patterns) {
        args.push("--exclude", pat);
    }
    for (const f of job.exclude_if_present) {
        args.push("--exclude-if-present", f);
    }
    if (job.exclude_larger_than) {
        args.push("--exclude-larger-than", job.exclude_larger_than);
    }
    if (job.exclude_caches) {
        args.push("--exclude-caches");
    }
    for (const tag of job.tags) {
        args.push("--tag", tag);
    }
    if (job.one_file_system) {
        args.push("--one-file-system");
    }

    // Handle SFTP SSH key
    const sshKeyPath = dest?.ssh_key;
    if (sshKeyPath) {
        const host = sftpHost(job.repository);
        if (host) {
            args.push("-o", `sftp.command=ssh ${host} -i ${sshKeyPath} -o StrictHostKeyChecking=accept-new -s sftp`);
        }
    }

    const execStart = `/usr/bin/restic ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;

    const serviceContent = `[Unit]
Description=Cockpit Backup Job: ${job.name}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
${envLines.join('\n')}
ExecStart=${execStart}
`;

    const timerContent = `[Unit]
Description=Timer for Cockpit Backup Job: ${job.name}

[Timer]
OnCalendar=${job.schedule}
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
`;

    await cockpit.file(`${SYSTEMD_DIR}/${serviceName}.service`, { superuser: "try" })
            .replace(serviceContent);
    await cockpit.file(`${SYSTEMD_DIR}/${serviceName}.timer`, { superuser: "try" })
            .replace(timerContent);

    await cockpit.spawn(["systemctl", "daemon-reload"], { superuser: "try" });
    await cockpit.spawn(["systemctl", "enable", "--now", `${serviceName}.timer`], { superuser: "try" });
}

export async function disableJobSchedule(job: BackupJob): Promise<void> {
    const serviceName = `${SERVICE_PREFIX}-${job.id}`;

    try {
        await cockpit.spawn(["systemctl", "disable", "--now", `${serviceName}.timer`], { superuser: "try" });
        await cockpit.spawn(["rm", "-f",
            `${SYSTEMD_DIR}/${serviceName}.service`,
            `${SYSTEMD_DIR}/${serviceName}.timer`
        ], { superuser: "try" });
        await cockpit.spawn(["systemctl", "daemon-reload"], { superuser: "try" });
    } catch { /* timer might not exist */ }
}

export async function getTimerStatus(job: BackupJob): Promise<{ active: boolean; next_run?: string; last_run?: string }> {
    const serviceName = `${SERVICE_PREFIX}-${job.id}`;
    try {
        const output = await cockpit.spawn(
            ["systemctl", "show", `${serviceName}.timer`, "--property=ActiveState,NextElapseUSecRealtime,LastTriggerUSec"],
            { superuser: "try" }
        );
        const props: Record<string, string> = {};
        for (const line of output.split('\n')) {
            const [key, ...val] = line.split('=');
            if (key) props[key.trim()] = val.join('=').trim();
        }
        return {
            active: props.ActiveState === "active",
            next_run: props.NextElapseUSecRealtime || undefined,
            last_run: props.LastTriggerUSec || undefined,
        };
    } catch {
        return { active: false };
    }
}
