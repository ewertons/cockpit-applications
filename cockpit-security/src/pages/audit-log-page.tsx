import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Select, SelectOption, SelectList } from "@patternfly/react-core/dist/esm/components/Select/index.js";
import { MenuToggle } from "@patternfly/react-core/dist/esm/components/MenuToggle/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

interface AuditEntry {
    timestamp: string;
    type: string;
    message: string;
}

export const AuditLogPage = () => {
    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [filter, setFilter] = useState("");
    const [logSource, setLogSource] = useState<"auditd" | "journalctl">("journalctl");
    const [lineCount, setLineCount] = useState("100");
    const [selectOpen, setSelectOpen] = useState(false);
    const [auditdInstalled, setAuditdInstalled] = useState(true);
    const [installing, setInstalling] = useState(false);

    useEffect(() => {
        detectSource();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const detectSource = async () => {
        // Check if auditd unit is known to systemd (installed)
        let installed = false;
        try {
            const loadState = await cockpit.spawn(["systemctl", "show", "-p", "LoadState", "--value", "auditd"], { err: "ignore" });
            installed = loadState.trim() !== "not-found";
        } catch {
            installed = false;
        }
        setAuditdInstalled(installed);

        if (installed) {
            try {
                const status = await cockpit.spawn(["systemctl", "is-active", "auditd"], { err: "ignore" });
                if (status.trim() === "active") {
                    setLogSource("auditd");
                    await loadAuditd();
                } else {
                    await loadJournalctl();
                }
            } catch {
                await loadJournalctl();
            }
        } else {
            await loadJournalctl();
        }
        setLoading(false);
    };

    const installAuditd = async () => {
        setInstalling(true);
        setError("");
        try {
            try {
                await cockpit.spawn(["which", "dnf"], { err: "ignore" });
                await cockpit.spawn(["dnf", "install", "-y", "audit"], { superuser: "require", err: "message" });
            } catch {
                try {
                    await cockpit.spawn(["which", "apt-get"], { err: "ignore" });
                    await cockpit.spawn(["apt-get", "install", "-y", "auditd"], { superuser: "require", err: "message" });
                } catch {
                    try {
                        await cockpit.spawn(["which", "yum"], { err: "ignore" });
                        await cockpit.spawn(["yum", "install", "-y", "audit"], { superuser: "require", err: "message" });
                    } catch {
                        throw new Error(_("Could not detect package manager. Install auditd manually."));
                    }
                }
            }
            await cockpit.spawn(["systemctl", "enable", "--now", "auditd"], { superuser: "require" });
            setAuditdInstalled(true);
            setLogSource("auditd");
            await loadAuditd();
        } catch (e) {
            setError(String(e));
        }
        setInstalling(false);
    };

    const loadAuditd = async () => {
        try {
            const args = ["ausearch", "-i", "--input-logs"];
            if (filter) {
                args.push("-m", filter);
            }
            args.push("--just-one" /* not valid, we'll limit in JS */);
            // Just get recent logs
            const output = await cockpit.spawn(
                ["tail", "-n", lineCount, "/var/log/audit/audit.log"],
                { err: "ignore", superuser: "try" }
            );
            parseAuditLog(output);
        } catch {
            // Fallback: try aureport
            try {
                const output = await cockpit.spawn(
                    ["aureport", "--summary", "-i"],
                    { err: "ignore", superuser: "try" }
                );
                setEntries([{ timestamp: "", type: "summary", message: output }]);
            } catch {
                if (!auditdInstalled) {
                    setError(_("Audit daemon is not installed. Use the install button above to set it up."));
                } else {
                    setError(_("Cannot read audit logs. Ensure auditd is running and you have sufficient permissions."));
                }
            }
        }
    };

    const loadJournalctl = async () => {
        try {
            const args = ["journalctl", "--no-pager", "-n", lineCount, "--output", "short-iso"];
            if (filter) {
                args.push("--grep", filter);
            }
            // Focus on security-relevant units
            args.push(
                "-u", "sshd",
                "-u", "sudo",
                "-u", "polkit",
                "-u", "systemd-logind",
            );
            const output = await cockpit.spawn(args, { err: "ignore", superuser: "try" });
            const lines = output.trim().split("\n")
                    .filter(Boolean);
            setEntries(lines.map(line => {
                const parts = line.match(/^(\S+\s+\S+)\s+\S+\s+(\S+)(?:\[\d+\])?:\s*(.*)/);
                if (parts) {
                    return { timestamp: parts[1], type: parts[2], message: parts[3] };
                }
                return { timestamp: "", type: "", message: line };
            }));
        } catch (e) {
            setError(String(e));
        }
    };

    const parseAuditLog = (raw: string) => {
        const lines = raw.trim().split("\n")
                .filter(Boolean);
        const parsed: AuditEntry[] = lines.map(line => {
            const typeMatch = line.match(/type=(\S+)/);
            const msgMatch = line.match(/msg=audit\(([^)]+)\)/);
            return {
                timestamp: msgMatch ? msgMatch[1] : "",
                type: typeMatch ? typeMatch[1] : "unknown",
                message: line,
            };
        });
        setEntries(parsed);
    };

    const refresh = async () => {
        setLoading(true);
        setError("");
        if (logSource === "auditd") {
            await loadAuditd();
        } else {
            await loadJournalctl();
        }
        setLoading(false);
    };

    if (loading) return <Spinner />;

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("Audit Logs")}</Title>

            {error && <Alert variant="danger" title={error} className="pf-v6-u-mb-md" />}

            {!auditdInstalled && (
                <Alert variant="warning" title={_("Audit daemon (auditd) is not installed.")} className="pf-v6-u-mb-md">
                    <p>{_("Install auditd to enable kernel-level security auditing and detailed audit logs.")}</p>
                    <Button variant="primary" className="pf-v6-u-mt-sm" onClick={installAuditd} isLoading={installing} isDisabled={installing}>
                        {installing ? _("Installing…") : _("Install Audit Daemon")}
                    </Button>
                </Alert>
            )}

            <Card className="pf-v6-u-mb-md">
                <CardTitle>{_("Filters")}</CardTitle>
                <CardBody>
                    <div style={{ display: "flex", gap: "1rem", alignItems: "flex-end", flexWrap: "wrap" }}>
                        <FormGroup label={_("Source")}>
                            <Select
                                toggle={(toggleRef) => (
                                    <MenuToggle ref={toggleRef} onClick={() => setSelectOpen(!selectOpen)} isExpanded={selectOpen}>
                                        {logSource === "auditd" ? "auditd" : "journalctl"}
                                    </MenuToggle>
                                )}
                                isOpen={selectOpen}
                                onSelect={(_e, val) => { setLogSource(val as typeof logSource); setSelectOpen(false) }}
                                onOpenChange={setSelectOpen}
                            >
                                <SelectList>
                                    <SelectOption value="auditd">auditd</SelectOption>
                                    <SelectOption value="journalctl">journalctl</SelectOption>
                                </SelectList>
                            </Select>
                        </FormGroup>
                        <FormGroup label={_("Filter / Grep")}>
                            <TextInput value={filter} onChange={(_e, val) => setFilter(val)} placeholder="e.g. Failed, USER_AUTH" />
                        </FormGroup>
                        <FormGroup label={_("Lines")}>
                            <TextInput value={lineCount} onChange={(_e, val) => setLineCount(val)} type="number" />
                        </FormGroup>
                        <Button onClick={refresh}>{_("Load")}</Button>
                    </div>
                </CardBody>
            </Card>

            <Card>
                <CardTitle>{_("Log Entries")} ({entries.length})</CardTitle>
                <CardBody>
                    <div className="log-viewer">
                        {entries.map((e, i) => (
                            <div key={i}>
                                {e.timestamp && <span style={{ color: "var(--pf-t--global--text--color--subtle)" }}>{e.timestamp} </span>}
                                {e.type && <strong>[{e.type}] </strong>}
                                {e.message}
                            </div>
                        ))}
                        {entries.length === 0 && _("No log entries found.")}
                    </div>
                </CardBody>
            </Card>
        </>
    );
};
