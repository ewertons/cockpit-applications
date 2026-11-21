import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";

import cockpit from 'cockpit';

import { PageHeader, SimpleTable } from '../components.jsx';
import { ForeignTable, SHARED_HOOKS } from '../coexistence.js';
import { detectOtherFirewallManagers, listForeignTables } from '../firewall-backend.js';
import { NFTABLES_CONFIGURATION_PATH, foreignPartOfFile } from '../nftables-file.js';

const _ = cockpit.gettext;

/** Read-only list of nftables tables owned by other software and of the rest of /etc/nftables.conf. */
export const OtherTablesPage = ({ fileText }: { fileText: string | null }) => {
    const [tables, setTables] = useState<ForeignTable[] | null>(null);
    const [managers, setManagers] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setError(null);
        try {
            setManagers(await detectOtherFirewallManagers());
            setTables(await listForeignTables());
        } catch (listError) {
            setError(String((listError as Error)?.message ?? listError));
            setTables([]);
        }
    }, []);

    useEffect(() => { refresh() }, [refresh]);

    return (
        <>
            <PageHeader
                title={_("Other tables")}
                description={_("nftables tables not managed by this app (read-only).")}
                actions={<Button variant="secondary" onClick={refresh}>{_("Refresh")}</Button>}
            />
            <Alert variant="info" isInline className="fw-alert" title={_("Every base chain on a hook sees the packet")}>
                {_("nftables evaluates base chains of all tables on the same hook in priority order. An accept only ends evaluation in its own chain, while a drop anywhere is final. A rule allowed here can still be dropped by another table.")}
            </Alert>
            {managers.length > 0 && (
                <Alert variant="warning" isInline className="fw-alert" title={cockpit.format(_("Running: $0"), managers.join(", "))}>
                    {_("These managers own their own tables and may flush the whole ruleset when they reload, removing this app's table until nftables.service is restarted or the host reboots.")}
                </Alert>
            )}
            {error && <Alert variant="danger" isInline title={error} className="fw-alert" />}
            {tables === null && <Spinner aria-label={_("Loading")} />}
            {tables?.length === 0 && !error && <p className="fw-muted">{_("No other tables with chains are loaded.")}</p>}
            {tables?.map(table => (
                <Card isCompact className="fw-card" key={`${table.family} ${table.name}`}>
                    <CardTitle>{`table ${table.family} ${table.name}`}</CardTitle>
                    <CardBody>
                        <p className="fw-muted">{cockpit.format(_("$0 chain(s), $1 base chain(s)"), table.chainCount, table.baseChains.length)}</p>
                        <SimpleTable
                            headers={[_("Base chain"), _("Type"), _("Hook"), _("Priority"), _("Policy")]}
                            emptyText={_("No base chains (not attached to any hook).")}
                            rows={table.baseChains.map(chain => [
                                chain.name,
                                chain.type,
                                chain.hook,
                                String(chain.priority),
                                chain.policy === "drop" && SHARED_HOOKS.includes(chain.hook)
                                    ? <Label key="policy" color="red" isCompact>{chain.policy}</Label>
                                    : chain.policy,
                            ])}
                        />
                    </CardBody>
                </Card>
            ))}
            <Card isCompact className="fw-card">
                <CardTitle>{cockpit.format(_("Other content of $0"), NFTABLES_CONFIGURATION_PATH)}</CardTitle>
                <CardBody>
                    <p className="fw-muted">{_("Kept unchanged by Apply. Edit it by hand if needed.")}</p>
                    <pre className="fw-diff">{fileText === null ? _("The file does not exist.") : foreignPartOfFile(fileText).trim() || _("Nothing else.")}</pre>
                </CardBody>
            </Card>
        </>
    );
};
