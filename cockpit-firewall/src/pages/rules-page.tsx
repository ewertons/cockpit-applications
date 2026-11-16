import React, { useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Form } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";

import cockpit from 'cockpit';

import type { ConfigurationPageProps } from '../app.jsx';
import { PageHeader, SelectChoice, SelectField, SimpleTable, TextField, moveItem, removeItem, replaceItem } from '../components.jsx';
import { ANY_SERVICE, Endpoint, FirewallConfiguration, MANAGEMENT_TCP_PORTS, Verdict, allServices, describeEndpoint } from '../model.js';
import { describeVerdict } from '../ruleset.js';
import { parseAddress } from '../validation.js';

const _ = cockpit.gettext;

const ACTION_CHOICES = [
    { value: "accept", label: _("Allow") },
    { value: "drop", label: _("Deny") },
];

type ErrorSetter = (message: string | null) => void;

function zoneChoices(configuration: FirewallConfiguration, anyLabel: string): SelectChoice[] {
    return [{ value: "", label: anyLabel }, ...configuration.zones.map(zone => ({ value: zone.name, label: `${zone.name} (${zone.interfaces.join(", ")})` }))];
}

function hostChoices(configuration: FirewallConfiguration): SelectChoice[] {
    return [{ value: "", label: _("Any address") }, ...configuration.hosts.map(host => ({ value: host.name, label: `${host.name} (${host.addresses.join(", ")})` }))];
}

function serviceChoices(configuration: FirewallConfiguration): SelectChoice[] {
    return allServices(configuration).map(service => ({ value: service.name, label: service.name }));
}

function endpointFromSelection(zone: string, host: string): Endpoint {
    return { ...zone ? { zone } : {}, ...host ? { host } : {} };
}

/** Up/down/enable/remove controls for an ordered rule list. */
function RuleControls<T extends { enabled: boolean }>({ idPrefix, rules, index, onRulesChange }: { idPrefix: string; rules: T[]; index: number; onRulesChange: (rules: T[]) => void }) {
    return (
        <span className="fw-row-actions">
            <Switch
                id={`${idPrefix}-enabled-${index}`} aria-label={_("Enabled")} isChecked={rules[index].enabled}
                onChange={(_event, checked) => onRulesChange(replaceItem(rules, index, { ...rules[index], enabled: checked }))}
            />
            <Button variant="plain" aria-label={_("Move up")} isDisabled={index === 0} onClick={() => onRulesChange(moveItem(rules, index, -1))}>↑</Button>
            <Button variant="plain" aria-label={_("Move down")} isDisabled={index === rules.length - 1} onClick={() => onRulesChange(moveItem(rules, index, 1))}>↓</Button>
            <Button variant="link" isDanger onClick={() => onRulesChange(removeItem(rules, index))}>{_("Remove")}</Button>
        </span>
    );
}

