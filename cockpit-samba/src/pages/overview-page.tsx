import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";

import cockpit from 'cockpit';

import { ConfigurationPageProps } from '../app.jsx';
import { ErrorAlert, PageHeader, SimpleTable, WarningList } from '../components.jsx';
import { listShareNames } from '../model.js';
import { checkConfiguration, errorMessage, readSambaVersion, readUnitStates, runUnitAction } from '../samba-backend.js';
import { UnitAction, UnitState } from '../services.js';
import { GLOBAL_SECTION, getParameter, getParameterValues } from '../smb-conf.js';
import { TestparmResult } from '../transaction.js';
import { securityWarnings } from '../warnings.js';

const _ = cockpit.gettext;

const STATE_COLOR: Record<string, "green" | "red" | "grey" | "orange"> = { active: "green", failed: "red", activating: "orange", deactivating: "orange" };

const UnitRow = ({ unit, busy, onAction }: { unit: UnitState; busy: boolean; onAction: (action: UnitAction) => void }) => {
    const active = unit.activeState === "active";
    const enabled = unit.unitFileState === "enabled";
    return (
        <span className="smb-row-actions">
            <Button variant="secondary" size="sm" isDisabled={busy} onClick={() => onAction(active ? "stop" : "start")}>{active ? _("Stop") : _("Start")}</Button>
            <Button variant="secondary" size="sm" isDisabled={busy || !active} onClick={() => onAction("restart")}>{_("Restart")}</Button>
            <Button variant="secondary" size="sm" isDisabled={busy || unit.unitFileState === "masked"} onClick={() => onAction(enabled ? "disable" : "enable")}>
                {enabled ? _("Disable at boot") : _("Enable at boot")}
            </Button>
        </span>
    );
};

export const OverviewPage = ({ snapshot, document, paths }: ConfigurationPageProps) => {
    const [units, setUnits] = useState<UnitState[] | null>(null);
    const [version, setVersion] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [check, setCheck] = useState<TestparmResult | null>(null);

    const loadUnits = useCallback(() => {
        readUnitStates().then(setUnits, loadError => setError(errorMessage(loadError)));
    }, []);

    useEffect(() => {
        loadUnits();
        readSambaVersion().then(setVersion);
    }, [loadUnits]);

    useEffect(() => {
        if (snapshot.exists)
            checkConfiguration(snapshot.text).then(setCheck, () => setCheck(null));
    }, [snapshot]);

    const act = (unit: string, action: UnitAction) => {
        setBusy(true);
        setError(null);
        runUnitAction(unit, action)
                .catch(actionError => setError(errorMessage(actionError)))
                .finally(() => {
                    setBusy(false);
                    loadUnits();
                });
    };

    const installed = (units ?? []).filter(unit => unit.installed);
    const domainController = installed.find(unit => unit.unit === "samba-ad-dc.service" && unit.activeState === "active");
    const unitRows = installed.map(unit => [
        unit.unit,
        <Label key="state" isCompact color={STATE_COLOR[unit.activeState] ?? "grey"}>{unit.activeState} ({unit.subState})</Label>,
        unit.unitFileState,
        <UnitRow key="actions" unit={unit} busy={busy} onAction={action => act(unit.unit, action)} />,
    ]);
    const warnings = securityWarnings(document, paths);
    const includes = getParameterValues(document, GLOBAL_SECTION, "include");

    return (
        <>
            <PageHeader
                title={_("Samba file server")}
                description={version || _("Samba is not installed.")}
                actions={<Button variant="secondary" onClick={loadUnits}>{_("Refresh")}</Button>}
            />
            <ErrorAlert error={error} />
            {domainController &&
                <Alert variant="warning" isInline className="smb-alert" title={_("This server runs as an Active Directory domain controller (samba-ad-dc). This page manages a standalone file server; review changes carefully.")} />}
            {check && !check.passed &&
                <Alert variant="danger" isInline className="smb-alert" title={_("testparm reports errors in the current smb.conf")}>
                    <pre className="smb-pre-wrap">{check.messages.join("\n")}</pre>
                </Alert>}
            {check && check.unknownParameters.length > 0 &&
                <Alert variant="warning" isInline className="smb-alert" title={cockpit.format(_("Unknown parameters in smb.conf: $0"), check.unknownParameters.join(", "))} />}
            {includes.length > 0 &&
                <Alert variant="info" isInline className="smb-alert" title={cockpit.format(_("smb.conf includes other files ($0). Settings in them are not shown here."), includes.join(", "))} />}
            <Card isCompact className="smb-card">
                <CardTitle>{_("Services")}</CardTitle>
                <CardBody>
                    <SimpleTable headers={[_("Unit"), _("State"), _("At boot"), ""]} rows={unitRows} emptyText={units === null ? _("Loading…") : _("No Samba services are installed.")} />
                    {units && !installed.some(unit => unit.unit === "samba-ad-dc.service") &&
                        <p className="smb-muted">{_("samba-ad-dc is not installed (standalone file server).")}</p>}
                </CardBody>
            </Card>
            <Card isCompact className="smb-card">
                <CardTitle>{_("Summary")}</CardTitle>
                <CardBody>
                    <SimpleTable
                        headers={[_("Setting"), _("Value")]}
                        rows={[
                            [_("Workgroup"), getParameter(document, GLOBAL_SECTION, "workgroup") ?? "WORKGROUP"],
                            [_("Server min protocol"), getParameter(document, GLOBAL_SECTION, "server min protocol") ?? _("default (SMB2_02)")],
                            [_("Shares"), listShareNames(document).join(", ") || _("none")],
                        ]}
                        emptyText=""
                    />
                </CardBody>
            </Card>
            <Card isCompact className="smb-card">
                <CardTitle>{_("Security notes")}</CardTitle>
                <CardBody>
                    <WarningList warnings={warnings} emptyText={_("No security notes for the current configuration.")} />
                </CardBody>
            </Card>
        </>
    );
};
