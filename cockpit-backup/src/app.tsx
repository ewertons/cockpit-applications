import React, { useEffect, useState } from 'react';
import { Page, PageSection, PageSidebar, PageSidebarBody } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Nav, NavItem, NavList } from "@patternfly/react-core/dist/esm/components/Nav/index.js";

import cockpit from 'cockpit';

import { BackupProvider } from './backup-context.jsx';
import { JobsPage } from './jobs-page.jsx';
import { SnapshotsPage } from './snapshots-page.jsx';
import { DestinationsPage } from './destinations-page.jsx';
import { StatusPage } from './status-page.jsx';

const _ = cockpit.gettext;

type AppPage = "status" | "jobs" | "snapshots" | "destinations";

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
        <PageSidebar>
            <PageSidebarBody>
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
                    </NavList>
                </Nav>
            </PageSidebarBody>
        </PageSidebar>
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
    default:
        content = <StatusPage />;
    }

    return (
        <BackupProvider>
            <Page sidebar={sidebar}>
                <PageSection>
                    {content}
                </PageSection>
            </Page>
        </BackupProvider>
    );
};
