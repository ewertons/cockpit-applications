import React, { useEffect, useState } from 'react';
import { Nav, NavItem, NavList } from "@patternfly/react-core/dist/esm/components/Nav/index.js";
import { Page, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Sidebar, SidebarContent, SidebarPanel } from "@patternfly/react-core/dist/esm/components/Sidebar/index.js";

import cockpit from 'cockpit';

import { TunnelsPage } from './tunnels-page.jsx';
import { TunnelDetailPage } from './tunnel-detail-page.jsx';
import { SettingsPage } from './settings-page.jsx';

const _ = cockpit.gettext;

type AppPage = "tunnels" | "detail" | "settings";

interface LocationState {
    page: AppPage;
    tunnel?: string;
}

function parseLocation(): LocationState {
    const path = cockpit.location.path;

    if (path.length >= 1 && path[0] === "tunnels") {
        if (path[1])
            return { page: "detail", tunnel: path[1] };
        return { page: "tunnels" };
    }
    if (path.length >= 1 && path[0] === "settings")
        return { page: "settings" };

    return { page: "tunnels" };
}

export const Application = () => {
    const [location, setLocation] = useState<LocationState>(parseLocation);

    useEffect(() => {
        const handler = () => setLocation(parseLocation());
        cockpit.addEventListener("locationchanged", handler);
        return () => cockpit.removeEventListener("locationchanged", handler);
    }, []);

    const navigate = (itemId: string) => {
        cockpit.location.go(itemId === "tunnels" ? [] : [itemId]);
    };

    const sidebar = (
        <Nav onSelect={(_e, result) => navigate(result.itemId as string)}>
            <NavList>
                <NavItem itemId="tunnels" isActive={location.page === "tunnels" || location.page === "detail"}>
                    {_("Tunnels")}
                </NavItem>
                <NavItem itemId="settings" isActive={location.page === "settings"}>
                    {_("Settings")}
                </NavItem>
            </NavList>
        </Nav>
    );

    let content;
    switch (location.page) {
    case "detail":
        content = <TunnelDetailPage tunnelName={location.tunnel!} />;
        break;
    case "settings":
        content = <SettingsPage />;
        break;
    case "tunnels":
    default:
        content = <TunnelsPage />;
    }

    // Page's own sidebar slot only becomes a real column above 1200px; below that
    // it overlays the content, which an app inside a Cockpit frame practically
    // always is. Sidebar lays out in flow instead.
    return (
        <Page className="wireguard-app">
            <PageSection>
                <Sidebar hasGutter hasNoBackground>
                    <SidebarPanel variant="sticky" className="wg-nav">
                        {sidebar}
                    </SidebarPanel>
                    <SidebarContent hasNoBackground>
                        {content}
                    </SidebarContent>
                </Sidebar>
            </PageSection>
        </Page>
    );
};
