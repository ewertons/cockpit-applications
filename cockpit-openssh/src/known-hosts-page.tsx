import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Table, Tbody, Td, Th, Thead, Tr } from "@patternfly/react-table/dist/esm/components/Table/index.js";

import cockpit from 'cockpit';

import { listUsers } from './authorized-keys.js';
import {
    KnownHostEntry, KnownHostsFile, Report, TimerStatus,
    annotateFingerprints, appendEntries, deleteStaleBackup, disableReport, enableReport,
    findHost, hasStaleBackup, labelHashedEntries, listKnownHostsFiles, parseKnownHosts,
    purgeAll, readKnownHosts, removeEntry, removeHost, reportJournal, runReportNow, scanHost,
    timerStatus, readReport, validateSchedule, writeKnownHosts,
} from './known-hosts.js';

const _ = cockpit.gettext;

const STATUS_LABELS: Record<string, string> = {
    match: _("Matches"),
    mismatch: _("Differs from the live host key"),
    unreachable: _("Host did not answer"),
    unresolvable: _("Name does not resolve"),
    "skipped-hashed": _("Hashed, cannot be checked"),
    "skipped-pattern": _("Wildcard pattern, cannot be checked"),
};

export const KnownHostsPage = () => {
    const [loading, setLoading] = useState(true);
    const [files, setFiles] = useState<KnownHostsFile[]>([]);
    const [path, setPath] = useState("");
    const [content, setContent] = useState("");
    const [entries, setEntries] = useState<KnownHostEntry[]>([]);
    const [staleBackup, setStaleBackup] = useState(false);

    const [error, setError] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const [host, setHost] = useState("");
    const [port, setPort] = useState("");
    const [scanned, setScanned] = useState<KnownHostEntry[] | null>(null);
    const [confirmRemoveHost, setConfirmRemoveHost] = useState(false);
    const [confirmPurge, setConfirmPurge] = useState(false);
    const [removingEntry, setRemovingEntry] = useState<KnownHostEntry | null>(null);

    const [rawOpen, setRawOpen] = useState(false);
    const [raw, setRaw] = useState("");

    const [timer, setTimer] = useState<TimerStatus | null>(null);
    const [schedule, setSchedule] = useState("daily");
    const [report, setReport] = useState<Report | null>(null);
    const [journal, setJournal] = useState<string | null>(null);

    const loadFile = useCallback(async (target: string) => {
        const text = await readKnownHosts(target);
        setContent(text);
        setRaw(text);
        setEntries(await annotateFingerprints(parseKnownHosts(text)));
        setStaleBackup(await hasStaleBackup(target));
    }, []);

    const loadTimer = useCallback(async () => {
        const status = await timerStatus();
        setTimer(status);
        if (status.schedule)
            setSchedule(status.schedule);
        setReport(await readReport());
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const found = await listKnownHostsFiles(await listUsers());
                setFiles(found);
                const first = found.find(f => f.exists) ?? found[0];
                if (first) {
                    setPath(first.path);
                    await loadFile(first.path);
                }
                await loadTimer();
            } catch (e: unknown) {
                setError(e instanceof Error ? e.message : String(e));
            }
            setLoading(false);
        })();
    }, [loadFile, loadTimer]);

    const run = async (id: string, action: () => Promise<void>) => {
        setBusy(id);
        setError(null);
        setInfo(null);
        try {
            await action();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setBusy(null);
    };

    const selectFile = (target: string) => run("select", async () => {
        setPath(target);
        setInfo(null);
        await loadFile(target);
    });

    const doFind = () => run("find", async () => {
        const found = await findHost(path, host);
        setInfo(found.length > 0
            ? cockpit.format(_("$0 is present with $1 key(s): $2"), host.trim(), String(found.length),
                             found.map(e => e.keyType).join(", "))
            : cockpit.format(_("$0 is not in this file."), host.trim()));
    });

    const doRemoveHost = () => run("remove-host", async () => {
        await removeHost(path, host);
        setConfirmRemoveHost(false);
        setInfo(cockpit.format(_("Removed $0. A backup of the previous file was left at $1.old"), host.trim(), path));
        await loadFile(path);
    });

    const doScan = () => run("scan", async () => {
        setScanned(await scanHost(host, port));
    });

    const doAddScanned = () => run("add-scanned", async () => {
        if (!scanned)
            return;
        await appendEntries(path, scanned.map(entry => entry.raw));
        setScanned(null);
        await loadFile(path);
    });

    const doRemoveEntry = () => run("remove-entry", async () => {
        if (!removingEntry)
            return;
        await removeEntry(path, removingEntry.raw);
        setRemovingEntry(null);
        await loadFile(path);
    });

    const doPurge = () => run("purge", async () => {
        const backup = await purgeAll(path);
        setConfirmPurge(false);
        setInfo(cockpit.format(_("All entries removed. The previous file was copied to $0"), backup));
        await loadFile(path);
    });

    const doLabel = () => run("label", async () => {
        setEntries(await labelHashedEntries(path, entries));
    });

    const doSaveRaw = () => run("save-raw", async () => {
        await writeKnownHosts(path, raw, content);
        await loadFile(path);
    });

    const doDeleteBackup = () => run("delete-backup", async () => {
        await deleteStaleBackup(path);
        setStaleBackup(false);
    });

    const doToggleTimer = () => run("timer", async () => {
        if (timer?.enabled) {
            await disableReport();
        } else {
            await validateSchedule(schedule);
            await enableReport(schedule, files.filter(f => f.exists).map(f => f.path));
        }
        await loadTimer();
    });

    const doApplySchedule = () => run("schedule", async () => {
        const next = await validateSchedule(schedule);
        await enableReport(schedule, files.filter(f => f.exists).map(f => f.path));
        setInfo(next ? cockpit.format(_("Next run: $0"), next) : null);
        await loadTimer();
    });

    const doRunNow = () => run("run-now", async () => {
        await runReportNow();
        await loadTimer();
    });

    const doJournal = () => run("journal", async () => {
        setJournal(await reportJournal());
    });

    if (loading)
        return <Spinner />;

    const hashedCount = entries.filter(entry => entry.hashed).length;
    const counts = report?.counts ?? {};

    return (
        <>
            {error && (
                <Alert variant="danger" title={_("Error")} isInline className="pf-v6-u-mb-md">{error}</Alert>
            )}
            {info && <Alert variant="info" title={info} isInline className="pf-v6-u-mb-md" />}

            <Card className="pf-v6-u-mb-lg">
                <CardTitle>{_("Known hosts")}</CardTitle>
                <CardBody>
                    <FormGroup label={_("File")} fieldId="ssh-known-hosts-file" className="pf-v6-u-mb-md">
                        <FormSelect
                            id="ssh-known-hosts-file"
                            value={path}
                            onChange={(_event, value) => selectFile(value)}
                        >
                            {files.map(file => (
                                <FormSelectOption
                                    key={file.path}
                                    value={file.path}
                                    label={file.exists
                                        ? `${file.label} — ${file.path}`
                                        : cockpit.format(_("$0 — $1 (does not exist yet)"), file.label, file.path)}
                                />
                            ))}
                        </FormSelect>
                    </FormGroup>

                    {hashedCount > 0 && (
                        <Alert
                            variant="info"
                            isInline
                            className="pf-v6-u-mb-md"
                            title={cockpit.format(_("$0 entries have hashed host names"), String(hashedCount))}
                        >
                            {_("Hashed names are HMAC-SHA1 and cannot be turned back into host names, so only the key type and fingerprint can be shown. Naming a host below still works, and known names from /etc/hosts and ssh_config can be tried against the hashes.")}
                            <div className="ssh-alert-actions">
                                <Button variant="secondary" onClick={doLabel} isLoading={busy === "label"} isDisabled={busy !== null}>
                                    {_("Try to label entries")}
                                </Button>
                            </div>
                        </Alert>
                    )}

                    {staleBackup && (
                        <Alert
                            variant="warning"
                            isInline
                            className="pf-v6-u-mb-md"
                            title={cockpit.format(_("$0.old still holds the removed entries"), path)}
                        >
                            {_("ssh-keygen writes a backup whenever it removes a host. Delete it if the point of removing the entries was to get rid of them.")}
                            <div className="ssh-alert-actions">
                                <Button variant="secondary" onClick={doDeleteBackup} isDisabled={busy !== null}>
                                    {_("Delete the backup")}
                                </Button>
                            </div>
                        </Alert>
                    )}

                    <Flex className="ssh-toolbar" gap={{ default: "gapMd" }} alignItems={{ default: "alignItemsFlexEnd" }}>
                        <FlexItem>
                            <FormGroup label={_("Host")} fieldId="ssh-host">
                                <TextInput
                                    id="ssh-host"
                                    value={host}
                                    onChange={(_event, value) => setHost(value)}
                                    placeholder="server.example.com"
                                />
                            </FormGroup>
                        </FlexItem>
                        <FlexItem>
                            <FormGroup label={_("Port")} fieldId="ssh-host-port">
                                <TextInput
                                    id="ssh-host-port"
                                    value={port}
                                    onChange={(_event, value) => setPort(value)}
                                    placeholder="22"
                                />
                            </FormGroup>
                        </FlexItem>
                        <FlexItem>
                            <Button variant="secondary" onClick={doFind} isDisabled={!host.trim() || busy !== null}>
                                {_("Find")}
                            </Button>
                        </FlexItem>
                        <FlexItem>
                            <Button
                                variant="secondary"
                                onClick={() => setConfirmRemoveHost(true)}
                                isDisabled={!host.trim() || busy !== null}
                            >
                                {_("Remove host")}
                            </Button>
                        </FlexItem>
                        <FlexItem>
                            <Button
                                variant="secondary"
                                onClick={doScan}
                                isLoading={busy === "scan"}
                                isDisabled={!host.trim() || busy !== null}
                            >
                                {_("Scan and add")}
                            </Button>
                        </FlexItem>
                        <FlexItem align={{ default: "alignRight" }}>
                            <Button
                                variant="danger"
                                onClick={() => setConfirmPurge(true)}
                                isDisabled={entries.length === 0 || busy !== null}
                            >
                                {_("Purge all")}
                            </Button>
                        </FlexItem>
                    </Flex>

                    <Table aria-label={_("Known hosts")} variant="compact">
                        <Thead>
                            <Tr>
                                <Th>{_("Host")}</Th>
                                <Th>{_("Key type")}</Th>
                                <Th>{_("Fingerprint")}</Th>
                                <Th>{_("Marker")}</Th>
                                <Th screenReaderText={_("Actions")} />
                            </Tr>
                        </Thead>
                        <Tbody>
                            {entries.length === 0
                                ? <Tr><Td colSpan={5}>{_("This file has no entries.")}</Td></Tr>
                                : entries.map(entry => (
                                    <Tr key={`${entry.lineNumber}-${entry.blob}`}>
                                        <Td>
                                            {entry.hashed
                                                ? (
                                                    <>
                                                        <Label color="grey" isCompact>{_("hashed")}</Label>
                                                        {entry.label && <> <span className="ssh-mono">{entry.label}</span></>}
                                                    </>
                                                )
                                                : <span className="ssh-mono">{entry.hostnames}</span>}
                                        </Td>
                                        <Td><Label isCompact>{entry.keyType}</Label></Td>
                                        <Td><span className="ssh-mono">{entry.fingerprint}</span></Td>
                                        <Td>
                                            {entry.marker && <Label color="orange" isCompact>{entry.marker}</Label>}
                                        </Td>
                                        <Td isActionCell>
                                            <Button
                                                variant="danger"
                                                isDisabled={busy !== null}
                                                onClick={() => setRemovingEntry(entry)}
                                            >
                                                {_("Remove")}
                                            </Button>
                                        </Td>
                                    </Tr>
                                ))}
                        </Tbody>
                    </Table>

                    <ExpandableSection
                        toggleText={_("Edit the file directly")}
                        isExpanded={rawOpen}
                        onToggle={(_event, expanded) => setRawOpen(expanded)}
                    >
                        <TextArea
                            id="ssh-known-hosts-raw"
                            rows={12}
                            value={raw}
                            onChange={(_event, value) => setRaw(value)}
                            aria-label={_("known_hosts contents")}
                        />
                        <div className="ssh-actions">
                            <Button
                                variant="secondary"
                                onClick={doSaveRaw}
                                isDisabled={raw === content || busy !== null}
                                isLoading={busy === "save-raw"}
                            >
                                {_("Save")}
                            </Button>
                        </div>
                    </ExpandableSection>
                </CardBody>
            </Card>

            <Card>
                <CardTitle>{_("Periodic check")}</CardTitle>
                <CardBody>
                    <Alert variant="info" isInline className="pf-v6-u-mb-md" title={_("This check never removes anything")}>
                        {_("Stored keys are compared against what each host presents now, and the result is recorded. Entries are never deleted automatically: a key that suddenly differs is exactly what an interception attack looks like, so it needs a person to decide.")}
                    </Alert>

                    <Flex className="ssh-toolbar" gap={{ default: "gapMd" }} alignItems={{ default: "alignItemsFlexEnd" }}>
                        <FlexItem>
                            <Switch
                                id="ssh-report-enabled"
                                label={_("Run automatically")}
                                isChecked={timer?.enabled ?? false}
                                isDisabled={busy !== null}
                                onChange={doToggleTimer}
                            />
                        </FlexItem>
                        <FlexItem>
                            <FormGroup label={_("Schedule")} fieldId="ssh-report-schedule">
                                <TextInput
                                    id="ssh-report-schedule"
                                    value={schedule}
                                    onChange={(_event, value) => setSchedule(value)}
                                    placeholder="daily"
                                />
                                <div className="ssh-provenance">
                                    {_("A systemd calendar expression, for example daily or Mon *-*-* 03:00:00.")}
                                </div>
                            </FormGroup>
                        </FlexItem>
                        <FlexItem>
                            <Button
                                variant="secondary"
                                onClick={doApplySchedule}
                                isDisabled={busy !== null || !timer?.enabled}
                                isLoading={busy === "schedule"}
                            >
                                {_("Apply schedule")}
                            </Button>
                        </FlexItem>
                        <FlexItem>
                            <Button
                                variant="secondary"
                                onClick={doRunNow}
                                isDisabled={busy !== null || !timer?.installed}
                                isLoading={busy === "run-now"}
                            >
                                {_("Run now")}
                            </Button>
                        </FlexItem>
                    </Flex>

                    {timer?.installed && (
                        <DescriptionList isHorizontal className="pf-v6-u-mb-md">
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Next run")}</DescriptionListTerm>
                                <DescriptionListDescription>{timer.nextRun || _("not scheduled")}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Last run")}</DescriptionListTerm>
                                <DescriptionListDescription>{timer.lastRun || _("never")}</DescriptionListDescription>
                            </DescriptionListGroup>
                        </DescriptionList>
                    )}

                    {report && (
                        <>
                            {counts.mismatch
                                ? (
                                    <Alert
                                        variant="danger"
                                        isInline
                                        className="pf-v6-u-mb-md"
                                        title={cockpit.format(
                                            _("$0 stored key(s) differ from the key the host presents now"),
                                            String(counts.mismatch))}
                                    >
                                        {_("This can mean the host was rebuilt or its keys were rotated — or that something is intercepting the connection. Confirm the new fingerprint out of band before replacing the entry.")}
                                    </Alert>
                                )
                                : null}

                            <Table aria-label={_("Check results")} variant="compact">
                                <Thead>
                                    <Tr>
                                        <Th>{_("Host")}</Th>
                                        <Th>{_("Key type")}</Th>
                                        <Th>{_("File")}</Th>
                                        <Th>{_("Result")}</Th>
                                    </Tr>
                                </Thead>
                                <Tbody>
                                    {report.findings.length === 0
                                        ? <Tr><Td colSpan={4}>{_("The last check found nothing to report.")}</Td></Tr>
                                        : report.findings.map((finding, index) => (
                                            <Tr key={`${finding.file}-${index}`}>
                                                <Td>
                                                    {finding.host || <span className="ssh-provenance">{_("hashed")}</span>}
                                                </Td>
                                                <Td>{finding.keyType}</Td>
                                                <Td><span className="ssh-provenance">{finding.file}</span></Td>
                                                <Td>
                                                    <Label
                                                        isCompact
                                                        color={finding.status === "mismatch"
                                                            ? "red"
                                                            : finding.status === "match" ? "green" : "grey"}
                                                    >
                                                        {STATUS_LABELS[finding.status] ?? finding.status}
                                                    </Label>
                                                </Td>
                                            </Tr>
                                        ))}
                                </Tbody>
                            </Table>
                            <div className="ssh-provenance pf-v6-u-mt-sm">
                                {cockpit.format(_("Last checked $0"), report.generated)}
                            </div>
                        </>
                    )}

                    <div className="ssh-actions">
                        <Button variant="link" onClick={doJournal} isDisabled={busy !== null} isInline>
                            {_("View log")}
                        </Button>
                    </div>
                    {journal !== null && <pre className="ssh-snippet">{journal || _("No log entries yet.")}</pre>}
                </CardBody>
            </Card>

            {scanned && (
                <Modal variant="medium" isOpen onClose={() => setScanned(null)}>
                    <ModalHeader title={cockpit.format(_("Keys presented by $0"), host.trim())} />
                    <ModalBody>
                        <Alert variant="warning" isInline className="pf-v6-u-mb-md" title={_("Check these fingerprints first")}>
                            {_("Scanning cannot verify anything. Compare the fingerprints against a source you trust, such as the host's console, before adding them.")}
                        </Alert>
                        <DescriptionList isHorizontal>
                            {scanned.map(entry => (
                                <DescriptionListGroup key={entry.blob}>
                                    <DescriptionListTerm>{entry.keyType}</DescriptionListTerm>
                                    <DescriptionListDescription className="ssh-mono">
                                        {entry.fingerprint}
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                            ))}
                        </DescriptionList>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="primary" onClick={doAddScanned} isLoading={busy === "add-scanned"}>
                            {_("The fingerprints match, add them")}
                        </Button>
                        <Button variant="link" onClick={() => setScanned(null)}>{_("Cancel")}</Button>
                    </ModalFooter>
                </Modal>
            )}

            {confirmRemoveHost && (
                <Modal variant="small" isOpen onClose={() => setConfirmRemoveHost(false)}>
                    <ModalHeader title={cockpit.format(_("Remove $0?"), host.trim())} />
                    <ModalBody>
                        {cockpit.format(
                            _("Every entry for $0 will be removed from $1. ssh-keygen leaves the previous file at $1.old."),
                            host.trim(), path)}
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={doRemoveHost} isLoading={busy === "remove-host"}>
                            {_("Remove")}
                        </Button>
                        <Button variant="link" onClick={() => setConfirmRemoveHost(false)}>{_("Cancel")}</Button>
                    </ModalFooter>
                </Modal>
            )}

            {removingEntry && (
                <Modal variant="medium" isOpen onClose={() => setRemovingEntry(null)}>
                    <ModalHeader title={_("Remove entry?")} />
                    <ModalBody>
                        <p>{_("Connecting to this host will ask you to accept its key again.")}</p>
                        <pre className="ssh-snippet">{removingEntry.raw}</pre>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={doRemoveEntry} isLoading={busy === "remove-entry"}>
                            {_("Remove")}
                        </Button>
                        <Button variant="link" onClick={() => setRemovingEntry(null)}>{_("Cancel")}</Button>
                    </ModalFooter>
                </Modal>
            )}

            {confirmPurge && (
                <Modal variant="small" isOpen onClose={() => setConfirmPurge(false)}>
                    <ModalHeader title={_("Remove every entry?")} />
                    <ModalBody>
                        {cockpit.format(
                            _("All $0 entries will be removed from $1. A copy is kept at $1.cockpit-bak. Every host will have to be trusted again on the next connection."),
                            String(entries.length), path)}
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={doPurge} isLoading={busy === "purge"}>
                            {_("Remove all")}
                        </Button>
                        <Button variant="link" onClick={() => setConfirmPurge(false)}>{_("Cancel")}</Button>
                    </ModalFooter>
                </Modal>
            )}
        </>
    );
};