const ForwardRulesCard = ({ configuration, onChange }: ConfigurationPageProps) => {
    const [fromZone, setFromZone] = useState("");
    const [fromHost, setFromHost] = useState("");
    const [toZone, setToZone] = useState("");
    const [toHost, setToHost] = useState("");
    const [service, setService] = useState(ANY_SERVICE);
    const [action, setAction] = useState<Verdict>("accept");

    const add = () => {
        onChange({
            ...configuration,
            forwardRules: [...configuration.forwardRules, {
                from: endpointFromSelection(fromZone, fromHost),
                to: endpointFromSelection(toZone, toHost),
                service,
                action,
                enabled: true,
            }],
        });
    };

    return (
        <Card isCompact className="fw-card">
            <CardTitle>{_("Forward rules")}</CardTitle>
            <CardBody>
                <p className="fw-muted">
                    {_("Traffic routed through this host. Evaluated top to bottom after established/related traffic is accepted; unmatched traffic gets the default forward policy of the zone it entered from.")}
                </p>
                <SimpleTable
                    headers={["#", _("From"), _("To"), _("Service"), _("Action"), ""]}
                    emptyText={_("No forward rules.")}
                    rows={configuration.forwardRules.map((rule, index) => [
                        String(index + 1),
                        describeEndpoint(rule.from),
                        describeEndpoint(rule.to),
                        rule.service,
                        describeVerdict(rule.action),
                        <RuleControls
                            key="controls" idPrefix="forward" rules={configuration.forwardRules} index={index}
                            onRulesChange={forwardRules => onChange({ ...configuration, forwardRules })}
                        />,
                    ])}
                />
                <Form className="fw-add-form" onSubmit={event => { event.preventDefault(); add() }}>
                    <SelectField fieldId="forward-from-zone" label={_("From zone")} value={fromZone} choices={zoneChoices(configuration, _("Any zone"))} onChange={setFromZone} />
                    <SelectField fieldId="forward-from-host" label={_("From host")} value={fromHost} choices={hostChoices(configuration)} onChange={setFromHost} />
                    <SelectField fieldId="forward-to-zone" label={_("To zone")} value={toZone} choices={zoneChoices(configuration, _("Any zone"))} onChange={setToZone} />
                    <SelectField fieldId="forward-to-host" label={_("To host")} value={toHost} choices={hostChoices(configuration)} onChange={setToHost} />
                    <SelectField fieldId="forward-service" label={_("Service")} value={service} choices={serviceChoices(configuration)} onChange={setService} />
                    <SelectField fieldId="forward-action" label={_("Action")} value={action} choices={ACTION_CHOICES} onChange={value => setAction(value as Verdict)} />
                    <Button variant="secondary" type="submit">{_("Add forward rule")}</Button>
                </Form>
            </CardBody>
        </Card>
    );
};

const NatRulesCard = ({ configuration, onChange, setError }: ConfigurationPageProps & { setError: ErrorSetter }) => {
    const [sourceZone, setSourceZone] = useState("");
    const [sourceAddress, setSourceAddress] = useState("");
    const [egressZone, setEgressZone] = useState("");

    const add = () => {
        const trimmedSource = sourceAddress.trim();
        if (!egressZone)
            return setError(_("Select the egress zone."));
        if (!sourceZone && !trimmedSource)
            return setError(_("Select a source zone or enter a source address, otherwise all traffic leaving the egress zone would be masqueraded."));
        let normalizedSource: string | undefined;
        if (trimmedSource) {
            const host = configuration.hosts.find(candidate => candidate.name === trimmedSource);
            const parsed = host ? null : parseAddress(trimmedSource);
            if (!host && parsed?.family !== "ipv4")
                return setError(_("Source must be an IPv4 address/CIDR (e.g. 10.10.20.0/24) or a host name."));
            normalizedSource = host ? host.name : parsed!.text;
        }
        setError(null);
        onChange({
            ...configuration,
            natRules: [...configuration.natRules, {
                ...sourceZone ? { sourceZone } : {},
                ...normalizedSource ? { sourceAddress: normalizedSource } : {},
                egressZone,
                enabled: true,
            }],
        });
        setSourceAddress("");
    };

    return (
        <Card isCompact className="fw-card">
            <CardTitle>{_("NAT (IPv4 masquerade)")}</CardTitle>
            <CardBody>
                <SimpleTable
                    headers={["#", _("Source zone"), _("Source address"), _("Egress zone"), ""]}
                    emptyText={_("No NAT rules.")}
                    rows={configuration.natRules.map((rule, index) => [
                        String(index + 1),
                        rule.sourceZone ?? _("any"),
                        rule.sourceAddress ?? _("any"),
                        rule.egressZone,
                        <RuleControls
                            key="controls" idPrefix="nat" rules={configuration.natRules} index={index}
                            onRulesChange={natRules => onChange({ ...configuration, natRules })}
                        />,
                    ])}
                />
                <Form className="fw-add-form" onSubmit={event => { event.preventDefault(); add() }}>
                    <SelectField fieldId="nat-source-zone" label={_("Source zone")} value={sourceZone} choices={zoneChoices(configuration, _("Any zone"))} onChange={setSourceZone} />
                    <TextField fieldId="nat-source-address" label={_("Source address or host")} value={sourceAddress} onChange={setSourceAddress} placeholder="10.10.20.0/24" />
                    <SelectField
                        fieldId="nat-egress-zone" label={_("Egress zone")} value={egressZone}
                        choices={[{ value: "", label: _("Select a zone") }, ...zoneChoices(configuration, "").slice(1)]} onChange={setEgressZone}
                    />
                    <Button variant="secondary" type="submit">{_("Add NAT rule")}</Button>
                </Form>
            </CardBody>
        </Card>
    );
};

