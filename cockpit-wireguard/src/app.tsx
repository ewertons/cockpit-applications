import React, { useEffect, useState } from 'react';
import { Nav, NavItem, NavList } from "@patternfly/react-core/dist/esm/components/Nav/index.js";
import { Page, PageSection, PageSidebar, PageSidebarBody } from "@patternfly/react-core/dist/esm/components/Page/index.js";

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
        <PageSidebar>
            <PageSidebarBody>
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
            </PageSidebarBody>
        </PageSidebar>
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

    return (
        <div className="wireguard-app">
            <Page sidebar={sidebar}>
                <PageSection>
                    {content}
                </PageSection>
            </Page>
        </div>
    );
};
