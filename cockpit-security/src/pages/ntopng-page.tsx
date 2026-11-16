import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Title } from "@patternfly/react-core/dist/esm/components/Title/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { DescriptionList, DescriptionListGroup, DescriptionListTerm, DescriptionListDescription } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Grid, GridItem } from "@patternfly/react-core/dist/esm/layouts/Grid/index.js";
import { ClipboardCopy } from "@patternfly/react-core/dist/esm/components/ClipboardCopy/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";

import cockpit from 'cockpit';

import {
    NTOPNG_CONFIG_PATH,
    NTOPNG_DEFAULT_HTTP_PORT,
    SET_ADMIN_PASSWORD_SCRIPT,
    configureListeners,
    httpLoopbackAddressFromConfig,
    httpPortFromConfig,
    listenersAreLoopbackOnly,
    redisConnectionFromConfig,
    redisEnvironment,
    validateAdminPassword,
} from './ntopng-config.js';

const _ = cockpit.gettext;

interface NtopngInstance {
    id: string;
    url: string;
    username: string;
    password: string;
    isLocal: boolean;
    label: string;
}

interface NtopngStatus {
    connected: boolean;
    version?: string;
    interfaces?: { ifid: number; ifname: string }[];
    error?: string;
}

interface TopTalker {
    address: string;
    label?: string;
    traffic?: number;
    vlan?: number;
}

interface ActiveFlow {
    client: string;
    server: string;
    l7proto: string;
    bytes: number;
}

const CONFIG_FILE = "/etc/cockpit/cockpit-security-ntopng.json";

// Writes stdin to "$1" through a 0600 temp file and a rename: the file holds passwords.
const WRITE_PRIVATE_SCRIPT = 'umask 077; t=$(mktemp -- "$1.XXXXXXXX") || exit 1; ' +
    'if cat > "$t" && mv -f -- "$t" "$1"; then exit 0; fi; rm -f -- "$t"; exit 1';

const isHttpUrl = (url: string) => {
    try {
        return ["http:", "https:"].includes(new URL(url).protocol);
    } catch {
        return false;
    }
};

