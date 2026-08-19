import React, { useEffect, useState } from 'react';
import { Page, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Sidebar, SidebarContent, SidebarPanel } from "@patternfly/react-core/dist/esm/components/Sidebar/index.js";
import { Nav, NavItem, NavList } from "@patternfly/react-core/dist/esm/components/Nav/index.js";

import cockpit from 'cockpit';

import { BackupProvider } from './backup-context.jsx';
import { JobsPage } from './jobs-page.jsx';
import { SnapshotsPage } from './snapshots-page.jsx';
import { DestinationsPage } from './destinations-page.jsx';
import { LogsPage } from './logs-page.jsx';
import { StatusPage } from './status-page.jsx';

const _ = cockpit.gettext;

type AppPage = "status" | "jobs" | "snapshots" | "destinations" | "logs";

interface LocationState {
    page: AppPage;
    jobId?: string;
    snapshotId?: string;
    destinationId?: string;
}

function parseLocation(): LocationState {
    const loc = cockpit.location;
    const path = loc.path;

    if (path.length >= 1 && path[0] === "jobs") {
        return {
            page: "jobs",
            jobId: path[1] || undefined,
        };
    }
    if (path.length >= 1 && path[0] === "snapshots") {
        return {
            page: "snapshots",
            snapshotId: path[1] || undefined,
        };
    }
    if (path.length >= 1 && path[0] === "destinations") {
        return {
            page: "destinations",
            destinationId: path[1] || undefined,
        };
    }
    if (path.length >= 1 && path[0] === "logs") {
        return { page: "logs" };
    }
    // Default: status (dashboard)
    return { page: "status" };
}

export const Application = () => {
    const [location, setLocation] = useState<LocationState>(parseLocation);

    useEffect(() => {
        const handler = () => setLocation(parseLocation());
        cockpit.addEventListener("locationchanged", handler);
        return () => cockpit.removeEventListener("locationchanged", handler);
    }, []);

    const navigate = (hash: string) => {
        cockpit.location.go(hash.split("/").filter(Boolean));
    };

    const sidebar = (
        <Nav onSelect={(_e, result) => navigate(result.itemId as string)}>
            <NavList>
                <NavItem itemId="/" isActive={location.page === "status"}>
                    {_("Dashboard")}
                </NavItem>
                <NavItem itemId="/jobs" isActive={location.page === "jobs"}>
                    {_("Backup Jobs")}
                </NavItem>
                <NavItem itemId="/snapshots" isActive={location.page === "snapshots"}>
                    {_("Snapshots")}
                </NavItem>
                <NavItem itemId="/destinations" isActive={location.page === "destinations"}>
                    {_("Destinations")}
                </NavItem>
                <NavItem itemId="/logs" isActive={location.page === "logs"}>
                    {_("Logs")}
                </NavItem>
            </NavList>
        </Nav>
    );

    let content;
    switch (location.page) {
    case "status":
        content = <StatusPage />;
        break;
    case "jobs":
        content = <JobsPage jobId={location.jobId} />;
        break;
    case "snapshots":
        content = <SnapshotsPage snapshotId={location.snapshotId} />;
        break;
    case "destinations":
        content = <DestinationsPage destinationId={location.destinationId} />;
        break;
    case "logs":
        content = <LogsPage />;
        break;
    default:
        content = <StatusPage />;
    }

    // Page's own sidebar slot only becomes a real column above 1200px; below that
    // it overlays the content, which an app inside a Cockpit frame practically
    // always is. Sidebar lays out in flow instead.
    return (
        <BackupProvider>
            <Page className="backup-app">
                <PageSection>
                    <Sidebar hasGutter hasNoBackground>
                        <SidebarPanel variant="sticky" className="backup-nav">
                            {sidebar}
                        </SidebarPanel>
                        <SidebarContent hasNoBackground>
                            {content}
                        </SidebarContent>
                    </Sidebar>
                </PageSection>
            </Page>
        </BackupProvider>
    );
};
