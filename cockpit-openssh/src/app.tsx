import React, { useEffect, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Page, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Nav, NavItem, NavList } from "@patternfly/react-core/dist/esm/components/Nav/index.js";
import { Sidebar, SidebarContent, SidebarPanel } from "@patternfly/react-core/dist/esm/components/Sidebar/index.js";

import cockpit from 'cockpit';
import { WithDialogs } from 'dialogs';

import { ServerPage } from './server-page.jsx';
import { AuthorizedKeysPage } from './authorized-keys-page.jsx';
import { KnownHostsPage } from './known-hosts-page.jsx';

const _ = cockpit.gettext;

type AppPage = "server" | "authorized-keys" | "known-hosts";

function parseLocation(): AppPage {
    switch (cockpit.location.path[0]) {
    case "authorized-keys":
        return "authorized-keys";
    case "known-hosts":
        return "known-hosts";
    default:
        return "server";
    }
}

export const Application = () => {
    const [page, setPage] = useState<AppPage>(parseLocation);
    const [admin, setAdmin] = useState(true);

    useEffect(() => {
        const permission = cockpit.permission({ admin: true });
        let previous = permission.allowed;
        const update = () => {
            setAdmin(permission.allowed !== false);
            // Every page caches what it read at mount, so gaining or losing
            // access has to start them over.
            if (previous !== null && previous !== permission.allowed)
                window.location.reload();
            previous = permission.allowed;
        };
        update();
        permission.addEventListener("changed", update);
        return () => {
            permission.removeEventListener("changed", update);
            permission.close();
        };
    }, []);

    useEffect(() => {
        const handler = () => setPage(parseLocation());
        cockpit.addEventListener("locationchanged", handler);
        return () => cockpit.removeEventListener("locationchanged", handler);
    }, []);

    const navigate = (hash: string) => {
        cockpit.location.go(hash.split("/").filter(Boolean));
    };

    const sidebar = (
        <Nav onSelect={(_event, result) => navigate(result.itemId as string)}>
            <NavList>
                <NavItem itemId="/" isActive={page === "server"}>
                    {_("Server")}
                </NavItem>
                <NavItem itemId="/authorized-keys" isActive={page === "authorized-keys"}>
                    {_("Authorized keys")}
                </NavItem>
                <NavItem itemId="/known-hosts" isActive={page === "known-hosts"}>
                    {_("Known hosts")}
                </NavItem>
            </NavList>
        </Nav>
    );

    let content;
    switch (page) {
    case "authorized-keys":
        content = <AuthorizedKeysPage />;
        break;
    case "known-hosts":
        content = <KnownHostsPage />;
        break;
    default:
        content = <ServerPage />;
    }

    return (
        <WithDialogs>
            {/* Page's own sidebar slot only becomes a real column above 1200px; below
                that it overlays the content, which an app inside a Cockpit frame
                practically always is. Sidebar lays out in flow instead. */}
            <Page className="openssh-app">
                <PageSection>
                    {!admin && (
                        <Alert
                            variant="warning"
                            isInline
                            className="pf-v6-u-mb-lg"
                            title={_("Administrative access is required")}
                        >
                            {_("sshd_config, other accounts' authorized keys and the SSH service can only be read and changed as an administrator. Turn on administrative access in the account menu at the top right; until then most values will appear empty.")}
                        </Alert>
                    )}
                    <Sidebar hasGutter hasNoBackground>
                        <SidebarPanel variant="sticky" className="ssh-nav">
                            {sidebar}
                        </SidebarPanel>
                        <SidebarContent hasNoBackground>
                            {content}
                        </SidebarContent>
                    </Sidebar>
                </PageSection>
            </Page>
        </WithDialogs>
    );
};
