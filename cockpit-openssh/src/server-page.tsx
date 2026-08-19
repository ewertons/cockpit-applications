import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertActionLink } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { EmptyState, EmptyStateActions, EmptyStateBody, EmptyStateFooter } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";

import cockpit from 'cockpit';

import {
    ConfigScan, DROPIN, EffectiveConfig, HostKey, ManagedKeyword, ManagedSettings,
    PreflightWarning, ServiceState,
    applyConfig, armRollback, cancelRollback, detectPackageManager, detectServiceUnit,
    disableService, effectiveValues, emptySettings, enableService, getEffectiveConfig,
    getServiceState, hostKeyFingerprints, installServerPackage, one, parseSettings, preflight,
    prefillSettings, provenanceFor, readDropIn, reloadService, restartService, restartSocket,
    revertConfig, scanConfig, serializeSettings, settingsEqual, sshdBinary, startService,
    stopService, supportsIncludes, validateConfig, withList, withOne,
} from './openssh.js';
import { authorizedKeysPathFor, currentUserGroups, listUsers, readKeys } from './authorized-keys.js';

const _ = cockpit.gettext;

// Long enough to open a second SSH session and confirm the change still works.
const ROLLBACK_SECONDS = 120;

interface FieldDef {
    keyword: ManagedKeyword;
    label: string;
    kind: "text" | "choice" | "lines";
    choices?: string[];
    helper?: string;
}

const YES_NO = ["", "yes", "no"];

const FIELDS: FieldDef[] = [
    { keyword: "Port", label: _("Port"), kind: "text" },
    {
        keyword: "ListenAddress",
        label: _("Listen addresses"),
        kind: "lines",
        helper: _("One address per line, for example 0.0.0.0 or 192.0.2.1:22."),
    },
    {
        keyword: "PermitRootLogin",
        label: _("Permit root login"),
        kind: "choice",
        choices: ["", "yes", "no", "prohibit-password", "forced-commands-only"],
    },
    { keyword: "PasswordAuthentication", label: _("Password authentication"), kind: "choice", choices: YES_NO },
    { keyword: "PubkeyAuthentication", label: _("Public key authentication"), kind: "choice", choices: YES_NO },
    {
        keyword: "KbdInteractiveAuthentication",
        label: _("Keyboard-interactive authentication"),
        kind: "choice",
        choices: YES_NO,
        helper: _("With UsePAM yes this is what still offers a password prompt after PasswordAuthentication is turned off."),
    },
    { keyword: "PermitEmptyPasswords", label: _("Permit empty passwords"), kind: "choice", choices: YES_NO },
    { keyword: "X11Forwarding", label: _("X11 forwarding"), kind: "choice", choices: YES_NO },
    {
        keyword: "AllowTcpForwarding",
        label: _("TCP forwarding"),
        kind: "choice",
        choices: ["", "yes", "no", "local", "remote"],
    },
    { keyword: "MaxAuthTries", label: _("Maximum authentication attempts"), kind: "text" },
    { keyword: "LoginGraceTime", label: _("Login grace time"), kind: "text" },
    { keyword: "ClientAliveInterval", label: _("Client alive interval"), kind: "text" },
    { keyword: "ClientAliveCountMax", label: _("Client alive count max"), kind: "text" },
    { keyword: "AllowUsers", label: _("Allow users"), kind: "text", helper: _("Space-separated list.") },
    { keyword: "AllowGroups", label: _("Allow groups"), kind: "text", helper: _("Space-separated list.") },
    { keyword: "DenyUsers", label: _("Deny users"), kind: "text", helper: _("Space-separated list.") },
    { keyword: "DenyGroups", label: _("Deny groups"), kind: "text", helper: _("Space-separated list.") },
    {
        keyword: "LogLevel",
        label: _("Log level"),
        kind: "choice",
        choices: ["", "QUIET", "FATAL", "ERROR", "INFO", "VERBOSE", "DEBUG"],
    },
    { keyword: "Banner", label: _("Banner file"), kind: "text" },
];

function stateColor(state: string): "green" | "red" | "orange" | "grey" {
    if (state === "active")
        return "green";
    if (state === "failed")
        return "red";
    if (state === "activating" || state === "deactivating")
        return "orange";
    return "grey";
}

