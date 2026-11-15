import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";

import cockpit from 'cockpit';

import { PageHeader } from '../components.jsx';
import { foreignTableWarnings } from '../coexistence.js';
import {
    ForwardingState,
    applyRuleset,
    confirmRuleset,
    detectOtherFirewallManagers,
    listForeignTables,
    readForwardingState,
    readLiveOwnTables,
    readPersistedRuleset,
    readTransactionStatus,
    revertRuleset,
} from '../firewall-backend.js';
import { FirewallConfiguration, requiresForwarding } from '../model.js';
import { ConfigurationError, GeneratedRuleset, generateRuleset } from '../ruleset.js';
import { diffLines } from '../text-diff.js';
import { PERSISTED_RULESET_PATH, SYSCTL_PATH, TransactionStatus } from '../transaction.js';

const _ = cockpit.gettext;

interface HostState {
    persistedRuleset: string;
    liveTables: string;
    forwarding: ForwardingState | null;
    otherManagers: string[];
    foreignWarnings: string[];
    transaction: TransactionStatus;
}

function generate(configuration: FirewallConfiguration): { ruleset: GeneratedRuleset | null; problems: string[] } {
    try {
        return { ruleset: generateRuleset(configuration), problems: [] };
    } catch (error) {
        if (error instanceof ConfigurationError)
            return { ruleset: null, problems: error.problems };
        return { ruleset: null, problems: [String(error)] };
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

export const ApplyPage = ({ configuration }: { configuration: FirewallConfiguration }) => {
    const [hostState, setHostState] = useState<HostState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [secondsLeft, setSecondsLeft] = useState(0);

    const { ruleset, problems } = useMemo(() => generate(configuration), [configuration]);
    const forwardingNeeded = requiresForwarding(configuration);

    const refresh = useCallback(async () => {
        const [persistedRuleset, liveTables, forwarding, otherManagers, transaction] = await Promise.all([
            readPersistedRuleset().catch(() => ""),
            readLiveOwnTables().catch(() => ""),
            readForwardingState().catch(() => null),
            detectOtherFirewallManagers(),
            readTransactionStatus(),
        ]);
        const foreignWarnings = await listForeignTables().then(foreignTableWarnings)
                .catch(() => []);
        setHostState({ persistedRuleset, liveTables, forwarding, otherManagers, foreignWarnings, transaction });
        if (transaction.state === "pending")
            setSecondsLeft(transaction.secondsLeft);
    }, []);

    useEffect(() => { refresh() }, [refresh]);

    const pending = hostState?.transaction.state === "pending";

    useEffect(() => {
        if (!pending)
            return;
        const timer = window.setInterval(() => {
            setSecondsLeft(previous => {
                if (previous <= 1) {
                    refresh();
                    return 0;
                }
                return previous - 1;
            });
        }, 1000);
        return () => window.clearInterval(timer);
    }, [pending, refresh]);

    const run = async (action: () => Promise<void>, successNotice: string | null) => {
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
        setBusy(false);
    };

    const apply = () => ruleset && run(() => applyRuleset(ruleset.text, forwardingNeeded), null);
    const confirm = () => run(() => confirmRuleset(forwardingNeeded),
                              cockpit.format(_("Changes kept and saved to $0. They are loaded at boot."), PERSISTED_RULESET_PATH));
    const revert = () => run(revertRuleset, _("Reverted to the previous rules."));

    const unchanged = ruleset !== null && hostState !== null && hostState.persistedRuleset === ruleset.text;
    const transactionState = hostState?.transaction.state;

    return (
        <>
            <PageHeader
                title={_("Firewall rules")}
                description={_("nftables tables inet cockpit_fw and ip cockpit_fw_nat. Other tables are never modified.")}
                actions={
                    <Button variant="primary" onClick={apply} isDisabled={busy || !ruleset || pending || unchanged} isLoading={busy && !pending}>
                        {_("Apply")}
                    </Button>
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
            {problems.length > 0 && (
                <Alert variant="danger" isInline title={_("The configuration has errors and cannot be applied")} className="fw-alert">
                    <ul className="fw-bullets">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>
                </Alert>
            )}
            {ruleset && ruleset.warnings.length > 0 && (
                <Alert variant="warning" isInline title={_("Warnings")} className="fw-alert">
                    <ul className="fw-bullets">{ruleset.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
                </Alert>
            )}
            {hostState && hostState.otherManagers.length > 0 && (
                <Alert
                    variant="warning" isInline className="fw-alert"
                    title={cockpit.format(_("Another firewall manager is running: $0"), hostState.otherManagers.join(", "))}
                >
                    {_("Its tables are evaluated independently: a drop in any base chain on the same hook still drops the packet, and it may flush the whole ruleset on reload. Prefer a single manager.")}
                </Alert>
            )}
            {hostState && hostState.foreignWarnings.length > 0 && (
                <Alert variant="warning" isInline className="fw-alert" title={_("Other tables drop traffic on the same hooks")}>
                    <ul className="fw-bullets">{hostState.foreignWarnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
                    {_("An accept here does not override a drop there. See Other tables.")}
                </Alert>
            )}

            <Card isCompact className="fw-card">
                <CardTitle>{_("IPv4 forwarding")}</CardTitle>
                <CardBody>
                    {hostState?.forwarding && (
                        <>
                            <Label color={hostState.forwarding.enabled ? "green" : "grey"} isCompact>
                                {hostState.forwarding.enabled ? _("net.ipv4.ip_forward = 1") : _("net.ipv4.ip_forward = 0")}
                            </Label>{" "}
                            <span className="fw-muted">
                                {hostState.forwarding.persistedByThisApplication
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
                <CardTitle>{unchanged ? _("Ruleset (applied)") : _("Pending changes")}</CardTitle>
                <CardBody>
                    {ruleset && hostState && (unchanged
                        ? <pre className="fw-diff">{ruleset.text}</pre>
                        : <DiffView before={hostState.persistedRuleset} after={ruleset.text} />)}
                    <p className="fw-muted">
                        {cockpit.format(_("Apply checks the ruleset with nft -c, loads it atomically and rolls back automatically after 60 seconds unless confirmed. Only confirmed rules are saved to $0 and loaded at boot by cockpit-firewall.service (ordered after nftables.service)."), PERSISTED_RULESET_PATH)}
                    </p>
                </CardBody>
            </Card>

            <ExpandableSection toggleText={_("Currently loaded tables (with counters)")}>
                <Button variant="link" onClick={refresh}>{_("Refresh")}</Button>
                <pre className="fw-diff">{hostState?.liveTables || _("Not loaded.")}</pre>
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
