import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Nav, NavItem, NavList } from "@patternfly/react-core/dist/esm/components/Nav/index.js";
import { Page, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Sidebar, SidebarContent, SidebarPanel } from "@patternfly/react-core/dist/esm/components/Sidebar/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";

import cockpit from 'cockpit';

import { listShareNames } from './model.js';
import { ConfigurationPage } from './pages/configuration-page.jsx';
import { ConnectionsPage } from './pages/connections-page.jsx';
import { GlobalPage } from './pages/global-page.jsx';
import { LogsPage } from './pages/logs-page.jsx';
import { OverviewPage } from './pages/overview-page.jsx';
import { PendingChange, ReviewDialog } from './pages/review-dialog.jsx';
import { SharesPage } from './pages/shares-page.jsx';
import { UsersPage } from './pages/users-page.jsx';
import { errorMessage, readConfiguration, readPathsInformation } from './samba-backend.js';
import { ConfigurationDocument, getParameter, parseConfiguration } from './smb-conf.js';
import { ConfigurationSnapshot } from './transaction.js';
import { PathInformation } from './warnings.js';

const _ = cockpit.gettext;

type ApplicationPage = "overview" | "global" | "shares" | "users" | "connections" | "logs" | "configuration";

const PAGES: { page: ApplicationPage; label: string }[] = [
    { page: "overview", label: "Overview" },
    { page: "global", label: "Global settings" },
    { page: "shares", label: "Shares" },
    { page: "users", label: "Users" },
    { page: "connections", label: "Connections" },
    { page: "logs", label: "Logs" },
    { page: "configuration", label: "Configuration file" },
];

function pageFromLocation(): ApplicationPage {
    const first = cockpit.location.path[0];
    return PAGES.find(entry => entry.page === first)?.page ?? "overview";
}

/** Props shared by pages that read or change smb.conf. */
export interface ConfigurationPageProps {
    snapshot: ConfigurationSnapshot;
    document: ConfigurationDocument;
    /** Permissions of share paths, keyed by path. */
    paths: Record<string, PathInformation>;
    /** Opens the review dialog for a new smb.conf text. */
    onReview: (change: PendingChange) => void;
    /** Re-reads smb.conf and path information. */
    onReload: () => void;
}

export const Application = () => {
    const [page, setPage] = useState<ApplicationPage>(pageFromLocation);
    const [snapshot, setSnapshot] = useState<ConfigurationSnapshot | null>(null);
    const [paths, setPaths] = useState<Record<string, PathInformation>>({});
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<PendingChange | null>(null);

    useEffect(() => {
        const handler = () => setPage(pageFromLocation());
        cockpit.addEventListener("locationchanged", handler);
        return () => cockpit.removeEventListener("locationchanged", handler);
    }, []);

    const reload = useCallback(() => {
        readConfiguration()
                .then(loaded => {
                    setSnapshot(loaded);
                    setError(null);
                    const document = parseConfiguration(loaded.text);
                    const sharePaths = listShareNames(document).map(name => getParameter(document, name, "path") ?? "");
                    return readPathsInformation(sharePaths).then(setPaths);
                })
                .catch(loadError => setError(cockpit.format(_("Cannot read /etc/samba/smb.conf: $0"), errorMessage(loadError))));
    }, []);

    useEffect(reload, [reload]);

    const document = useMemo(() => snapshot ? parseConfiguration(snapshot.text) : null, [snapshot]);

    const navigation = (
        <Nav onSelect={(_event, result) => cockpit.location.go(result.itemId === "overview" ? [] : [String(result.itemId)])}>
            <NavList>
                {PAGES.map(entry => <NavItem key={entry.page} itemId={entry.page} isActive={page === entry.page}>{_(entry.label)}</NavItem>)}
            </NavList>
        </Nav>
    );

    let content;
    if (!snapshot || !document) {
        content = error ? null : <Spinner aria-label={_("Loading")} />;
    } else {
        const props: ConfigurationPageProps = { snapshot, document, paths, onReview: setPending, onReload: reload };
        if (page === "global")
            content = <GlobalPage key={snapshot.hash} {...props} />;
        else if (page === "shares")
            content = <SharesPage key={snapshot.hash} {...props} />;
        else if (page === "users")
            content = <UsersPage {...props} />;
        else if (page === "connections")
            content = <ConnectionsPage />;
        else if (page === "logs")
            content = <LogsPage />;
        else if (page === "configuration")
            content = <ConfigurationPage key={snapshot.hash} {...props} />;
        else
            content = <OverviewPage {...props} />;
    }

    return (
        <Page className="samba-app">
            <PageSection>
                <Sidebar hasGutter hasNoBackground>
                    <SidebarPanel variant="sticky" className="smb-nav">
                        {navigation}
                    </SidebarPanel>
                    <SidebarContent hasNoBackground>
                        {error && <Alert variant="danger" isInline title={error} className="smb-alert" />}
                        {snapshot && !snapshot.exists &&
                            <Alert variant="info" isInline className="smb-alert" title={_("/etc/samba/smb.conf does not exist yet. Applying a change creates it.")} />}
                        {content}
                    </SidebarContent>
                </Sidebar>
            </PageSection>
            {pending && snapshot &&
                <ReviewDialog
                    change={pending}
                    currentText={snapshot.text}
                    currentHash={snapshot.hash}
                    paths={paths}
                    onClose={() => setPending(null)}
                    onApplied={reload}
                />}
        </Page>
    );
};