export const ServerPage = () => {
    const [loading, setLoading] = useState(true);
    const [installed, setInstalled] = useState(true);
    const [packageManager, setPackageManager] = useState<"apt" | "dnf" | null>(null);
    const [installing, setInstalling] = useState(false);

    const [unit, setUnit] = useState<string | null>(null);
    const [service, setService] = useState<ServiceState | null>(null);
    const [effective, setEffective] = useState<EffectiveConfig>({});
    const [scan, setScan] = useState<ConfigScan>({ records: [], files: [], matchFiles: [] });
    const [hostKeys, setHostKeys] = useState<HostKey[]>([]);
    const [includes, setIncludes] = useState(true);

    const [baseline, setBaseline] = useState("");
    const [settings, setSettings] = useState<ManagedSettings>(emptySettings);
    const [savedSettings, setSavedSettings] = useState<ManagedSettings>(emptySettings);

    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const [warnings, setWarnings] = useState<PreflightWarning[] | null>(null);
    const [fixing, setFixing] = useState<string | null>(null);
    const [rollbackLeft, setRollbackLeft] = useState<number | null>(null);

    const [rawOpen, setRawOpen] = useState(false);
    const [raw, setRaw] = useState("");
    const [rawResult, setRawResult] = useState<string | null>(null);

    const load = useCallback(async () => {
        const sshd = await sshdBinary();
        if (!sshd) {
            setInstalled(false);
            setPackageManager(await detectPackageManager());
            setLoading(false);
            return;
        }
        setInstalled(true);

        const detectedUnit = await detectServiceUnit();
        setUnit(detectedUnit);
        setService(detectedUnit ? await getServiceState(detectedUnit) : null);

        const config = await getEffectiveConfig();
        setEffective(config);
        setHostKeys(await hostKeyFingerprints(config));
        setScan(await scanConfig());
        setIncludes(await supportsIncludes());

        const content = await readDropIn();
        const parsed = prefillSettings(parseSettings(content), config);
        setBaseline(content);
        setRaw(content);
        setSettings(parsed);
        setSavedSettings(parsed);
        setLoading(false);
    }, []);

    useEffect(() => {
        load().catch((e: unknown) => {
            setError(e instanceof Error ? e.message : String(e));
            setLoading(false);
        });
    }, [load]);

    // Countdown for the armed rollback timer.
    const rollbackRef = useRef<number | null>(null);
    useEffect(() => {
        if (rollbackLeft === null)
            return;
        if (rollbackLeft <= 0) {
            setRollbackLeft(null);
            load().catch(() => undefined);
            return;
        }
        rollbackRef.current = window.setTimeout(() => setRollbackLeft(v => (v === null ? null : v - 1)), 1000);
        return () => {
            if (rollbackRef.current)
                window.clearTimeout(rollbackRef.current);
        };
    }, [rollbackLeft, load]);

    const run = async (id: string, action: () => Promise<void>) => {
        setBusy(id);
        setError(null);
        try {
            await action();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        }
        setBusy(null);
    };

    const install = () => run("install", async () => {
        if (!packageManager)
            return;
        setInstalling(true);
        try {
            await installServerPackage(packageManager);
            await load();
        } finally {
            setInstalling(false);
        }
    });

    const serviceAction = (id: string, action: (u: string) => Promise<unknown>) => run(id, async () => {
        if (!unit)
            return;
        await action(unit);
        setService(await getServiceState(unit));
    });

    const buildPreflightContext = async () => {
        const users = await listUsers();
        const me = await cockpit.user();
        const mine = users.find(u => u.name === me.name);
        return {
            settings,
            effective,
            service: service ?? {
                unit: unit ?? "",
                activeState: "unknown",
                subState: "",
                unitFileState: "",
                socketUnit: null,
                socketActive: false,
            },
            scan,
            currentUser: me.name,
            currentUserGroups: await currentUserGroups(),
            currentUserHasKey: mine
                ? (await readKeys(authorizedKeysPathFor(mine, effective))).length > 0
                : false,
            hasNonRootUser: users.some(u => u.uid !== 0 && !u.isSystem),
        };
    };

    const commit = async () => {
        const content = serializeSettings(settings);
        const portChanged = one(settings, "Port") !== one(savedSettings, "Port");

        await applyConfig(content, baseline);
        if (unit) {
            if (portChanged && service?.socketUnit)
                await restartSocket(service.socketUnit);
            else
                await reloadService(unit);
            await armRollback(ROLLBACK_SECONDS, unit);
            setRollbackLeft(ROLLBACK_SECONDS);
        }
        await load();
    };

    const startApply = () => run("apply", async () => {
        const found = await preflight(await buildPreflightContext());
        if (found.length > 0) {
            setWarnings(found);
            return;
        }
        await commit();
    });

    const confirmApply = () => run("apply", async () => {
        setWarnings(null);
        await commit();
    });

    const keepChanges = () => run("keep", async () => {
        await cancelRollback();
        setRollbackLeft(null);
    });

    const revertNow = () => run("revert", async () => {
        if (!unit)
            return;
        await cancelRollback();
        await revertConfig(unit);
        setRollbackLeft(null);
        await load();
    });

    const applyRaw = () => run("raw", async () => {
        await applyConfig(raw, baseline);
        if (unit) {
            await reloadService(unit);
            await armRollback(ROLLBACK_SECONDS, unit);
            setRollbackLeft(ROLLBACK_SECONDS);
        }
        await load();
    });

    const checkRaw = () => run("check", async () => {
        const result = await validateConfig();
        setRawResult(result.ok ? _("The running configuration is valid.") : result.error);
    });

    if (loading)
        return <Spinner />;

    if (!installed) {
        return (
            <Card>
                <CardBody>
                    <EmptyState>
                        <EmptyStateBody>
                            {_("The OpenSSH server is not installed on this machine. The SSH client tools are present, so authorized keys and known hosts can still be managed.")}
                        </EmptyStateBody>
                        <EmptyStateFooter>
                            <EmptyStateActions>
                                {packageManager
                                    ? (
                                        <Button variant="primary" onClick={install} isLoading={installing} isDisabled={installing}>
                                            {_("Install openssh-server")}
                                        </Button>
                                    )
                                    : <span>{_("Install the openssh-server package to continue.")}</span>}
                            </EmptyStateActions>
                        </EmptyStateFooter>
                    </EmptyState>
                    {error && <Alert variant="danger" title={error} isInline />}
                </CardBody>
            </Card>
        );
    }

    const dirty = !settingsEqual(settings, savedSettings);

    const renderHint = (keyword: ManagedKeyword) => {
        const effectiveText = effectiveValues(effective, keyword).join(", ");
        const provenance = provenanceFor(scan, keyword);
        const parts: string[] = [];

        // The field already shows the value it was prefilled with, so only say
        // what is in effect when the two have drifted apart.
        if (effectiveText && effectiveText !== settings[keyword].join(", "))
            parts.push(cockpit.format(_("In effect: $0"), effectiveText));
        if (provenance && provenance.file !== DROPIN)
            parts.push(cockpit.format(_("Set in $0 line $1"), provenance.file, String(provenance.line)));

        if (parts.length === 0)
            return null;
        return <div className="ssh-provenance">{parts.join(" · ")}</div>;
    };

    const renderField = (field: FieldDef) => {
        const id = `ssh-${field.keyword}`;
        let control;
        if (field.kind === "choice") {
            control = (
                <FormSelect
                    id={id}
                    value={one(settings, field.keyword)}
                    onChange={(_event, value) => setSettings(s => withOne(s, field.keyword, value))}
                >
                    {(field.choices ?? []).map(choice => (
                        <FormSelectOption
                            key={choice || "unset"}
                            value={choice}
                            label={choice || _("Leave to the rest of the configuration")}
                        />
                    ))}
                </FormSelect>
            );
        } else if (field.kind === "lines") {
            control = (
                <TextArea
                    id={id}
                    rows={3}
                    value={settings[field.keyword].join("\n")}
                    onChange={(_event, value) => setSettings(s => withList(s, field.keyword, value.split("\n")))}
                />
            );
        } else {
            control = (
                <TextInput
                    id={id}
                    value={one(settings, field.keyword)}
                    onChange={(_event, value) => setSettings(s => withOne(s, field.keyword, value))}
                />
            );
        }

        return (
            <FormGroup key={field.keyword} label={field.label} fieldId={id}>
                {control}
                {field.helper && <div className="ssh-provenance">{field.helper}</div>}
                {renderHint(field.keyword)}
            </FormGroup>
        );
    };

    return (
        <>
            {error && (
                <Alert variant="danger" title={_("Error")} isInline className="pf-v6-u-mb-md">
                    {error}
                </Alert>
            )}

            {rollbackLeft !== null && (
                <Alert
                    variant="warning"
                    isInline
                    className="pf-v6-u-mb-md"
                    title={cockpit.format(
                        _("Reverting in $0 seconds unless you confirm the change works"),
                        String(rollbackLeft))}
                    actionLinks={
                        <>
                            <AlertActionLink onClick={keepChanges}>{_("Keep changes")}</AlertActionLink>
                            <AlertActionLink onClick={revertNow}>{_("Revert now")}</AlertActionLink>
                        </>
                    }
                >
                    {_("Open a new SSH session now to check that you can still log in. If you cannot, do nothing and the previous configuration will be restored automatically.")}
                </Alert>
            )}

            <Card className="pf-v6-u-mb-lg">
                <CardTitle>{_("SSH daemon")}</CardTitle>
                <CardBody>
                    {!unit
                        ? <Alert variant="warning" title={_("No sshd or ssh systemd unit was found.")} isInline />
                        : (
                            <>
                                <DescriptionList isHorizontal>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Unit")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {unit}
                                            {service?.socketUnit && (
                                                <> <Label color="blue" isCompact>{_("socket-activated")}</Label></>
                                            )}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("State")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            <Label color={stateColor(service?.activeState ?? "")} isCompact>
                                                {service?.activeState}
                                            </Label>
                                            {service?.subState ? ` (${service.subState})` : ""}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Start on boot")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            <Switch
                                                id="ssh-enabled"
                                                isChecked={service?.unitFileState === "enabled"}
                                                isDisabled={busy !== null}
                                                onChange={() => serviceAction(
                                                    "enable",
                                                    service?.unitFileState === "enabled" ? disableService : enableService)}
                                                label={service?.unitFileState || _("unknown")}
                                            />
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    {hostKeys.length > 0 && (
                                        <DescriptionListGroup>
                                            <DescriptionListTerm>{_("Host keys")}</DescriptionListTerm>
                                            <DescriptionListDescription>
                                                {hostKeys.map(key => (
                                                    <div key={key.path} className="ssh-mono">{key.fingerprint}</div>
                                                ))}
                                            </DescriptionListDescription>
                                        </DescriptionListGroup>
                                    )}
                                </DescriptionList>

                                <Flex className="ssh-actions" gap={{ default: "gapMd" }} alignItems={{ default: "alignItemsCenter" }}>
                                    <FlexItem>
                                        <Switch
                                            id="ssh-running"
                                            label={_("Running")}
                                            isChecked={service?.activeState === "active"}
                                            isDisabled={busy !== null}
                                            onChange={() => serviceAction(
                                                "run",
                                                service?.activeState === "active" ? stopService : startService)}
                                        />
                                    </FlexItem>
                                    <FlexItem>
                                        <Button
                                            variant="secondary"
                                            isDisabled={busy !== null}
                                            onClick={() => serviceAction("reload", reloadService)}
                                        >
                                            {_("Reload")}
                                        </Button>
                                    </FlexItem>
                                    <FlexItem>
                                        <Button
                                            variant="secondary"
                                            isDisabled={busy !== null}
                                            onClick={() => serviceAction("restart", restartService)}
                                        >
                                            {_("Restart")}
                                        </Button>
                                    </FlexItem>
                                    <FlexItem>
                                        <Button
                                            variant="link"
                                            onClick={() => cockpit.jump(`/system/services#/${unit}`)}
                                        >
                                            {_("Open in Services")}
                                        </Button>
                                    </FlexItem>
                                </Flex>
                            </>
                        )}
                </CardBody>
            </Card>

            <Card>
                <CardTitle>{_("Configuration")}</CardTitle>
                <CardBody>
                    <Alert
                        variant={includes ? "info" : "warning"}
                        isInline
                        title={includes
                            ? cockpit.format(_("Changes are written to $0"), DROPIN)
                            : _("This sshd does not include a drop-in directory")}
                    >
                        {includes
                            ? _("The fields below start from the configuration currently in force, so only what you want to change needs editing. Everything left filled in is written to the drop-in, which sshd reads first and therefore takes precedence over the rest of the configuration. Clear a field to leave that setting to the files it comes from today.")
                            : cockpit.format(_("sshd_config has no Include line for $0, so settings written there will be ignored. Add \"Include $0/*.conf\" at the top of /etc/ssh/sshd_config first."), "/etc/ssh/sshd_config.d")}
                    </Alert>

                    {scan.matchFiles.length > 0 && (
                        <Alert
                            variant="warning"
                            isInline
                            title={_("Conditional Match blocks are present")}
                        >
                            {cockpit.format(
                                _("$0 contains Match blocks. Values shown here are the global ones and may differ for particular users, groups or addresses."),
                                scan.matchFiles.join(", "))}
                        </Alert>
                    )}

                    <Form isHorizontal>
                        {FIELDS.map(renderField)}
                    </Form>

                    <Flex className="ssh-actions" gap={{ default: "gapMd" }}>
                        <FlexItem>
                            <Button
                                variant="primary"
                                onClick={startApply}
                                isDisabled={!dirty || busy !== null}
                                isLoading={busy === "apply"}
                            >
                                {_("Apply and reload")}
                            </Button>
                        </FlexItem>
                        <FlexItem>
                            <Button
                                variant="link"
                                onClick={() => setSettings(savedSettings)}
                                isDisabled={!dirty || busy !== null}
                            >
                                {_("Discard changes")}
                            </Button>
                        </FlexItem>
                    </Flex>

                    <ExpandableSection
                        toggleText={_("Edit the drop-in file directly")}
                        isExpanded={rawOpen}
                        onToggle={(_event, expanded) => setRawOpen(expanded)}
                    >
                        <TextArea
                            id="ssh-raw"
                            rows={12}
                            value={raw}
                            onChange={(_event, value) => setRaw(value)}
                            aria-label={_("Drop-in configuration")}
                        />
                        {rawResult && <Alert variant="info" title={rawResult} isInline className="pf-v6-u-mt-md" />}
                        <Flex className="ssh-actions" gap={{ default: "gapMd" }}>
                            <FlexItem>
                                <Button
                                    variant="secondary"
                                    onClick={applyRaw}
                                    isDisabled={raw === baseline || busy !== null}
                                    isLoading={busy === "raw"}
                                >
                                    {_("Apply and reload")}
                                </Button>
                            </FlexItem>
                            <FlexItem>
                                <Button variant="link" onClick={checkRaw} isDisabled={busy !== null}>
                                    {_("Check the running configuration")}
                                </Button>
                            </FlexItem>
                        </Flex>
                    </ExpandableSection>
                </CardBody>
            </Card>

            {warnings && (
                <Modal variant="medium" isOpen onClose={() => setWarnings(null)}>
                    <ModalHeader title={_("Review before applying")} />
                    <ModalBody>
                        {warnings.map(warning => (
                            <Alert
                                key={warning.id}
                                variant={warning.severity}
                                title={warning.title}
                                isInline
                                className="pf-v6-u-mb-md"
                                actionLinks={warning.fix
                                    ? (
                                        <AlertActionLink
                                            onClick={() => run(warning.id, async () => {
                                                setFixing(warning.id);
                                                try {
                                                    await warning.fix!();
                                                    setWarnings(ws => ws?.filter(w => w.id !== warning.id) ?? null);
                                                } finally {
                                                    setFixing(null);
                                                }
                                            })}
                                        >
                                            {fixing === warning.id ? _("Working…") : warning.fixLabel}
                                        </AlertActionLink>
                                    )
                                    : undefined}
                            >
                                {warning.detail}
                            </Alert>
                        ))}
                        <p>
                            {cockpit.format(
                                _("After applying, the previous configuration is restored automatically in $0 seconds unless you confirm that you can still log in."),
                                String(ROLLBACK_SECONDS))}
                        </p>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={confirmApply} isLoading={busy === "apply"}>
                            {_("Apply anyway")}
                        </Button>
                        <Button variant="link" onClick={() => setWarnings(null)}>{_("Cancel")}</Button>
                    </ModalFooter>
                </Modal>
            )}
        </>
    );
};
