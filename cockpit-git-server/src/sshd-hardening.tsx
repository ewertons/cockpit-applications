import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;

const GIT_SSHD_CONFIG_PATH = "/etc/ssh/sshd_config.d/10-git.conf";
const GIT_SSHD_CONFIG = [
    "Match User git",
    "    PasswordAuthentication no",
    "    KbdInteractiveAuthentication no",
    "    AllowTcpForwarding no",
    "    X11Forwarding no",
    "    PermitTTY no",
    "",
].join("\n");

const CHECKED_SETTINGS = [
    "passwordauthentication",
    "kbdinteractiveauthentication",
    "allowtcpforwarding",
    "x11forwarding",
    "permittty",
];

const SSHD_PATH_PREFIX = 'PATH="$PATH:/usr/sbin:/sbin"';

// Writes the drop-in, and only reloads sshd when "sshd -t" accepts the result;
// otherwise the previous file (or its absence) is restored.
const APPLY_SCRIPT = [
    'set -e',
    SSHD_PATH_PREFIX,
    'conf="$1"',
    'backup=$(mktemp)',
    'trap \'rm -f "$backup" "$conf.tmp"\' EXIT',
    'existed=0',
    'if [ -e "$conf" ]; then cp -p "$conf" "$backup"; existed=1; fi',
    'install -d -m 0755 "$(dirname "$conf")"',
    'printf "%s" "$2" > "$conf.tmp"',
    'chmod 0644 "$conf.tmp"',
    'mv -f "$conf.tmp" "$conf"',
    'if ! sshd -t; then',
    '    if [ "$existed" = 1 ]; then cp -p "$backup" "$conf"; else rm -f "$conf"; fi',
    '    echo "sshd configuration test failed; changes were reverted" >&2',
    '    exit 1',
    'fi',
    'systemctl reload ssh.service 2>/dev/null || systemctl reload sshd.service',
].join("\n");

async function readGitUserSettings(): Promise<Record<string, string>> {
    const output = await cockpit.spawn(
        ["/bin/sh", "-c", SSHD_PATH_PREFIX + '; exec sshd -T -C "user=git,host=localhost,addr=127.0.0.1"'],
        { superuser: "require", err: "message" });
    const settings: Record<string, string> = {};
    for (const line of output.split("\n")) {
        const [name, ...value] = line.trim().split(/\s+/);
        if (name)
            settings[name.toLowerCase()] = value.join(" ").toLowerCase();
    }
    return settings;
}

export const SshdHardeningCard = () => {
    const [settings, setSettings] = useState<Record<string, string> | null>(null);
    const [error, setError] = useState("");
    const [applying, setApplying] = useState(false);

    const load = useCallback(() => {
        readGitUserSettings()
                .then(values => setSettings(values))
                .catch((ex: cockpit.BasicError) => {
                    setSettings({});
                    setError(ex.message || String(ex));
                });
    }, []);

    useEffect(() => { load() }, [load]);

    const apply = () => {
        setApplying(true);
        setError("");
        cockpit.spawn(["/bin/sh", "-c", APPLY_SCRIPT, "sh", GIT_SSHD_CONFIG_PATH, GIT_SSHD_CONFIG],
                      { superuser: "require", err: "message" })
                .then(() => load())
                .catch((ex: cockpit.BasicError) => setError(ex.message || String(ex)))
                .finally(() => setApplying(false));
    };

    const allDisabled = settings !== null && CHECKED_SETTINGS.every(name => settings[name] === "no");

    return (
        <Card>
            <CardTitle>{_("SSH server settings for the git user")}</CardTitle>
            <CardBody>
                {error && <Alert variant="danger" title={error} isInline style={{ marginBottom: "1rem" }} />}
                {settings === null
                    ? <Spinner size="md" aria-label={_("Loading")} />
                    : (
                        <>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "1rem" }}>
                                {CHECKED_SETTINGS.map(name => (
                                    <Label key={name} color={settings[name] === "no" ? "green" : "orange"}>
                                        {`${name} ${settings[name] || "?"}`}
                                    </Label>
                                ))}
                            </div>
                            {!allDisabled && (
                                <>
                                    <p style={{ marginBottom: "0.5rem" }}>
                                        {cockpit.format(_("Write $0 with the settings below, test the configuration with sshd -t and reload sshd only if the test passes."), GIT_SSHD_CONFIG_PATH)}
                                    </p>
                                    <pre style={{ marginBottom: "0.5rem" }}>{GIT_SSHD_CONFIG}</pre>
                                    <Button variant="secondary" onClick={apply} isLoading={applying} isDisabled={applying}>
                                        {_("Apply recommended settings")}
                                    </Button>
                                </>
                            )}
                        </>
                    )}
            </CardBody>
        </Card>
    );
};