/** Fetches url with curl, passing the credentials on stdin so they stay out of process listings. */
const curlWithAuth = (inst: NtopngInstance, url: string) => {
    const quote = (text: string) => '"' + text.replace(/[\\"]/g, c => "\\" + c)
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n") + '"';
    const proc = cockpit.spawn(["curl", "-s", "--proto", "=http,https", "-K", "-", "--url", url], { err: "ignore" });
    proc.input(`user = ${quote(`${inst.username}:${inst.password}`)}\n`);
    return proc;
};

export const NtopngPage = () => {
    const [instances, setInstances] = useState<NtopngInstance[]>([]);
    const [activeInstance, setActiveInstance] = useState<NtopngInstance | null>(null);
    const [status, setStatus] = useState<NtopngStatus | null>(null);
    const [localInstalled, setLocalInstalled] = useState<boolean | null>(null);
    const [localRunning, setLocalRunning] = useState(false);
    const [localLoopbackOnly, setLocalLoopbackOnly] = useState<boolean | null>(null);
    const [localHttpPort, setLocalHttpPort] = useState(NTOPNG_DEFAULT_HTTP_PORT);
    const [localHttpLoopbackAddress, setLocalHttpLoopbackAddress] = useState("127.0.0.1");

    // Local setup dialog
    const [showLocalSetup, setShowLocalSetup] = useState(false);
    const [setupPassword, setSetupPassword] = useState("");
    const [setupPasswordConfirm, setSetupPasswordConfirm] = useState("");
    const [setupListenOnAllInterfaces, setSetupListenOnAllInterfaces] = useState(false);
    const [settingUpLocal, setSettingUpLocal] = useState(false);
    const [setupError, setSetupError] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    // Add instance form
    const [showAddForm, setShowAddForm] = useState(false);
    const [formUrl, setFormUrl] = useState("http://localhost:3000");
    const [formUser, setFormUser] = useState("admin");
    const [formPass, setFormPass] = useState("");
    const [formLabel, setFormLabel] = useState("");

    // NetFlow config
    const [showNetflow, setShowNetflow] = useState(false);
    const [routerIP, setRouterIP] = useState("");
    const [ntopngIP, setNtopngIP] = useState("");
    const [netflowPort, setNetflowPort] = useState("2055");

    // Dashboard data
    const [topLocalTalkers, setTopLocalTalkers] = useState<TopTalker[]>([]);
    const [topRemoteTalkers, setTopRemoteTalkers] = useState<TopTalker[]>([]);
    const [activeFlows, setActiveFlows] = useState<ActiveFlow[]>([]);
    const [ifaceData, setIfaceData] = useState<any>(null);
    const [activeIfid, setActiveIfid] = useState<number>(0);

    useEffect(() => {
        detectLocal();
        loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const detectLocal = async () => {
        try {
            await cockpit.spawn(["which", "ntopng"], { err: "ignore" });
            setLocalInstalled(true);
            const status = await cockpit.spawn(["systemctl", "is-active", "ntopng"], { err: "ignore" })
                    .catch(() => "inactive");
            setLocalRunning(status.trim() === "active");
            await readLocalListener();
        } catch {
            setLocalInstalled(false);
        }
        setLoading(false);
    };

    const readLocalListener = async () => {
        try {
            const content = await cockpit.file(NTOPNG_CONFIG_PATH, { superuser: "try" }).read();
            setLocalLoopbackOnly(listenersAreLoopbackOnly(content ?? ""));
            setLocalHttpPort(httpPortFromConfig(content ?? ""));
            setLocalHttpLoopbackAddress(httpLoopbackAddressFromConfig(content ?? ""));
        } catch {
            setLocalLoopbackOnly(null);
        }
    };

    const loadConfig = async () => {
        try {
            const content = await cockpit.file(CONFIG_FILE, { superuser: "try" }).read();
            if (content) {
                const config = JSON.parse(content);
                setInstances(config.instances || []);
                if (config.instances?.length > 0) {
                    const inst = config.instances[0];
                    setActiveInstance(inst);
                    await testConnection(inst);
                }
            }
        } catch { /* no config yet */ }
    };

    const writeInstances = async (newInstances: NtopngInstance[]) => {
        const proc = cockpit.spawn(["sh", "-c", WRITE_PRIVATE_SCRIPT, "sh", CONFIG_FILE],
                                   { superuser: "require", err: "message" });
        proc.input(JSON.stringify({ instances: newInstances }, null, 2));
        await proc;
        setInstances(newInstances);
    };

    const saveConfig = async (newInstances: NtopngInstance[]) => {
        try {
            await writeInstances(newInstances);
        } catch (e) {
            setError(_("Cannot save configuration: ") + String(e));
        }
    };

    const testConnection = async (inst: NtopngInstance) => {
        try {
            const authHeader = btoa(`${inst.username}:${inst.password}`);
            const resp = await fetch(`${inst.url}/lua/rest/v2/get/ntopng/interfaces.lua`, {
                headers: { Authorization: `Basic ${authHeader}` },
            });
            if (!resp.ok) {
                setStatus({ connected: false, error: `HTTP ${resp.status}` });
                return;
            }
            const data = await resp.json();
            if (data.rc === 0) {
                const interfaces = Object.entries(data.rsp).map(([id, info]: [string, any]) => ({
                    ifid: parseInt(id),
                    ifname: info.ifname || id,
                }));
                setStatus({ connected: true, interfaces });
                if (interfaces.length > 0) {
                    setActiveIfid(interfaces[0].ifid);
                    await loadDashboardData(inst, interfaces[0].ifid);
                }
            } else {
                setStatus({ connected: false, error: data.rc_str || "Unknown error" });
            }
        } catch {
            // If fetch fails (CORS, network), try via cockpit spawn (curl)
            await testConnectionViaCurl(inst);
        }
    };

    const testConnectionViaCurl = async (inst: NtopngInstance) => {
        try {
            const result = await curlWithAuth(inst, `${inst.url}/lua/rest/v2/get/ntopng/interfaces.lua`);
            const data = JSON.parse(result);
            if (data.rc === 0) {
                const interfaces = Object.entries(data.rsp).map(([id, info]: [string, any]) => ({
                    ifid: parseInt(id),
                    ifname: info.ifname || id,
                }));
                setStatus({ connected: true, interfaces });
                if (interfaces.length > 0) {
                    setActiveIfid(interfaces[0].ifid);
                    await loadDashboardDataViaCurl(inst, interfaces[0].ifid);
                }
            } else {
                setStatus({ connected: false, error: data.rc_str });
            }
        } catch (e) {
            setStatus({ connected: false, error: String(e) });
        }
    };

    const apiCall = async (inst: NtopngInstance, endpoint: string, params?: Record<string, string>): Promise<any> => {
        const qs = params ? "?" + new URLSearchParams(params).toString() : "";
        const url = `${inst.url}${endpoint}${qs}`;
        try {
            const result = await curlWithAuth(inst, url);
            return JSON.parse(result);
        } catch {
            return null;
        }
    };

    const loadDashboardData = async (inst: NtopngInstance, ifid: number) => {
        await loadDashboardDataViaCurl(inst, ifid);
    };

    const loadDashboardDataViaCurl = async (inst: NtopngInstance, ifid: number) => {
        const ifidStr = String(ifid);

        // Interface data
        const ifData = await apiCall(inst, "/lua/rest/v2/get/interface/data.lua", { ifid: ifidStr });
        if (ifData?.rc === 0) setIfaceData(ifData.rsp);

        // Top local talkers
        const localTalkers = await apiCall(inst, "/lua/pro/rest/v2/get/interface/top/local/talkers.lua", { ifid: ifidStr });
        if (localTalkers?.rc === 0 && Array.isArray(localTalkers.rsp)) {
            setTopLocalTalkers(localTalkers.rsp.slice(0, 10).map((t: any) => ({
                address: t.address || t.ip || t.name || "?",
                label: t.name || t.label,
                traffic: t.value || t.traffic || t.bytes || 0,
            })));
        }

        // Top remote talkers
        const remoteTalkers = await apiCall(inst, "/lua/pro/rest/v2/get/interface/top/remote/talkers.lua", { ifid: ifidStr });
        if (remoteTalkers?.rc === 0 && Array.isArray(remoteTalkers.rsp)) {
            setTopRemoteTalkers(remoteTalkers.rsp.slice(0, 10).map((t: any) => ({
                address: t.address || t.ip || t.name || "?",
                label: t.name || t.label,
                traffic: t.value || t.traffic || t.bytes || 0,
            })));
        }

        // Active flows
        const flows = await apiCall(inst, "/lua/rest/v2/get/flow/active.lua", { ifid: ifidStr, perPage: "20" });
        if (flows?.rc === 0 && Array.isArray(flows.rsp?.data)) {
            setActiveFlows(flows.rsp.data.slice(0, 20).map((f: any) => ({
                client: f["cli.ip"] || f.client?.ip || "?",
                server: f["srv.ip"] || f.server?.ip || "?",
                l7proto: f.l7proto || f["proto.ndpi"] || "?",
                bytes: f.bytes || 0,
            })));
        }
    };

    const installNtopng = async () => {
        setError("");
        setSuccess("");
        try {
            // Detect package manager
            try {
                await cockpit.spawn(["which", "apt-get"], { err: "ignore" });
                await cockpit.spawn(["apt-get", "install", "-y", "ntopng"], { superuser: "require", err: "message" });
            } catch {
                try {
                    await cockpit.spawn(["which", "dnf"], { err: "ignore" });
                    await cockpit.spawn(["dnf", "install", "-y", "ntopng"], { superuser: "require", err: "message" });
                } catch {
                    setError(_("Could not detect package manager. Install ntopng manually."));
                    return;
                }
            }
            setSuccess(_("ntopng installed. Start the service to begin monitoring."));
            setLocalInstalled(true);
        } catch (e: any) {
            setError(e.message || String(e));
        }
    };

    const toggleNtopng = async () => {
        setError("");
        try {
            if (localRunning) {
                await cockpit.spawn(["systemctl", "stop", "ntopng"], { superuser: "require" });
                setLocalRunning(false);
                setSuccess(_("ntopng stopped"));
            } else {
                const localInstance = instances.find(i => i.id === "local");
                if (!localInstance || localInstance.password === "admin") {
                    openLocalSetup();
                    return;
                }
                await cockpit.spawn(["systemctl", "start", "ntopng"], { superuser: "require" });
                await cockpit.spawn(["systemctl", "enable", "ntopng"], { superuser: "require" });
                setLocalRunning(true);
                setSuccess(_("ntopng started and enabled"));
            }
        } catch (e) {
            setError(String(e));
        }
    };

    const openLocalSetup = () => {
        setSetupPassword("");
        setSetupPasswordConfirm("");
        setSetupListenOnAllInterfaces(false);
        setSetupError("");
        setShowLocalSetup(true);
    };

    const setUpLocalNtopng = async () => {
        const validationError = validateAdminPassword(setupPassword, setupPasswordConfirm);
        if (validationError) {
            setSetupError(_(validationError));
            return;
        }
        setSettingUpLocal(true);
        setSetupError("");
        let passwordMayHaveChanged = false;
        try {
            const configFile = cockpit.file(NTOPNG_CONFIG_PATH, { superuser: "require" });
            const currentConfig = (await configFile.read()) ?? "";
            if (httpPortFromConfig(configureListeners(currentConfig, false)) === 0)
                throw new Error(cockpit.format(_("The ntopng HTTP listener is disabled (-w=0) in $0. Enable it before setting up the local instance."), NTOPNG_CONFIG_PATH));
            const redisConnection = redisConnectionFromConfig(currentConfig);

            // Set the password while ntopng only listens on loopback, then widen the listener if requested.
            let configContent = await configFile.modify((content: string | null) => configureListeners(content ?? "", false));
            await cockpit.spawn(["systemctl", "restart", "ntopng"], { superuser: "require", err: "message" });
            setLocalRunning(true);
            // A failure part-way through the script can leave the new password stored.
            passwordMayHaveChanged = true;
            try {
                const passwordProcess = cockpit.spawn(["sh", "-c", SET_ADMIN_PASSWORD_SCRIPT], {
                    superuser: "require",
                    err: "message",
                    environ: redisEnvironment(redisConnection),
                });
                passwordProcess.input(setupPassword);
                await passwordProcess;
            } catch (passwordError) {
                await cockpit.spawn(["systemctl", "stop", "ntopng"], { superuser: "require", err: "ignore" }).catch(() => undefined);
                setLocalRunning(false);
                throw passwordError;
            }

            if (setupListenOnAllInterfaces) {
                configContent = await configFile.modify((content: string | null) => configureListeners(content ?? "", true));
                await cockpit.spawn(["systemctl", "restart", "ntopng"], { superuser: "require", err: "message" });
            }
            await cockpit.spawn(["systemctl", "enable", "ntopng"], { superuser: "require", err: "message" });
            setLocalLoopbackOnly(listenersAreLoopbackOnly(configContent));

            const port = httpPortFromConfig(configContent);
            setLocalHttpPort(port);
            setLocalHttpLoopbackAddress(httpLoopbackAddressFromConfig(configContent));
            const localInstance: NtopngInstance = {
                id: "local",
                url: `http://127.0.0.1:${port}`,
                username: "admin",
                password: setupPassword,
                isLocal: true,
                label: "Local",
            };
            await writeInstances([localInstance, ...instances.filter(i => i.id !== "local")]);
            setActiveInstance(localInstance);
            setShowLocalSetup(false);
            setSuccess(_("ntopng configured, started and enabled"));
            setTimeout(() => testConnection(localInstance), 3000);
        } catch (e: any) {
            const message = e.message || String(e);
            setSetupError(passwordMayHaveChanged
                ? cockpit.format(_("The ntopng admin password may already have been changed, but setup did not finish: $0"), message)
                : message);
        }
        setSettingUpLocal(false);
    };

    const addInstance = async () => {
        if (!formUrl || !formUser || !formPass) {
            setError(_("URL, username and password are required."));
            return;
        }
        if (!isHttpUrl(formUrl)) {
            setError(_("The URL must start with http:// or https://."));
            return;
        }
        const inst: NtopngInstance = {
            id: `remote-${Date.now()}`,
            url: formUrl.replace(/\/$/, ""),
            username: formUser,
            password: formPass,
            isLocal: false,
            label: formLabel || formUrl,
        };
        const newInstances = [...instances, inst];
        await saveConfig(newInstances);
        setActiveInstance(inst);
        await testConnection(inst);
        setShowAddForm(false);
        setFormUrl("http://localhost:3000");
        setFormUser("admin");
        setFormPass("");
        setFormLabel("");
    };

    const removeInstance = async (id: string) => {
        const newInstances = instances.filter(i => i.id !== id);
        await saveConfig(newInstances);
        if (activeInstance?.id === id) {
            setActiveInstance(newInstances[0] || null);
            setStatus(null);
        }
    };

    const formatBytes = (bytes: number): string => {
        if (!bytes) return "0 B";
        const units = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
    };

    if (loading) return <Spinner />;

    // EdgeRouter 4 NetFlow config commands
    const edgeRouterCommands = `configure
set system flow-accounting interface eth0
set system flow-accounting interface eth1
set system flow-accounting netflow version 9
set system flow-accounting netflow server ${ntopngIP || "<NTOPNG_IP>"} port ${netflowPort}
set system flow-accounting netflow engine-id 0
set system flow-accounting netflow enable-egress engine-id 1
set system flow-accounting netflow timeout expiry-interval 60
set system flow-accounting netflow timeout max-active-life 120
commit
save`;

    const ntopngNetflowCommand = `# Start ntopng listening for NetFlow on port ${netflowPort}:
ntopng -i "ntopng -i tcp://${routerIP || "<ROUTER_IP>"}:${netflowPort}" -m "${ntopngIP || "<LOCAL_SUBNET>"}/24"

# Or add to /etc/ntopng/ntopng.conf:
-i=tcp://${routerIP || "<ROUTER_IP>"}:${netflowPort}
-m=${ntopngIP || "<LOCAL_SUBNET>"}/24`;

    return (
        <>
            <Title headingLevel="h1" className="pf-v6-u-mb-md">{_("ntopng Traffic Monitor")}</Title>

            {error && <Alert variant="danger" title={error} className="pf-v6-u-mb-md" />}
            {success && <Alert variant="success" title={success} className="pf-v6-u-mb-md" />}

            {/* Local Installation Card */}
            <Card className="pf-v6-u-mb-md">
                <CardTitle>{_("Local ntopng Instance")}</CardTitle>
                <CardBody>
                    <DescriptionList isHorizontal>
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Installed")}</DescriptionListTerm>
                            <DescriptionListDescription>
                                {localInstalled
                                    ? <span className="security-status-good">{_("Yes")}</span>
                                    : <span className="security-status-warning">{_("No")}</span>}
                                {!localInstalled && (
                                    <Button variant="primary" className="pf-v6-u-ml-md" size="sm" onClick={installNtopng}>
                                        {_("Install ntopng")}
                                    </Button>
                                )}
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                        {localInstalled && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Service")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <Switch
                                        id="ntopng-service"
                                        label={_("Running")}
                                        labelOff={_("Stopped")}
                                        isChecked={localRunning}
                                        onChange={toggleNtopng}
                                    />
                                    <Button variant="secondary" className="pf-v6-u-ml-md" size="sm" onClick={openLocalSetup}>
                                        {_("Set password and listen address")}
                                    </Button>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                    </DescriptionList>
                    {localInstalled && instances.find(i => i.id === "local")?.password === "admin" && (
                        <Alert variant="warning" isInline className="pf-v6-u-mt-md" title={_("The local ntopng instance uses the default admin password. Set a new password.")} />
                    )}
                    {localInstalled && localLoopbackOnly === false && (
                        <Alert variant="warning" isInline className="pf-v6-u-mt-md" title={_("The ntopng web interface is reachable from the network (not only on 127.0.0.1).")}>
                            {_("Restrict it to 127.0.0.1 unless other machines must reach it directly.")}
                        </Alert>
                    )}
                    {localInstalled && localLoopbackOnly === true && (
                        <p className="pf-v6-u-mt-md">
                            {cockpit.format(_("The web interface only listens on the loopback address $1. To open it from another machine, use an SSH tunnel: ssh -L $0:$1:$0 <user>@<this server>"), String(localHttpPort), localHttpLoopbackAddress)}
                        </p>
                    )}
                </CardBody>
            </Card>

            {showLocalSetup && (
                <Modal variant="small" isOpen onClose={() => { if (!settingUpLocal) setShowLocalSetup(false); }}>
                    <ModalHeader title={_("Set up local ntopng")} />
                    <ModalBody>
                        {setupError && <Alert variant="danger" isInline title={setupError} className="pf-v6-u-mb-md" />}
                        <FormGroup label={_("New admin password")} isRequired fieldId="ntopng-setup-password">
                            <TextInput id="ntopng-setup-password" type="password" value={setupPassword} onChange={(_e, v) => setSetupPassword(v)} />
                        </FormGroup>
                        <FormGroup label={_("Confirm password")} isRequired fieldId="ntopng-setup-password-confirm" className="pf-v6-u-mt-sm">
                            <TextInput id="ntopng-setup-password-confirm" type="password" value={setupPasswordConfirm} onChange={(_e, v) => setSetupPasswordConfirm(v)} />
                        </FormGroup>
                        <Checkbox
                            id="ntopng-setup-listen-all"
                            className="pf-v6-u-mt-md"
                            label={_("Listen on all network interfaces")}
                            description={_("Off: the web interface only listens on 127.0.0.1 (use Cockpit or an SSH tunnel). On: any machine that can reach this server can open the ntopng login page.")}
                            isChecked={setupListenOnAllInterfaces}
                            onChange={(_e, checked) => setSetupListenOnAllInterfaces(checked)}
                        />
                        {setupListenOnAllInterfaces && (
                            <Alert variant="warning" isInline className="pf-v6-u-mt-sm" title={_("ntopng will be reachable from the network. Restrict access with a firewall.")} />
                        )}
                        <p className="pf-v6-u-mt-md">
                            {cockpit.format(_("This updates $0 and restarts ntopng."), NTOPNG_CONFIG_PATH)}
                        </p>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="primary" onClick={setUpLocalNtopng} isLoading={settingUpLocal} isDisabled={settingUpLocal || !setupPassword}>
                            {_("Apply")}
                        </Button>
                        <Button variant="link" onClick={() => setShowLocalSetup(false)} isDisabled={settingUpLocal}>
                            {_("Cancel")}
                        </Button>
                    </ModalFooter>
                </Modal>
            )}

            {/* Remote Instances */}
            <Card className="pf-v6-u-mb-md">
                <CardTitle>{_("ntopng Instances")}</CardTitle>
                <CardBody>
                    {instances.length > 0 && (
                        <table className="pf-v6-c-table pf-m-compact pf-v6-u-mb-md">
                            <thead>
                                <tr>
                                    <th>{_("Label")}</th>
                                    <th>{_("URL")}</th>
                                    <th>{_("Type")}</th>
                                    <th>{_("Status")}</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {instances.map(inst => (
                                    <tr key={inst.id} style={{ background: activeInstance?.id === inst.id ? "var(--pf-t--global--background--color--primary--default)" : undefined }}>
                                        <td>
                                            <Button variant="link" onClick={() => { setActiveInstance(inst); testConnection(inst) }}>
                                                <strong>{inst.label}</strong>
                                            </Button>
                                        </td>
                                        <td>{inst.url}</td>
                                        <td>{inst.isLocal ? _("Local") : _("Remote")}</td>
                                        <td>
                                            {activeInstance?.id === inst.id && status
                                                ? (status.connected
                                                    ? <span className="security-status-good">{_("Connected")}</span>
                                                    : <span className="security-status-danger">{_("Error")}</span>)
                                                : "—"}
                                        </td>
                                        <td>
                                            <Button variant="link" isDanger size="sm" onClick={() => removeInstance(inst.id)}>
                                                {_("Remove")}
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    {!showAddForm
                        ? (
                            <Button variant="secondary" onClick={() => setShowAddForm(true)}>
                                {_("Add Remote ntopng")}
                            </Button>
                        )
                        : (
                            <div style={{ border: "1px solid var(--pf-t--global--border--color--default)", padding: "1rem", borderRadius: "4px" }}>
                                <Title headingLevel="h4" className="pf-v6-u-mb-sm">{_("Add ntopng Instance")}</Title>
                                <Grid hasGutter>
                                    <GridItem span={6}>
                                        <FormGroup label={_("Label")}>
                                            <TextInput value={formLabel} onChange={(_e, v) => setFormLabel(v)} placeholder="My RPi ntopng" />
                                        </FormGroup>
                                    </GridItem>
                                    <GridItem span={6}>
                                        <FormGroup label={_("URL")}>
                                            <TextInput value={formUrl} onChange={(_e, v) => setFormUrl(v)} placeholder="http://192.168.1.50:3000" />
                                        </FormGroup>
                                    </GridItem>
                                    <GridItem span={6}>
                                        <FormGroup label={_("Username")}>
                                            <TextInput value={formUser} onChange={(_e, v) => setFormUser(v)} />
                                        </FormGroup>
                                    </GridItem>
                                    <GridItem span={6}>
                                        <FormGroup label={_("Password")}>
                                            <TextInput value={formPass} onChange={(_e, v) => setFormPass(v)} type="password" />
                                        </FormGroup>
                                    </GridItem>
                                </Grid>
                                <div className="pf-v6-u-mt-md">
                                    <Button variant="primary" onClick={addInstance} className="pf-v6-u-mr-sm">{_("Add")}</Button>
                                    <Button variant="link" onClick={() => setShowAddForm(false)}>{_("Cancel")}</Button>
                                </div>
                            </div>
                        )}
                </CardBody>
            </Card>

            {/* NetFlow / EdgeRouter Setup */}
            <Card className="pf-v6-u-mb-md">
                <CardTitle>{_("NetFlow Setup (Ubiquiti EdgeRouter)")}</CardTitle>
                <CardBody>
                    <p className="pf-v6-u-mb-sm">
                        {_("Your EdgeRouter 4 supports NetFlow v9. Configure it to export flow data to ntopng for full traffic visibility without port mirroring.")}
                    </p>
                    <Button variant="secondary" onClick={() => setShowNetflow(!showNetflow)}>
                        {showNetflow ? _("Hide Configuration") : _("Show Configuration Guide")}
                    </Button>

                    {showNetflow && (
                        <div className="pf-v6-u-mt-md">
                            <Grid hasGutter>
                                <GridItem span={4}>
                                    <FormGroup label={_("EdgeRouter IP")}>
                                        <TextInput value={routerIP} onChange={(_e, v) => setRouterIP(v)} placeholder="192.168.1.1" />
                                    </FormGroup>
                                </GridItem>
                                <GridItem span={4}>
                                    <FormGroup label={_("ntopng Host IP")}>
                                        <TextInput value={ntopngIP} onChange={(_e, v) => setNtopngIP(v)} placeholder="192.168.1.50" />
                                    </FormGroup>
                                </GridItem>
                                <GridItem span={4}>
                                    <FormGroup label={_("NetFlow Port")}>
                                        <TextInput value={netflowPort} onChange={(_e, v) => setNetflowPort(v)} placeholder="2055" />
                                    </FormGroup>
                                </GridItem>
                            </Grid>

                            <Title headingLevel="h4" className="pf-v6-u-mt-md pf-v6-u-mb-sm">{_("Step 1: EdgeRouter CLI commands")}</Title>
                            <p className="pf-v6-u-mb-sm">{_("SSH into your EdgeRouter and run:")}</p>
                            <ClipboardCopy isBlock variant="expansion">{edgeRouterCommands}</ClipboardCopy>

                            <Title headingLevel="h4" className="pf-v6-u-mt-md pf-v6-u-mb-sm">{_("Step 2: Configure ntopng to receive NetFlow")}</Title>
                            <ClipboardCopy isBlock variant="expansion">{ntopngNetflowCommand}</ClipboardCopy>

                            <Alert variant="info" title={_("Notes")} className="pf-v6-u-mt-md">
                                <ul>
                                    <li>{_("Change 'eth0'/'eth1' to match your WAN/LAN interfaces on the EdgeRouter")}</li>
                                    <li>{_("ntopng Community edition supports NetFlow collection")}</li>
                                    <li>{_("For nProbe (more detailed flow analysis), a license is needed")}</li>
                                    <li>{_("After configuration, ntopng will show per-device traffic including your fridge, IoT devices, etc.")}</li>
                                </ul>
                            </Alert>
                        </div>
                    )}
                </CardBody>
            </Card>

            {/* Dashboard - only shown when connected */}
            {status?.connected && activeInstance && (
                <>
                    <Title headingLevel="h2" className="pf-v6-u-mb-md">
                        {_("Traffic Dashboard")} — {activeInstance.label}
                        {status.interfaces && status.interfaces.length > 1 && (
                            <span style={{ fontSize: "0.8em", marginLeft: "1rem" }}>
                                {status.interfaces.map(iface => (
                                    <Button
                                        key={iface.ifid}
                                        variant={iface.ifid === activeIfid ? "primary" : "link"}
                                        size="sm"
                                        className="pf-v6-u-mr-sm"
                                        onClick={() => { setActiveIfid(iface.ifid); loadDashboardData(activeInstance, iface.ifid) }}
                                    >
                                        {iface.ifname}
                                    </Button>
                                ))}
                            </span>
                        )}
                    </Title>

                    {/* Interface summary */}
                    {ifaceData && (
                        <Card className="pf-v6-u-mb-md">
                            <CardTitle>{_("Interface Summary")}</CardTitle>
                            <CardBody>
                                <DescriptionList isHorizontal>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Traffic (TX/RX)")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            ↑ {formatBytes(ifaceData.bytes_sent || 0)} / ↓ {formatBytes(ifaceData.bytes_rcvd || 0)}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Throughput")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {formatBytes(ifaceData.throughput_bps || 0)}/s
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Active Hosts")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {ifaceData.num_hosts || 0} ({ifaceData.num_local_hosts || 0} {_("local")})
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Active Flows")}</DescriptionListTerm>
                                        <DescriptionListDescription>{ifaceData.num_flows || 0}</DescriptionListDescription>
                                    </DescriptionListGroup>
                                    <DescriptionListGroup>
                                        <DescriptionListTerm>{_("Packets")}</DescriptionListTerm>
                                        <DescriptionListDescription>
                                            {(ifaceData.packets || 0).toLocaleString()}
                                        </DescriptionListDescription>
                                    </DescriptionListGroup>
                                </DescriptionList>
                            </CardBody>
                        </Card>
                    )}

                    <Grid hasGutter>
                        {/* Top Local Talkers */}
                        <GridItem span={6}>
                            <Card className="pf-v6-u-mb-md">
                                <CardTitle>{_("Top Local Talkers")}</CardTitle>
                                <CardBody>
                                    {topLocalTalkers.length > 0
                                        ? (
                                            <table className="pf-v6-c-table pf-m-compact">
                                                <thead>
                                                    <tr>
                                                        <th>{_("Host")}</th>
                                                        <th>{_("Traffic")}</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {topLocalTalkers.map((t, i) => (
                                                        <tr key={i}>
                                                            <td>{t.label || t.address}</td>
                                                            <td>{formatBytes(t.traffic || 0)}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        )
                                        : <em>{_("No data (Pro license may be required for this endpoint)")}</em>}
                                </CardBody>
                            </Card>
                        </GridItem>

                        {/* Top Remote Talkers */}
                        <GridItem span={6}>
                            <Card className="pf-v6-u-mb-md">
                                <CardTitle>{_("Top Remote Destinations")}</CardTitle>
                                <CardBody>
                                    {topRemoteTalkers.length > 0
                                        ? (
                                            <table className="pf-v6-c-table pf-m-compact">
                                                <thead>
                                                    <tr>
                                                        <th>{_("Host")}</th>
                                                        <th>{_("Traffic")}</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {topRemoteTalkers.map((t, i) => (
                                                        <tr key={i}>
                                                            <td>{t.label || t.address}</td>
                                                            <td>{formatBytes(t.traffic || 0)}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        )
                                        : <em>{_("No data (Pro license may be required for this endpoint)")}</em>}
                                </CardBody>
                            </Card>
                        </GridItem>
                    </Grid>

                    {/* Active Flows */}
                    <Card className="pf-v6-u-mb-md">
                        <CardTitle>{_("Active Flows")} ({activeFlows.length})</CardTitle>
                        <CardBody>
                            {activeFlows.length > 0
                                ? (
                                    <div style={{ maxHeight: "400px", overflowY: "auto" }}>
                                        <table className="pf-v6-c-table pf-m-compact">
                                            <thead>
                                                <tr>
                                                    <th>{_("Client")}</th>
                                                    <th>{_("Server")}</th>
                                                    <th>{_("Protocol")}</th>
                                                    <th>{_("Traffic")}</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {activeFlows.map((f, i) => (
                                                    <tr key={i}>
                                                        <td>{f.client}</td>
                                                        <td>{f.server}</td>
                                                        <td><strong>{f.l7proto}</strong></td>
                                                        <td>{formatBytes(f.bytes)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )
                                : <em>{_("No active flows found or unable to fetch.")}</em>}
                        </CardBody>
                    </Card>

                    {/* Link to full ntopng UI */}
                    <Card>
                        <CardBody>
                            <Button
                                variant="primary"
                                component="a"
                                href={isHttpUrl(activeInstance.url) ? activeInstance.url : undefined}
                                target="_blank"
                            >
                                {_("Open Full ntopng Dashboard")} ↗
                            </Button>
                            <span className="pf-v6-u-ml-md">{activeInstance.url}</span>
                        </CardBody>
                    </Card>
                </>
            )}

            {status && !status.connected && activeInstance && (
                <Alert variant="warning" title={_("Cannot connect to ntopng")} className="pf-v6-u-mt-md">
                    {status.error || _("Check that ntopng is running and accessible at ") + activeInstance.url}
                </Alert>
            )}
        </>
    );
};
