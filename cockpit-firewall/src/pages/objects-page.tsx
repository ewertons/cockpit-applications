import React, { useEffect, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Form } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";

import cockpit from 'cockpit';

import type { ConfigurationPageProps } from '../app.jsx';
import { PageHeader, SelectField, SimpleTable, TextField, removeItem } from '../components.jsx';
import { importWireguardPeers, listNetworkInterfaces } from '../firewall-backend.js';
import { BUILT_IN_SERVICES, FirewallConfiguration, Verdict } from '../model.js';
import { isValidInterfaceName, isValidObjectName, parseAddress, parseServicePorts } from '../validation.js';
import { mergeImportedHosts } from '../wireguard-import.js';

const _ = cockpit.gettext;

const VERDICT_CHOICES = [
    { value: "accept", label: _("Accept") },
    { value: "drop", label: _("Drop") },
];

function splitList(text: string): string[] {
    return text.split(/[\s,]+/).filter(Boolean);
}

function referencesTo(configuration: FirewallConfiguration, kind: "zone" | "host" | "service", name: string): number {
    const endpoints = [
        ...configuration.forwardRules.flatMap(rule => [rule.from, rule.to]),
        ...configuration.inputRules.map(rule => rule.from),
    ];
    if (kind === "zone")
        return endpoints.filter(endpoint => endpoint.zone === name).length +
            configuration.natRules.filter(rule => rule.sourceZone === name || rule.egressZone === name).length;
    if (kind === "host")
        return endpoints.filter(endpoint => endpoint.host === name).length +
            configuration.natRules.filter(rule => rule.sourceAddress === name).length;
    return [...configuration.forwardRules, ...configuration.inputRules].filter(rule => rule.service === name).length;
}

function nameIsTaken(configuration: FirewallConfiguration, kind: "zone" | "host" | "service", name: string): boolean {
    if (kind === "zone")
        return configuration.zones.some(zone => zone.name === name);
    if (kind === "host")
        return configuration.hosts.some(host => host.name === name);
    return [...BUILT_IN_SERVICES, ...configuration.services].some(service => service.name === name);
}

const ZonesCard = ({ configuration, onChange, setError }: ConfigurationPageProps & { setError: (message: string | null) => void }) => {
    const [name, setName] = useState("");
    const [interfaces, setInterfaces] = useState("");
    const [forwardPolicy, setForwardPolicy] = useState<Verdict>("accept");
    const [inputPolicy, setInputPolicy] = useState<Verdict>("accept");
    const [hostInterfaces, setHostInterfaces] = useState<string[]>([]);

    useEffect(() => { listNetworkInterfaces().then(setHostInterfaces) }, []);

    const add = () => {
        const interfaceList = splitList(interfaces);
        if (!isValidObjectName(name))
            return setError(_("Zone name must start with a letter and contain only letters, digits, '_', '.', '-'."));
        if (nameIsTaken(configuration, "zone", name))
            return setError(cockpit.format(_("Zone \"$0\" already exists."), name));
        if (interfaceList.length === 0 || !interfaceList.every(isValidInterfaceName))
            return setError(_("Enter one or more valid interface names (e.g. wg0, eth0, or a prefix like wg*)."));
        setError(null);
        onChange({ ...configuration, zones: [...configuration.zones, { name, interfaces: interfaceList, forwardPolicy, inputPolicy }] });
        setName("");
        setInterfaces("");
    };

    const updatePolicy = (index: number, field: "forwardPolicy" | "inputPolicy", value: Verdict) =>
        onChange({ ...configuration, zones: configuration.zones.map((zone, zoneIndex) => zoneIndex === index ? { ...zone, [field]: value } : zone) });

    const remove = (index: number) => {
        const zoneName = configuration.zones[index].name;
        if (referencesTo(configuration, "zone", zoneName) > 0)
            return setError(cockpit.format(_("Zone \"$0\" is used by rules; remove those first."), zoneName));
        onChange({ ...configuration, zones: removeItem(configuration.zones, index) });
    };

    return (
        <Card isCompact className="fw-card">
            <CardTitle>{_("Zones")}</CardTitle>
            <CardBody>
                <p className="fw-muted">{_("A zone is a named group of interfaces. Its default policies apply to traffic entering through those interfaces that no rule matched.")}</p>
                <SimpleTable
                    headers={[_("Name"), _("Interfaces"), _("Forward default"), _("Input default"), ""]}
                    emptyText={_("No zones defined.")}
                    rows={configuration.zones.map((zone, index) => [
                        zone.name,
                        zone.interfaces.join(", "),
                        <SelectField
                            key="forward" fieldId={`zone-forward-${index}`} label=""
                            ariaLabel={cockpit.format(_("Forward default for zone $0"), zone.name)} value={zone.forwardPolicy} choices={VERDICT_CHOICES}
                            onChange={value => updatePolicy(index, "forwardPolicy", value as Verdict)}
                        />,
                        <SelectField
                            key="input" fieldId={`zone-input-${index}`} label=""
                            ariaLabel={cockpit.format(_("Input default for zone $0"), zone.name)} value={zone.inputPolicy} choices={VERDICT_CHOICES}
                            onChange={value => updatePolicy(index, "inputPolicy", value as Verdict)}
                        />,
                        <Button key="remove" variant="link" isDanger onClick={() => remove(index)}>{_("Remove")}</Button>,
                    ])}
                />
                <Form isHorizontal={false} className="fw-add-form" onSubmit={event => { event.preventDefault(); add() }}>
                    <TextField fieldId="zone-name" label={_("Name")} value={name} onChange={setName} placeholder="vpn" />
                    <TextField
                        fieldId="zone-interfaces" label={_("Interfaces")} value={interfaces} onChange={setInterfaces}
                        placeholder={hostInterfaces.length ? hostInterfaces.join(", ") : "wg0"}
                    />
                    <SelectField
                        fieldId="zone-forward-policy" label={_("Forward default")} value={forwardPolicy} choices={VERDICT_CHOICES}
                        onChange={value => setForwardPolicy(value as Verdict)}
                    />
                    <SelectField
                        fieldId="zone-input-policy" label={_("Input default")} value={inputPolicy} choices={VERDICT_CHOICES}
                        onChange={value => setInputPolicy(value as Verdict)}
                    />
                    <Button variant="secondary" type="submit">{_("Add zone")}</Button>
                </Form>
            </CardBody>
        </Card>
    );
};

