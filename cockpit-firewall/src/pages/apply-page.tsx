import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";

import cockpit from 'cockpit';

import { ConfigurationPageProps, LoadedHostState } from '../app.jsx';
import { PageHeader } from '../components.jsx';
import { ForeignTable, foreignTableWarnings } from '../coexistence.js';
import {
    ForwardingState,
    applyRuleset,
    confirmRuleset,
    detectOtherFirewallManagers,
    listForeignTables,
    readForwardingState,
    readNftablesConfigurationFile,
    readTransactionStatus,
    revertRuleset,
} from '../firewall-backend.js';
import { ApplyPlan, isUpToDate, planApply } from '../firewall-state.js';
import { FirewallConfiguration, requiresForwarding } from '../model.js';
import { NFTABLES_CONFIGURATION_PATH, hasFlushRuleset, tablesDefinedInFile } from '../nftables-file.js';
import { ConfigurationError } from '../ruleset.js';
import { diffLines } from '../text-diff.js';
import { BACKUP_DIRECTORY, SYSCTL_PATH, TransactionStatus } from '../transaction.js';

const _ = cockpit.gettext;

interface RuntimeState {
    forwarding: ForwardingState | null;
    otherManagers: string[];
    foreignTables: ForeignTable[];
    transaction: TransactionStatus;
}

function plan(fileText: string | null, configuration: FirewallConfiguration, removeStockFilterTable: boolean):
    { applyPlan: ApplyPlan | null; problems: string[] } {
    try {
        return { applyPlan: planApply(fileText, configuration, removeStockFilterTable), problems: [] };
    } catch (error) {
        if (error instanceof ConfigurationError)
            return { applyPlan: null, problems: error.problems };
        return { applyPlan: null, problems: [String((error as Error)?.message ?? error)] };
    }
}

const DiffView = ({ before, after }: { before: string; after: string }) => (
    <pre className="fw-diff">
        {diffLines(before, after).map((line, index) => (
            <div key={index} className={`fw-diff-${line.kind}`}>
                {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}{line.text}
            </div>
        ))}
    </pre>
);

interface ApplyPageProps {
    configuration: ConfigurationPageProps["configuration"];
    hostState: LoadedHostState;
    /** Re-reads the host; `resetDraft` discards the edited configuration. */
    onReload: (resetDraft: boolean) => Promise<void>;
}

