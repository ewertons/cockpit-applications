import React, { useEffect, useMemo, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";

import cockpit from 'cockpit';

import { DiffView, ErrorAlert, WarningList } from '../components.jsx';
import { ApplyError, applyConfiguration, checkConfiguration, errorMessage } from '../samba-backend.js';
import { parseConfiguration } from '../smb-conf.js';
import { ApplyResult, TestparmResult } from '../transaction.js';
import { validateDocument } from '../validation.js';
import { PathInformation, securityWarnings } from '../warnings.js';

const _ = cockpit.gettext;

/** A change waiting for review: the full new smb.conf text. */
export interface PendingChange {
    title: string;
    text: string;
}

const TestparmMessages = ({ result }: { result: TestparmResult }) => (
    <>
        {result.unknownParameters.length > 0 &&
            <Alert variant="warning" isInline className="smb-alert" title={_("Unknown parameters (Samba ignores them)")}>
                <ul className="smb-bullets">{result.unknownParameters.map(name => <li key={name}>{name}</li>)}</ul>
            </Alert>}
        {result.messages.length > 0 &&
            <Alert variant={result.passed ? "info" : "danger"} isInline className="smb-alert" title={result.passed ? _("testparm messages") : _("testparm rejected the configuration")}>
                <pre className="smb-pre-wrap">{result.messages.join("\n")}</pre>
            </Alert>}
    </>
);

/**
 * Shows the diff, testparm's verdict and the security warnings of a change,
 * and applies it through the safe transaction.
 */
export const ReviewDialog = ({ change, currentText, currentHash, paths, onClose, onApplied }: {
    change: PendingChange;
    currentText: string;
    currentHash: string;
    paths: Record<string, PathInformation>;
    onClose: () => void;
    onApplied: () => void;
}) => {
    const [check, setCheck] = useState<TestparmResult | null>(null);
    const [checkError, setCheckError] = useState<string | null>(null);
    const [applying, setApplying] = useState(false);
    const [applyError, setApplyError] = useState<string | null>(null);
    const [outdated, setOutdated] = useState(false);
    const [result, setResult] = useState<ApplyResult | null>(null);

    const document = useMemo(() => parseConfiguration(change.text), [change.text]);
    const problems = useMemo(() => validateDocument(document), [document]);
    const warnings = useMemo(() => securityWarnings(document, paths), [document, paths]);
    const unchanged = change.text === currentText;

    useEffect(() => {
        let cancelled = false;
        checkConfiguration(change.text)
                .then(checked => { if (!cancelled) setCheck(checked); })
                .catch(error => { if (!cancelled) setCheckError(errorMessage(error)); });
        return () => { cancelled = true };
    }, [change.text]);

    const apply = () => {
        setApplying(true);
        setApplyError(null);
        applyConfiguration(change.text, currentHash)
                .then(applied => {
                    setResult(applied);
                    onApplied();
                })
                .catch(error => {
                    if (error instanceof ApplyError && error.kind === "rejected" && error.testparm)
                        setCheck(error.testparm);
                    if (error instanceof ApplyError && error.kind === "changed")
                        setOutdated(true);
                    setApplyError(errorMessage(error));
                })
                .finally(() => setApplying(false));
    };

    const canApply = !unchanged && !result && !outdated && problems.length === 0 && check?.passed === true && !applying;

    let body;
    if (result) {
        const failedReloads = result.reloads.filter(reload => reload.state === "failed");
        body = (
            <>
                <Alert variant="success" isInline className="smb-alert" title={_("Configuration applied")}>
                    <p>{result.backupName ? cockpit.format(_("Previous file saved as $0."), result.backupName) : _("There was no previous file to back up.")}</p>
                    <ul className="smb-bullets">
                        {result.reloads.map(reload => (
                            <li key={reload.daemon}>
                                {reload.daemon}: {reload.state === "ok" ? _("reloaded") : reload.state === "not-running" ? _("not running") : _("reload failed")}
                            </li>
                        ))}
                    </ul>
                </Alert>
                {failedReloads.length > 0 && <Alert variant="warning" isInline className="smb-alert" title={_("Restart the service to load the new configuration.")} />}
                <TestparmMessages result={result.testparm} />
            </>
        );
    } else {
        body = (
            <>
                {unchanged && <Alert variant="info" isInline className="smb-alert" title={_("There are no changes.")} />}
                {problems.length > 0 &&
                    <Alert variant="danger" isInline className="smb-alert" title={_("The configuration cannot be written")}>
                        <ul className="smb-bullets">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>
                    </Alert>}
                {outdated &&
                    <Alert variant="danger" isInline className="smb-alert" title={_("smb.conf was changed by someone else since it was loaded. Nothing was written; close this dialog and redo the change.")} />}
                <ErrorAlert error={outdated ? null : applyError} title={_("Applying failed; the previous configuration is still in place")} />
                <ErrorAlert error={checkError} title={_("Cannot run testparm")} />
                {!check && !checkError && <p className="smb-muted"><Spinner size="sm" /> {_("Checking with testparm…")}</p>}
                {check?.passed && <Alert variant="success" isInline isPlain className="smb-alert" title={_("testparm accepts the configuration.")} />}
                {check && <TestparmMessages result={check} />}
                <ExpandableSection toggleText={cockpit.format(_("Security notes ($0)"), warnings.length)} isIndented>
                    <WarningList warnings={warnings} emptyText={_("No security notes.")} />
                </ExpandableSection>
                <h3 className="smb-subtitle">{_("Changes to /etc/samba/smb.conf")}</h3>
                <DiffView before={currentText} after={change.text} />
            </>
        );
    }

    return (
        <Modal isOpen variant="large" aria-labelledby="review-title" onClose={applying ? undefined : onClose}>
            <ModalHeader title={change.title} labelId="review-title" />
            <ModalBody>{body}</ModalBody>
            <ModalFooter>
                {!result && <Button variant="primary" isDisabled={!canApply} isLoading={applying} onClick={apply}>{_("Apply")}</Button>}
                <Button variant={result ? "primary" : "link"} isDisabled={applying} onClick={onClose}>{result ? _("Close") : _("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
