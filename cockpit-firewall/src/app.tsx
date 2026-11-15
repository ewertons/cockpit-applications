import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Nav, NavItem, NavList } from "@patternfly/react-core/dist/esm/components/Nav/index.js";
import { Page, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Sidebar, SidebarContent, SidebarPanel } from "@patternfly/react-core/dist/esm/components/Sidebar/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";

import cockpit from 'cockpit';

import { loadConfiguration, saveConfiguration } from './firewall-backend.js';
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
    onChange: (configuration: FirewallConfiguration) => void;
}

export const Application = () => {
    const [page, setPage] = useState<ApplicationPage>(pageFromLocation);
    const [configuration, setConfiguration] = useState<FirewallConfiguration | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const handler = () => setPage(pageFromLocation());
        cockpit.addEventListener("locationchanged", handler);
        return () => cockpit.removeEventListener("locationchanged", handler);
    }, []);

    useEffect(() => {
        loadConfiguration()
                .then(setConfiguration)
                .catch(loadError => setError(cockpit.format(_("Cannot read the configuration: $0"), String(loadError?.message ?? loadError))));
    }, []);

    const onChange = useCallback((updated: FirewallConfiguration) => {
        setConfiguration(updated);
        saveConfiguration(updated)
                .then(() => setError(null))
                .catch(saveError => setError(cockpit.format(_("Cannot save the configuration: $0"), String(saveError?.message ?? saveError))));
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
    if (!configuration)
        content = error ? null : <Spinner aria-label={_("Loading")} />;
    else if (page === "objects")
        content = <ObjectsPage configuration={configuration} onChange={onChange} />;
    else if (page === "rules")
        content = <RulesPage configuration={configuration} onChange={onChange} />;
    else if (page === "other-tables")
        content = <OtherTablesPage />;
    else
        content = <ApplyPage configuration={configuration} />;

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
