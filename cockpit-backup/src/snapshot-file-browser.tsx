import React, { useCallback, useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";

import cockpit from 'cockpit';
import { Destination, destEnvVars, ResticSnapshot } from './restic.js';

const _ = cockpit.gettext;

export interface FileEntry {
    name: string;
    type: "file" | "dir";
    path: string;
    size: number;
    mtime: string;
}

interface SnapshotFileBrowserProps {
    snapshot: ResticSnapshot;
    destinations: Destination[];
    onSelect: (paths: string[]) => void;
    onClose: () => void;
}

function formatSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(mtime: string): string {
    const d = new Date(mtime);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sftpHost(repo: string): string | null {
    const match = repo.match(/sftp:([^@]+@)?([^:/]+)/);
    if (!match) return null;
    return (match[1] || '') + match[2];
}

async function lsSnapshot(
    snapshotId: string,
    path: string,
    destinations: Destination[]
): Promise<FileEntry[]> {
    for (const dest of destinations) {
        try {
            const cmd = [
                "env",
                `RESTIC_REPOSITORY=${dest.path}`,
                `RESTIC_PASSWORD_FILE=${dest.password_file}`,
            ];
            const envVars = destEnvVars(dest);
            const resticArgs: string[] = [];
            if (envVars) {
                for (const [key, val] of Object.entries(envVars)) {
                    if (key === '_SSH_KEY' && val) {
                        const host = sftpHost(dest.path);
                        if (host) {
                            resticArgs.push("-o", `sftp.command=ssh ${host} -i ${val} -o StrictHostKeyChecking=accept-new -s sftp`);
                        }
                    } else {
                        cmd.push(`${key}=${val}`);
                    }
                }
            }
            cmd.push("restic", ...resticArgs, "ls", snapshotId, path, "--json");
            const output = await cockpit.spawn(cmd, { superuser: "try", err: "message" });
            const entries: FileEntry[] = [];
            for (const line of output.trim().split('\n')) {
                if (!line) continue;
                try {
                    const obj = JSON.parse(line);
                    if (obj.struct_type === "snapshot" || !obj.name) continue;
                    // Only include direct children of the requested path
                    const parentDir = obj.path.replace(/\/[^/]+$/, '') || '/';
                    const normalizedPath = path.replace(/\/$/, '') || '/';
                    if (parentDir !== normalizedPath) continue;
                    if (obj.type === "file" || obj.type === "dir") {
                        entries.push({
                            name: obj.name,
                            type: obj.type,
                            path: obj.path,
                            size: obj.size || 0,
                            mtime: obj.mtime || "",
                        });
                    }
                } catch { /* skip non-JSON lines */ }
            }
            entries.sort((a, b) => {
                if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            return entries;
        } catch { /* try next destination */ }
    }
    throw new Error("Could not list snapshot files from any destination.");
}

export function SnapshotFileBrowser({ snapshot, destinations, onSelect, onClose }: SnapshotFileBrowserProps) {
    const [currentPath, setCurrentPath] = useState('/');
    const [entries, setEntries] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [dirTree, setDirTree] = useState<string[]>(['/']);

    const loadDir = useCallback(async (path: string) => {
        setLoading(true);
        setError(null);
        try {
            const result = await lsSnapshot(snapshot.id, path, destinations);
            setEntries(result);
            setCurrentPath(path);
            const parts = path.split('/').filter(Boolean);
            const tree = ['/'];
            let acc = '';
            for (const p of parts) {
                acc += '/' + p;
                tree.push(acc);
            }
            setDirTree(tree);
        } catch (e: any) {
            setError(e.message || String(e));
        }
        setLoading(false);
    }, [snapshot.id, destinations]);

    useEffect(() => {
        const startPath = snapshot.paths[0] || '/';
        loadDir(startPath);
    }, [loadDir, snapshot.paths]);

    const toggleSelect = (path: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const handleConfirm = () => {
        onSelect(Array.from(selected));
    };

    const navigateUp = () => {
        if (currentPath === '/') return;
        const parent = currentPath.replace(/\/[^/]+\/?$/, '') || '/';
        loadDir(parent);
    };

    const dirs = entries.filter(e => e.type === "dir");
    const files = entries.filter(e => e.type === "file");

    return (
        <Modal variant="large" isOpen onClose={onClose}>
            <ModalHeader title={cockpit.format(_("Browse Snapshot $0"), snapshot.short_id)} />
            <ModalBody>
                {error && <Alert variant="danger" title={_("Error")} isInline style={{ marginBottom: "0.5rem" }}>{error}</Alert>}

                <div className="file-browser">
                    {/* Left panel: directory navigation */}
                    <div className="file-browser-left">
                        <div className="file-browser-breadcrumb">
                            {dirTree.map((dir, i) => (
                                <span key={dir}>
                                    {i > 0 && <span className="breadcrumb-sep">/</span>}
                                    <button
                                        className={`breadcrumb-link ${dir === currentPath ? 'active' : ''}`}
                                        onClick={() => loadDir(dir)}
                                    >
                                        {i === 0 ? '/' : dir.split('/').pop()}
                                    </button>
                                </span>
                            ))}
                        </div>
                        <div className="file-browser-dirs">
                            {currentPath !== '/' && (
                                <div className="dir-entry" onClick={navigateUp}>
                                    <span className="dir-icon">📁</span>
                                    <span className="dir-name">..</span>
                                </div>
                            )}
                            {dirs.map(d => (
                                <div
                                    key={d.path}
                                    className="dir-entry"
                                    onClick={() => loadDir(d.path)}
                                >
                                    <span className="dir-icon">📁</span>
                                    <span className="dir-name">{d.name}</span>
                                </div>
                            ))}
                            {!loading && dirs.length === 0 && currentPath === '/' && (
                                <div className="dir-empty">{_("No subdirectories")}</div>
                            )}
                        </div>
                    </div>

                    {/* Right panel: file/dir listing with selection */}
                    <div className="file-browser-right">
                        {loading
                            ? <div style={{ padding: "2rem", textAlign: "center" }}><Spinner size="lg" /></div>
                            : (
                                <table className="file-browser-table">
                                    <thead>
                                        <tr>
                                            <th className="fb-check"></th>
                                            <th className="fb-name">{_("Name")}</th>
                                            <th className="fb-size">{_("Size")}</th>
                                            <th className="fb-date">{_("Modified")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {dirs.map(d => (
                                            <tr key={d.path} className={selected.has(d.path) ? 'selected' : ''}>
                                                <td className="fb-check">
                                                    <input
                                                        type="checkbox"
                                                        checked={selected.has(d.path)}
                                                        onChange={() => toggleSelect(d.path)}
                                                    />
                                                </td>
                                                <td className="fb-name">
                                                    <span className="entry-icon">📁</span>
                                                    <button className="entry-link" onClick={() => loadDir(d.path)}>
                                                        {d.name}
                                                    </button>
                                                </td>
                                                <td className="fb-size">—</td>
                                                <td className="fb-date">{d.mtime ? formatDate(d.mtime) : '—'}</td>
                                            </tr>
                                        ))}
                                        {files.map(f => (
                                            <tr key={f.path} className={selected.has(f.path) ? 'selected' : ''}>
                                                <td className="fb-check">
                                                    <input
                                                        type="checkbox"
                                                        checked={selected.has(f.path)}
                                                        onChange={() => toggleSelect(f.path)}
                                                    />
                                                </td>
                                                <td className="fb-name">
                                                    <span className="entry-icon">📄</span>
                                                    {f.name}
                                                </td>
                                                <td className="fb-size">{formatSize(f.size)}</td>
                                                <td className="fb-date">{f.mtime ? formatDate(f.mtime) : '—'}</td>
                                            </tr>
                                        ))}
                                        {!loading && entries.length === 0 && (
                                            <tr><td colSpan={4} style={{ textAlign: "center", padding: "1rem", color: "var(--pf-t--global--text--color--subtle)" }}>{_("Empty directory")}</td></tr>
                                        )}
                                    </tbody>
                                </table>
                            )}
                    </div>
                </div>

                {selected.size > 0 && (
                    <div className="file-browser-selection-count">
                        {cockpit.format(_("$0 items selected"), String(selected.size))}
                    </div>
                )}
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={handleConfirm} isDisabled={selected.size === 0}>
                    {cockpit.format(_("Add $0 paths"), String(selected.size))}
                </Button>
                <Button variant="link" onClick={onClose}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