const HostsCard = ({ configuration, onChange, setError }: ConfigurationPageProps & { setError: (message: string | null) => void }) => {
    const [name, setName] = useState("");
    const [addresses, setAddresses] = useState("");
    const [importMessage, setImportMessage] = useState<string | null>(null);
    const [importing, setImporting] = useState(false);

    const add = () => {
        const addressList = splitList(addresses);
        if (!isValidObjectName(name))
            return setError(_("Host name must start with a letter and contain only letters, digits, '_', '.', '-'."));
        if (nameIsTaken(configuration, "host", name))
            return setError(cockpit.format(_("Host \"$0\" already exists."), name));
        const parsed = addressList.map(parseAddress);
        if (parsed.length === 0 || parsed.some(address => address === null))
            return setError(_("Enter one or more IPv4/IPv6 addresses or networks (e.g. 192.168.1.20, 10.99.0.0/24). Networks must not have host bits set."));
        setError(null);
        onChange({ ...configuration, hosts: [...configuration.hosts, { name, addresses: parsed.map(address => address!.text), origin: "manual" }] });
        setName("");
        setAddresses("");
    };

    const remove = (index: number) => {
        const hostName = configuration.hosts[index].name;
        if (referencesTo(configuration, "host", hostName) > 0)
            return setError(cockpit.format(_("Host \"$0\" is used by rules; remove those first."), hostName));
        onChange({ ...configuration, hosts: removeItem(configuration.hosts, index) });
    };

    const importPeers = async () => {
        setImporting(true);
        setImportMessage(null);
        try {
            const { summaries, failedInterfaces } = await importWireguardPeers();
            let hosts = configuration.hosts;
            const messages: string[] = [];
            // Rebuilt from this scan so stale ports are dropped; kept as they were if any file could not be read.
            const listenPorts = new Set(failedInterfaces.length ? configuration.wireguardListenPorts : []);
            if (failedInterfaces.length)
                messages.push(cockpit.format(_("Could not read: $0. Its peers and listen ports were left unchanged."), failedInterfaces.join(", ")));
            for (const summary of summaries) {
                const merged = mergeImportedHosts(hosts, summary);
                hosts = merged.hosts;
                if (summary.listenPort)
                    listenPorts.add(summary.listenPort);
                messages.push(cockpit.format(_("$0: $1 peer(s) imported"), summary.interfaceName, summary.hosts.length - merged.conflicts.length));
                if (merged.conflicts.length)
                    messages.push(cockpit.format(_("$0: skipped, a manual host has the same name: $1"), summary.interfaceName, merged.conflicts.join(", ")));
                if (summary.skippedPeers.length)
                    messages.push(cockpit.format(_("$0: skipped, no usable AllowedIPs: $1"), summary.interfaceName, summary.skippedPeers.join(", ")));
            }
            onChange({ ...configuration, hosts, wireguardListenPorts: [...listenPorts].sort((first, second) => first - second) });
            setImportMessage(summaries.length || failedInterfaces.length ? messages.join("\n") : _("No WireGuard configuration found in /etc/wireguard."));
        } catch (error) {
            setError(String(error));
        }
        setImporting(false);
    };

    return (
        <Card isCompact className="fw-card">
            <CardTitle>{_("Hosts and networks")}</CardTitle>
            <CardBody>
                <div className="fw-card-actions">
                    <Button variant="secondary" onClick={importPeers} isLoading={importing} isDisabled={importing}>
                        {_("Import WireGuard peers")}
                    </Button>
                    <span className="fw-muted">{_("Reads /etc/wireguard/*.conf peer names (# Name =) and AllowedIPs. WireGuard files are never modified.")}</span>
                </div>
                {importMessage && <Alert variant="info" isInline title={_("WireGuard import")} className="fw-alert"><pre className="fw-pre-wrap">{importMessage}</pre></Alert>}
                <SimpleTable
                    headers={[_("Name"), _("Addresses"), _("Source"), ""]}
                    emptyText={_("No hosts defined.")}
                    rows={configuration.hosts.map((host, index) => [
                        host.name,
                        host.addresses.join(", "),
                        host.origin === "wireguard"
                            ? <Label key="origin" color="blue" isCompact>{cockpit.format(_("WireGuard $0"), host.wireguardInterface ?? "")}</Label>
                            : _("Manual"),
                        <Button key="remove" variant="link" isDanger onClick={() => remove(index)}>{_("Remove")}</Button>,
                    ])}
                />
                <Form className="fw-add-form" onSubmit={event => { event.preventDefault(); add() }}>
                    <TextField fieldId="host-name" label={_("Name")} value={name} onChange={setName} placeholder="lan-server" />
                    <TextField fieldId="host-addresses" label={_("Addresses")} value={addresses} onChange={setAddresses} placeholder="192.168.1.20" />
                    <Button variant="secondary" type="submit">{_("Add host")}</Button>
                </Form>
            </CardBody>
        </Card>
    );
};