export const ApplyPage = ({ configuration, hostState, onReload }: ApplyPageProps) => {
    const [runtime, setRuntime] = useState<RuntimeState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [secondsLeft, setSecondsLeft] = useState(0);
    const [removeStockFilterTable, setRemoveStockFilterTable] = useState(false);

    const { files, derived } = hostState;
    const removeStock = removeStockFilterTable && derived.stockFilterTableRemovable;
    const { applyPlan, problems } = useMemo(() => plan(files.fileText, configuration, removeStock),
                                            [files.fileText, configuration, removeStock]);
    const forwardingNeeded = requiresForwarding(configuration);
    const draftChanged = useMemo(() => JSON.stringify(configuration) !== JSON.stringify(derived.initialConfiguration),
                                 [configuration, derived.initialConfiguration]);

    const refresh = useCallback(async () => {
        const [forwarding, otherManagers, transaction, foreignTables] = await Promise.all([
            readForwardingState().catch(() => null),
            detectOtherFirewallManagers(),
            readTransactionStatus(),
            listForeignTables().catch(() => []),
        ]);
        setRuntime({ forwarding, otherManagers, foreignTables, transaction });
        if (transaction.state === "pending")
            setSecondsLeft(transaction.secondsLeft);
    }, []);

    useEffect(() => { refresh() }, [refresh]);

    const pending = runtime?.transaction.state === "pending";

    useEffect(() => {
        if (!pending)
            return;
        const timer = window.setInterval(() => {
            setSecondsLeft(previous => {
                if (previous <= 1) {
                    refresh().then(() => onReload(false));
                    return 0;
                }
                return previous - 1;
            });
        }, 1000);
        return () => window.clearInterval(timer);
    }, [pending, refresh, onReload]);

    const run = async (action: () => Promise<void>, successNotice: string | null, resetDraft: boolean) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await action();
            if (successNotice)
                setNotice(successNotice);
        } catch (actionError) {
            setError(String((actionError as Error)?.message ?? actionError));
        }
        await refresh();
        await onReload(resetDraft);
        setBusy(false);
    };

    const apply = () => applyPlan && run(async () => {
        const currentFile = await readNftablesConfigurationFile();
        if (currentFile !== files.fileText)
            throw new Error(cockpit.format(_("$0 changed since this page read it. Review the changes again, then apply."), NFTABLES_CONFIGURATION_PATH));
        await applyRuleset(applyPlan.liveText, applyPlan.candidateFile, applyPlan.enableForwarding, applyPlan.removeStockFilterTable);
    }, null, false);
    const pendingToken = runtime?.transaction.state === "pending" ? runtime.transaction.token : "";
    const confirm = () => run(() => confirmRuleset(pendingToken),
                              cockpit.format(_("Changes kept and written to $0, which nftables.service loads at boot. The previous file is in $1."),
                                             NFTABLES_CONFIGURATION_PATH, BACKUP_DIRECTORY),
                              true);
    const revert = () => run(() => revertRuleset(pendingToken), _("Reverted to the previous rules."), false);

    const upToDate = applyPlan !== null && isUpToDate(files, derived, applyPlan);
    const transactionState = runtime?.transaction.state;
    const fileTables = new Set(tablesDefinedInFile(files.fileText ?? ""));
    const flushedTables = files.fileText && hasFlushRuleset(files.fileText)
        ? (runtime?.foreignTables ?? []).map(table => `${table.family} ${table.name}`).filter(table => !fileTables.has(table))
        : [];
    const foreignWarnings = foreignTableWarnings(runtime?.foreignTables ?? []);

    return (
        <>
            <PageHeader
                title={_("Firewall rules")}
                description={cockpit.format(_("Stored in $0 as nftables table inet cockpit_fw. Everything else in that file and other tables are left unchanged."), NFTABLES_CONFIGURATION_PATH)}
                actions={
                    <>
                        <Button variant="secondary" onClick={() => run(async () => undefined, null, true)} isDisabled={busy || pending || !draftChanged}>
                            {_("Discard changes")}
                        </Button>{" "}
                        <Button variant="primary" onClick={apply} isDisabled={busy || !applyPlan || pending || upToDate} isLoading={busy && !pending}>
                            {_("Apply")}
                        </Button>
                    </>
                }
            />

            {error && <Alert variant="danger" isInline title={_("Operation failed")} className="fw-alert"><pre className="fw-pre-wrap">{error}</pre></Alert>}
            {notice && <Alert variant="success" isInline title={notice} className="fw-alert" />}
            {transactionState === "rolled-back" && !notice && (
                <Alert variant="warning" isInline className="fw-alert" title={_("The last applied change was rolled back because it was not confirmed in time.")} />
            )}
            {transactionState === "rollback-failed" && (
                <Alert variant="danger" isInline className="fw-alert" title={_("Rolling back the last change failed. Check the loaded rules below.")} />
            )}
            {draftChanged && (
                <Alert variant="info" isInline className="fw-alert" title={_("Unapplied changes")}>
                    {_("Edits are kept only in this browser tab until applied. Reloading the page discards them.")}
                </Alert>
            )}
            {derived.source === "legacy" && (
                <Alert variant="info" isInline className="fw-alert" title={_("Configuration of an earlier version found")}>
                    {cockpit.format(_("It was loaded from $0. Apply and keep the changes to move it into $1; the old files and cockpit-firewall.service are then moved to $2."),
                                    "/etc/cockpit-firewall/config.json", NFTABLES_CONFIGURATION_PATH, BACKUP_DIRECTORY)}
                </Alert>
            )}
            {derived.source !== "legacy" && files.legacyFilesPresent && (
                <Alert variant="info" isInline className="fw-alert" title={_("Files of an earlier version found")}>
                    {cockpit.format(_("Apply and keep the changes to remove cockpit-firewall.service and move the old files to $0."), BACKUP_DIRECTORY)}
                </Alert>
            )}
            {derived.drift && derived.source !== "legacy" && (
                <Alert variant="warning" isInline className="fw-alert" title={cockpit.format(_("The loaded rules differ from $0"), NFTABLES_CONFIGURATION_PATH)}>
                    {derived.source === "file"
                        ? _("The editor shows the file. Apply loads it, replacing the loaded table inet cockpit_fw.")
                        : _("The file has no rules of this app; the editor shows the loaded table. Apply writes it to the file.")}
                </Alert>
            )}
            {(derived.fileRuleset?.unrecognized.length ?? 0) > 0 && (
                <Alert variant="warning" isInline className="fw-alert" title={_("Parts of table inet cockpit_fw are not understood and are removed on the next apply")}>
                    <ul className="fw-bullets">{derived.fileRuleset!.unrecognized.map(item => <li key={item}>{item}</li>)}</ul>
                </Alert>
            )}
            {problems.length > 0 && (
                <Alert variant="danger" isInline title={_("The configuration has errors and cannot be applied")} className="fw-alert">
                    <ul className="fw-bullets">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>
                </Alert>
            )}
            {runtime && runtime.otherManagers.length > 0 && (
                <Alert
                    variant="warning" isInline className="fw-alert"
                    title={cockpit.format(_("Another firewall manager is running: $0"), runtime.otherManagers.join(", "))}
                >
                    {_("Its tables are evaluated independently: a drop in any base chain on the same hook still drops the packet, and it may flush the whole ruleset on reload. Prefer a single manager.")}
                </Alert>
            )}
            {foreignWarnings.length > 0 && (
                <Alert variant="warning" isInline className="fw-alert" title={_("Other tables drop traffic on the same hooks")}>
                    <ul className="fw-bullets">{foreignWarnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
                    {_("An accept here does not override a drop there. See Other tables.")}
                </Alert>
            )}
            {flushedTables.length > 0 && (
                <Alert variant="warning" isInline className="fw-alert" title={cockpit.format(_("$0 starts with flush ruleset"), NFTABLES_CONFIGURATION_PATH)}>
                    {cockpit.format(_("Restarting nftables.service or rebooting removes loaded tables the file does not define: $0. Their owners must recreate them (for example fail2ban does on restart). Apply never reloads the whole file."), flushedTables.join(", "))}
                </Alert>
            )}
            {derived.stockFilterTableRemovable && (
                <Card isCompact className="fw-card">
                    <CardTitle>{_("Stock table inet filter")}</CardTitle>
                    <CardBody>
                        <Checkbox
                            id="remove-stock-filter-table"
                            isChecked={removeStockFilterTable}
                            onChange={(_event, checked) => setRemoveStockFilterTable(checked)}
                            isDisabled={pending}
                            label={_("Remove the empty accept-all table inet filter shipped by the distribution")}
                            description={cockpit.format(_("It has no rules and accepts everything. Apply deletes it from the kernel (restored on rollback) and from $0."), NFTABLES_CONFIGURATION_PATH)}
                        />
                    </CardBody>
                </Card>
            )}

            <Card isCompact className="fw-card">
                <CardTitle>{_("IPv4 forwarding")}</CardTitle>
                <CardBody>
                    {runtime?.forwarding && (
                        <>
                            <Label color={runtime.forwarding.enabled ? "green" : "grey"} isCompact>
                                {runtime.forwarding.enabled ? _("net.ipv4.ip_forward = 1") : _("net.ipv4.ip_forward = 0")}
                            </Label>{" "}
                            <span className="fw-muted">
                                {runtime.forwarding.persistedByThisApplication
                                    ? cockpit.format(_("Persisted by this app in $0."), SYSCTL_PATH)
                                    : _("Not persisted by this app.")}
                            </span>
                        </>
                    )}
                    <p className="fw-muted">
                        {forwardingNeeded
                            ? cockpit.format(_("Forward or NAT rules exist: applying enables IPv4 forwarding, and confirming persists it in $0."), SYSCTL_PATH)
                            : _("No forward or NAT rules: forwarding is not changed by this app (its sysctl file is removed on confirm).")}
                    </p>
                </CardBody>
            </Card>

            <Card isCompact className="fw-card">
                <CardTitle>{upToDate ? cockpit.format(_("$0 (applied)"), NFTABLES_CONFIGURATION_PATH) : cockpit.format(_("Changes to $0"), NFTABLES_CONFIGURATION_PATH)}</CardTitle>
                <CardBody>
                    {applyPlan && (upToDate
                        ? <pre className="fw-diff">{applyPlan.candidateFile}</pre>
                        : <DiffView before={files.fileText ?? ""} after={applyPlan.candidateFile} />)}
                    <p className="fw-muted">
                        {cockpit.format(_("Apply checks the new file with nft -c and loads only table inet cockpit_fw, atomically. It rolls back automatically after 60 seconds unless you keep the changes. Only then is $0 written; nftables.service loads it at boot."), NFTABLES_CONFIGURATION_PATH)}
                    </p>
                </CardBody>
            </Card>

            <ExpandableSection toggleText={_("Currently loaded table inet cockpit_fw (with counters)")}>
                <Button variant="link" onClick={() => onReload(false)}>{_("Refresh")}</Button>
                <pre className="fw-diff">{files.liveOwnTable || _("Not loaded.")}</pre>
            </ExpandableSection>

            <Modal isOpen={pending} variant="small" aria-labelledby="confirm-title" onClose={() => undefined}>
                <ModalHeader title={_("Keep these firewall changes?")} labelId="confirm-title" titleIconVariant="warning" />
                <ModalBody>
                    {cockpit.format(_("The new rules are active. They will be rolled back automatically in $0 seconds unless you keep them. If this page stops responding, wait and reconnect."), secondsLeft)}
                </ModalBody>
                <ModalFooter>
                    <Button variant="primary" onClick={confirm} isDisabled={busy}>{_("Keep changes")}</Button>
                    <Button variant="secondary" onClick={revert} isDisabled={busy}>{_("Revert now")}</Button>
                </ModalFooter>
            </Modal>
        </>
    );
};
