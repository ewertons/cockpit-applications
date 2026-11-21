import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Nav, NavItem, NavList } from "@patternfly/react-core/dist/esm/components/Nav/index.js";
import { Page, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Sidebar, SidebarContent, SidebarPanel } from "@patternfly/react-core/dist/esm/components/Sidebar/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";

import cockpit from 'cockpit';

import { readHostFiles } from './firewall-backend.js';
import { DerivedState, HostFiles, deriveState } from './firewall-state.js';
import { FirewallConfiguration } from './model.js';
import { ApplyPage } from './pages/apply-page.jsx';
import { ObjectsPage } from './pages/objects-page.jsx';
import { OtherTablesPage } from './pages/other-tables-page.jsx';
import { RulesPage } from './pages/rules-page.jsx';

const _ = cockpit.gettext;

type ApplicationPage = "apply" | "objects" | "rules" | "other-tables";

const PAGES: ApplicationPage[] = ["apply", "objects", "rules", "other-tables"];

function pageFromLocation(): ApplicationPage {
    const first = cockpit.location.path[0];
    return PAGES.find(page => page === first) ?? "apply";
}

/** Props shared by pages that edit the configuration. */
export interface ConfigurationPageProps {
    configuration: FirewallConfiguration;
    /** Replaces the draft, or derives it from the latest draft (use after awaiting, so concurrent edits are kept). */
    onChange: (change: FirewallConfiguration | ((latest: FirewallConfiguration) => FirewallConfiguration)) => void;
}

/** Host files and what was derived from them. */
export interface LoadedHostState {
    files: HostFiles;
    derived: DerivedState;
}

export const Application = () => {
    const [page, setPage] = useState<ApplicationPage>(pageFromLocation);
    const [hostState, setHostState] = useState<LoadedHostState | null>(null);
    const [configuration, setConfiguration] = useState<FirewallConfiguration | null>(null);
    const [error, setError] = useState<string | null>(null);
    const latestConfiguration = useRef<FirewallConfiguration | null>(null);

    useEffect(() => {
        const handler = () => setPage(pageFromLocation());
        cockpit.addEventListener("locationchanged", handler);
        return () => cockpit.removeEventListener("locationchanged", handler);
    }, []);

    /** Re-reads the host. With `resetDraft`, the editor restarts from the host's configuration. */
    const reload = useCallback(async (resetDraft: boolean) => {
        try {
            const files = await readHostFiles();
            const derived = deriveState(files);
            setHostState({ files, derived });
            if (resetDraft || !latestConfiguration.current) {
                latestConfiguration.current = derived.initialConfiguration;
                setConfiguration(derived.initialConfiguration);
            }
            setError(null);
        } catch (loadError) {
            setError(cockpit.format(_("Cannot read the firewall state: $0"), String((loadError as Error)?.message ?? loadError)));
        }
    }, []);

    useEffect(() => { reload(true) }, [reload]);

    const onChange = useCallback((change: FirewallConfiguration | ((latest: FirewallConfiguration) => FirewallConfiguration)) => {
        const latest = latestConfiguration.current;
        if (typeof change === "function" && !latest)
            return;
        const updated = typeof change === "function" ? change(latest!) : change;
        latestConfiguration.current = updated;
        setConfiguration(updated);
    }, []);

    const navigation = (
        <Nav onSelect={(_event, result) => cockpit.location.go(result.itemId === "apply" ? [] : [String(result.itemId)])}>
            <NavList>
                <NavItem itemId="apply" isActive={page === "apply"}>{_("Status & apply")}</NavItem>
                <NavItem itemId="objects" isActive={page === "objects"}>{_("Zones & objects")}</NavItem>
                <NavItem itemId="rules" isActive={page === "rules"}>{_("Rules")}</NavItem>
                <NavItem itemId="other-tables" isActive={page === "other-tables"}>{_("Other tables")}</NavItem>
            </NavList>
        </Nav>
    );

    let content;
    if (!configuration || !hostState)
        content = error ? null : <Spinner aria-label={_("Loading")} />;
    else if (page === "objects")
        content = <ObjectsPage configuration={configuration} onChange={onChange} />;
    else if (page === "rules")
        content = <RulesPage configuration={configuration} onChange={onChange} />;
    else if (page === "other-tables")
        content = <OtherTablesPage fileText={hostState.files.fileText} />;
    else
        content = <ApplyPage configuration={configuration} hostState={hostState} onReload={reload} />;

    return (
        <Page className="firewall-app">
            <PageSection>
                <Sidebar hasGutter hasNoBackground>
                    <SidebarPanel variant="sticky" className="fw-nav">
                        {navigation}
                    </SidebarPanel>
                    <SidebarContent hasNoBackground>
                        {error && <Alert variant="danger" isInline title={error} className="fw-alert" />}
                        {content}
                    </SidebarContent>
                </Sidebar>
            </PageSection>
        </Page>
    );
};