const ServicesCard = ({ configuration, onChange, setError }: ConfigurationPageProps & { setError: (message: string | null) => void }) => {
    const [name, setName] = useState("");
    const [ports, setPorts] = useState("");

    const describePorts = (portList: { protocol: string; port: string }[]) =>
        portList.length ? portList.map(port => `${port.protocol}/${port.port}`).join(", ") : _("any protocol and port");

    const add = () => {
        if (!isValidObjectName(name))
            return setError(_("Service name must start with a letter and contain only letters, digits, '_', '.', '-'."));
        if (nameIsTaken(configuration, "service", name))
            return setError(cockpit.format(_("Service \"$0\" already exists."), name));
        const parsed = parseServicePorts(ports);
        if (typeof parsed === "string")
            return setError(parsed);
        setError(null);
        onChange({ ...configuration, services: [...configuration.services, { name, ports: parsed }] });
        setName("");
        setPorts("");
    };

    const remove = (index: number) => {
        const serviceName = configuration.services[index].name;
        if (referencesTo(configuration, "service", serviceName) > 0)
            return setError(cockpit.format(_("Service \"$0\" is used by rules; remove those first."), serviceName));
        onChange({ ...configuration, services: removeItem(configuration.services, index) });
    };

    return (
        <Card isCompact className="fw-card">
            <CardTitle>{_("Services")}</CardTitle>
            <CardBody>
                <SimpleTable
                    headers={[_("Name"), _("Ports"), ""]}
                    emptyText=""
                    rows={[
                        ...BUILT_IN_SERVICES.map(service => [service.name, describePorts(service.ports), <span key="builtin" className="fw-muted">{_("Built-in")}</span>]),
                        ...configuration.services.map((service, index) => [
                            service.name,
                            describePorts(service.ports),
                            <Button key="remove" variant="link" isDanger onClick={() => remove(index)}>{_("Remove")}</Button>,
                        ]),
                    ]}
                />
                <Form className="fw-add-form" onSubmit={event => { event.preventDefault(); add() }}>
                    <TextField fieldId="service-name" label={_("Name")} value={name} onChange={setName} placeholder="web-dev" />
                    <TextField fieldId="service-ports" label={_("Ports")} value={ports} onChange={setPorts} placeholder="tcp/8080, tcp/8000-8100, udp/53" />
                    <Button variant="secondary" type="submit">{_("Add service")}</Button>
                </Form>
            </CardBody>
        </Card>
    );
};

export const ObjectsPage = (props: ConfigurationPageProps) => {
    const [error, setError] = useState<string | null>(null);
    return (
        <>
            <PageHeader title={_("Zones & objects")} description={_("Building blocks referenced by rules. Changes are saved as a draft; apply them from Status & apply.")} />
            {error && <Alert variant="danger" isInline title={error} className="fw-alert" />}
            <ZonesCard {...props} setError={setError} />
            <HostsCard {...props} setError={setError} />
            <ServicesCard {...props} setError={setError} />
        </>
    );
};