const InputRulesCard = ({ configuration, onChange }: ConfigurationPageProps) => {
    const [fromZone, setFromZone] = useState("");
    const [fromHost, setFromHost] = useState("");
    const [service, setService] = useState("ssh");
    const [action, setAction] = useState<Verdict>("accept");

    const add = () => onChange({
        ...configuration,
        inputRules: [...configuration.inputRules, { from: endpointFromSelection(fromZone, fromHost), service, action, enabled: true }],
    });

    return (
        <Card isCompact className="fw-card">
            <CardTitle>{_("Input rules (traffic to this host)")}</CardTitle>
            <CardBody>
                <Switch
                    id="management-access"
                    label={cockpit.format(_("Always allow management access (tcp/$0)"), MANAGEMENT_TCP_PORTS.join(", tcp/"))}
                    isChecked={configuration.allowManagementAccess}
                    onChange={(_event, checked) => onChange({ ...configuration, allowManagementAccess: checked })}
                />
                {!configuration.allowManagementAccess && (
                    <Alert variant="warning" isInline className="fw-alert" title={_("Management access is not protected")}>
                        {_("SSH and Cockpit are no longer always allowed. With an input drop policy you can lock yourself out. The automatic rollback undoes an apply you cannot confirm, but keep console access available.")}
                    </Alert>
                )}
                <p className="fw-muted">
                    {_("The input chain is only generated when an input rule exists or a zone has input default Drop. Loopback, ICMP, DHCP replies and imported WireGuard listen ports are always accepted.")}
                </p>
                <SimpleTable
                    headers={["#", _("From"), _("Service"), _("Action"), ""]}
                    emptyText={_("No input rules.")}
                    rows={configuration.inputRules.map((rule, index) => [
                        String(index + 1),
                        describeEndpoint(rule.from),
                        rule.service,
                        describeVerdict(rule.action),
                        <RuleControls
                            key="controls" idPrefix="input" rules={configuration.inputRules} index={index}
                            onRulesChange={inputRules => onChange({ ...configuration, inputRules })}
                        />,
                    ])}
                />
                <Form className="fw-add-form" onSubmit={event => { event.preventDefault(); add() }}>
                    <SelectField fieldId="input-from-zone" label={_("From zone")} value={fromZone} choices={zoneChoices(configuration, _("Any zone"))} onChange={setFromZone} />
                    <SelectField fieldId="input-from-host" label={_("From host")} value={fromHost} choices={hostChoices(configuration)} onChange={setFromHost} />
                    <SelectField fieldId="input-service" label={_("Service")} value={service} choices={serviceChoices(configuration)} onChange={setService} />
                    <SelectField fieldId="input-action" label={_("Action")} value={action} choices={ACTION_CHOICES} onChange={value => setAction(value as Verdict)} />
                    <Button variant="secondary" type="submit">{_("Add input rule")}</Button>
                </Form>
            </CardBody>
        </Card>
    );
};

export const RulesPage = (props: ConfigurationPageProps) => {
    const [error, setError] = useState<string | null>(null);
    return (
        <>
            <PageHeader title={_("Rules")} description={_("Changes are saved as a draft; apply them from Status & apply.")} />
            {error && <Alert variant="danger" isInline title={error} className="fw-alert" />}
            <ForwardRulesCard {...props} />
            <NatRulesCard {...props} setError={setError} />
            <InputRulesCard {...props} />
        </>
    );
};
