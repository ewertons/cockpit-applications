import React, { useEffect, useState } from 'react';
import { Page, PageSection, PageSidebar, PageSidebarBody } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Nav, NavItem, NavList, NavGroup } from "@patternfly/react-core/dist/esm/components/Nav/index.js";

import cockpit from 'cockpit';

import { OverviewPage } from './pages/overview-page.jsx';
import { FirewallPage } from './pages/firewall-page.jsx';
import { NetworkMonitorPage } from './pages/network-monitor-page.jsx';
import { SELinuxPage } from './pages/selinux-page.jsx';
import { Fail2BanPage } from './pages/fail2ban-page.jsx';
import { AuditLogPage } from './pages/audit-log-page.jsx';
import { SSHHardeningPage } from './pages/ssh-hardening-page.jsx';
import { UserSecurityPage } from './pages/user-security-page.jsx';
import { SystemUpdatesPage } from './pages/system-updates-page.jsx';
import { IntrusionDetectionPage } from './pages/intrusion-detection-page.jsx';
import { CertificatesPage } from './pages/certificates-page.jsx';
import { OpenPortsPage } from './pages/open-ports-page.jsx';
import { NtopngPage } from './pages/ntopng-page.jsx';

const _ = cockpit.gettext;

type AppPage =
    | "overview"
    | "firewall"
    | "network-monitor"
    | "selinux"
    | "fail2ban"
    | "audit-log"
    | "ssh-hardening"
    | "user-security"
    | "system-updates"
    | "intrusion-detection"
    | "certificates"
    | "open-ports"
    | "ntopng";

function parseLocation(): AppPage {
    const loc = cockpit.location;
    const path = loc.path;

    if (path.length >= 1) {
        const page = path[0] as AppPage;
        const validPages: AppPage[] = [
            "overview", "firewall", "network-monitor", "selinux",
            "fail2ban", "audit-log", "ssh-hardening", "user-security",
            "system-updates", "intrusion-detection", "certificates", "open-ports",
            "ntopng"
        ];
        if (validPages.includes(page)) {
            return page;
        }
    }
    return "overview";
}

export const Application = () => {
    const [currentPage, setCurrentPage] = useState<AppPage>(parseLocation);

    useEffect(() => {
        const handler = () => setCurrentPage(parseLocation());
        cockpit.addEventListener("locationchanged", handler);
        return () => cockpit.removeEventListener("locationchanged", handler);
    }, []);

    const navigate = (page: string) => {
        cockpit.location.go([page]);
    };

    const renderPage = () => {
        switch (currentPage) {
        case "overview": return <OverviewPage />;
        case "firewall": return <FirewallPage />;
        case "network-monitor": return <NetworkMonitorPage />;
        case "selinux": return <SELinuxPage />;
        case "fail2ban": return <Fail2BanPage />;
        case "audit-log": return <AuditLogPage />;
        case "ssh-hardening": return <SSHHardeningPage />;
        case "user-security": return <UserSecurityPage />;
        case "system-updates": return <SystemUpdatesPage />;
        case "intrusion-detection": return <IntrusionDetectionPage />;
        case "certificates": return <CertificatesPage />;
        case "open-ports": return <OpenPortsPage />;
        case "ntopng": return <NtopngPage />;
        default: return <OverviewPage />;
        }
    };

    const sidebar = (
        <PageSidebar>
            <PageSidebarBody>
                <Nav onSelect={(_e, result) => navigate(result.itemId as string)}>
                    <NavList>
                        <NavItem itemId="overview" isActive={currentPage === "overview"}>
                            {_("Overview")}
                        </NavItem>
                    </NavList>
                    <NavGroup title={_("Network")}>
                        <NavList>
                            <NavItem itemId="firewall" isActive={currentPage === "firewall"}>
                                {_("Firewall")}
                            </NavItem>
                            <NavItem itemId="network-monitor" isActive={currentPage === "network-monitor"}>
                                {_("Network Monitor")}
                            </NavItem>
                            <NavItem itemId="open-ports" isActive={currentPage === "open-ports"}>
                                {_("Open Ports")}
                            </NavItem>
                            <NavItem itemId="ntopng" isActive={currentPage === "ntopng"}>
                                {_("Traffic Monitor")}
                            </NavItem>
                        </NavList>
                    </NavGroup>
                    <NavGroup title={_("Access Control")}>
                        <NavList>
                            <NavItem itemId="selinux" isActive={currentPage === "selinux"}>
                                {_("SELinux / AppArmor")}
                            </NavItem>
                            <NavItem itemId="fail2ban" isActive={currentPage === "fail2ban"}>
                                {_("Fail2Ban")}
                            </NavItem>
                            <NavItem itemId="ssh-hardening" isActive={currentPage === "ssh-hardening"}>
                                {_("SSH Hardening")}
                            </NavItem>
                            <NavItem itemId="user-security" isActive={currentPage === "user-security"}>
                                {_("Users & Auth")}
                            </NavItem>
                        </NavList>
                    </NavGroup>
                    <NavGroup title={_("Monitoring")}>
                        <NavList>
                            <NavItem itemId="audit-log" isActive={currentPage === "audit-log"}>
                                {_("Audit Logs")}
                            </NavItem>
                            <NavItem itemId="intrusion-detection" isActive={currentPage === "intrusion-detection"}>
                                {_("Intrusion Detection")}
                            </NavItem>
                        </NavList>
                    </NavGroup>
                    <NavGroup title={_("Maintenance")}>
                        <NavList>
                            <NavItem itemId="system-updates" isActive={currentPage === "system-updates"}>
                                {_("System Updates")}
                            </NavItem>
                            <NavItem itemId="certificates" isActive={currentPage === "certificates"}>
                                {_("Certificates")}
                            </NavItem>
                        </NavList>
                    </NavGroup>
                </Nav>
            </PageSidebarBody>
        </PageSidebar>
    );

    return (
        <div className="security-app">
            <Page sidebar={sidebar}>
                <PageSection>
                    {renderPage()}
                </PageSection>
            </Page>
        </div>
    );
};
