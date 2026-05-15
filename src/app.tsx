import React, { useEffect, useState } from 'react';
import { Page, PageSection, PageSidebar, PageSidebarBody } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Nav, NavItem, NavList } from "@patternfly/react-core/dist/esm/components/Nav/index.js";

import cockpit from 'cockpit';

import { RepositoriesPage } from './repositories-page.jsx';
import { RepositoryDetail } from './repository-detail.jsx';
import { ServicesPage } from './services-page.jsx';
import { AccessPage } from './access-page.jsx';
import { RepoBrowser } from './repo-browser.jsx';

const _ = cockpit.gettext;

type AppPage = "repositories" | "services" | "access" | "repo-detail" | "repo-browser";

interface LocationState {
    page: AppPage;
    repo?: string;
    ref?: string;
    path?: string;
    commitHash?: string;
}

function parseLocation(): LocationState {
    const loc = cockpit.location;
    const path = loc.path;

    if (path.length >= 3 && path[0] === "repo" && path[1] === "browse") {
        return {
            page: "repo-browser",
            repo: decodeURIComponent(path[1]),
            ref: loc.options.ref || "HEAD",
            path: loc.options.path || "",
            commitHash: loc.options.commit || "",
        };
    }
    if (path.length >= 2 && path[0] === "repo") {
        const subpage = path.length >= 3 ? path[2] : "";
        return {
            page: subpage === "browse" ? "repo-browser" : "repo-detail",
            repo: decodeURIComponent(path[1]),
            ref: loc.options.ref || "HEAD",
            path: loc.options.path || "",
            commitHash: loc.options.commit || "",
        };
    }
    if (path.length >= 1 && path[0] === "services") {
        return { page: "services" };
    }
    if (path.length >= 1 && path[0] === "access") {
        return { page: "access" };
    }
    return { page: "repositories" };
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
                        <NavItem itemId="/" isActive={location.page === "repositories"}>
                            {_("Repositories")}
                        </NavItem>
                        <NavItem itemId="/services" isActive={location.page === "services"}>
                            {_("Services")}
                        </NavItem>
                        <NavItem itemId="/access" isActive={location.page === "access"}>
                            {_("Access Control")}
                        </NavItem>
                    </NavList>
                </Nav>
            </PageSidebarBody>
        </PageSidebar>
    );

    let content;
    switch (location.page) {
    case "repositories":
        content = <RepositoriesPage />;
        break;
    case "repo-detail":
        content = <RepositoryDetail repoName={location.repo!} />;
        break;
    case "repo-browser":
        content = <RepoBrowser repoName={location.repo!} currentRef={location.ref || "HEAD"} currentPath={location.path || ""} commitHash={location.commitHash || ""} />;
        break;
    case "services":
        content = <ServicesPage />;
        break;
    case "access":
        content = <AccessPage />;
        break;
    default:
        content = <RepositoriesPage />;
    }

    return (
        <Page sidebar={sidebar}>
            <PageSection>
                {content}
            </PageSection>
        </Page>
    );
};
