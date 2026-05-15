import React, { useCallback, useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Label, LabelGroup } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Tabs, Tab, TabTitleText } from "@patternfly/react-core/dist/esm/components/Tabs/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;
const BASE_PATH = "/srv/git";

interface RepositoryDetailProps {
    repoName: string;
}

export const RepositoryDetail = ({ repoName }: RepositoryDetailProps) => {
    const repoPath = `${BASE_PATH}/${repoName}`;
    const [branches, setBranches] = useState<string[]>([]);
    const [tags, setTags] = useState<string[]>([]);
    const [commits, setCommits] = useState<string[]>([]);
    const [config, setConfig] = useState<string[]>([]);
    const [description, setDescription] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [activeTab, setActiveTab] = useState(0);
    const [hostname, setHostname] = useState("localhost");

    useEffect(() => {
        const h = cockpit.file('/etc/hostname');
        h.watch(content => setHostname(content?.trim() ?? "localhost"));
        return h.close;
    }, []);

    const loadData = useCallback(() => {
        setLoading(true);
        setError("");

        const gitCmd = (args: string[]) =>
            cockpit.spawn(["git", "--git-dir", repoPath, ...args], { superuser: "try", err: "ignore" })
                    .catch(() => "");

        Promise.all([
            gitCmd(["branch"]),
            gitCmd(["tag"]),
            gitCmd(["log", "--oneline", "-20"]),
            gitCmd(["config", "--list"]),
            cockpit.file(`${repoPath}/description`).read()
                    .catch(() => ""),
        ]).then(([branchOut, tagOut, logOut, configOut, descOut]: [string, string, string, string, string]) => {
            setBranches(branchOut.trim().split("\n").filter(Boolean).map(b => b.replace(/^\*?\s*/, "")));
            setTags(tagOut.trim().split("\n").filter(Boolean));
            setCommits(logOut.trim().split("\n").filter(Boolean));
            setConfig(configOut.trim().split("\n").filter(Boolean));
            setDescription(descOut?.trim() || "");
            setLoading(false);
        }).catch((ex: cockpit.BasicError) => {
            setError(ex.message || String(ex));
            setLoading(false);
        });
    }, [repoPath]);

    useEffect(() => { loadData() }, [loadData]);

    const goBack = () => cockpit.location.go([]);
    const goBrowse = () => cockpit.location.go(["repo", encodeURIComponent(repoName), "browse"]);

    if (loading) return <Spinner aria-label={_("Loading")} />;

    return (
        <>
            <div className="repo-header">
                <div>
                    <Button variant="link" onClick={goBack}>← {_("Back")}</Button>
                    <CardTitle style={{ display: "inline", marginLeft: "1rem" }}>{repoName}</CardTitle>
                </div>
                <Button variant="secondary" onClick={goBrowse}>{_("Browse Files")}</Button>
            </div>

            {error && <Alert variant="danger" title={error} isInline />}

            <Card style={{ marginBottom: "1rem" }}>
                <CardBody>
                    <DescriptionList isHorizontal isCompact>
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Clone URL (SSH)")}</DescriptionListTerm>
                            <DescriptionListDescription>
                                <span className="clone-url">git@{hostname}:{repoPath}</span>
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Clone URL (git://)")}</DescriptionListTerm>
                            <DescriptionListDescription>
                                <span className="clone-url">git://{hostname}/{repoName}</span>
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                        {description && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Description")}</DescriptionListTerm>
                                <DescriptionListDescription>{description}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                    </DescriptionList>
                </CardBody>
            </Card>

            <Tabs activeKey={activeTab} onSelect={(_e, key) => setActiveTab(key as number)}>
                <Tab eventKey={0} title={<TabTitleText>{_("Branches")} ({branches.length})</TabTitleText>}>
                    <Card>
                        <CardBody>
                            {branches.length === 0
                                ? <p>{_("No branches (empty repository)")}</p>
                                : (
                                    <LabelGroup>
                                        {branches.map(b => <Label key={b} color="blue">{b}</Label>)}
                                    </LabelGroup>
                                )}
                        </CardBody>
                    </Card>
                </Tab>

                <Tab eventKey={1} title={<TabTitleText>{_("Tags")} ({tags.length})</TabTitleText>}>
                    <Card>
                        <CardBody>
                            {tags.length === 0
                                ? <p>{_("No tags")}</p>
                                : (
                                    <LabelGroup>
                                        {tags.map(t => <Label key={t} color="green">{t}</Label>)}
                                    </LabelGroup>
                                )}
                        </CardBody>
                    </Card>
                </Tab>

                <Tab eventKey={2} title={<TabTitleText>{_("Recent Commits")}</TabTitleText>}>
                    <Card>
                        <CardBody>
                            {commits.length === 0
                                ? <p>{_("No commits")}</p>
                                : (
                                    <ul style={{ listStyle: "none", padding: 0 }}>
                                        {commits.map((c, i) => {
                                            const parts = c.split(" ");
                                            const hash = parts[0];
                                            const msg = parts.slice(1).join(" ");
                                            return (
                                                <li key={i} style={{ padding: "0.25rem 0", borderBottom: "1px solid var(--pf-t--global--border--color--default)" }}>
                                                    <span className="commit-hash">{hash}</span>{" "}
                                                    {msg}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                        </CardBody>
                    </Card>
                </Tab>

                <Tab eventKey={3} title={<TabTitleText>{_("Configuration")}</TabTitleText>}>
                    <Card>
                        <CardBody>
                            {config.length === 0
                                ? <p>{_("No configuration")}</p>
                                : (
                                    <DescriptionList isHorizontal isCompact>
                                        {config.map((line, i) => {
                                            const [key, ...rest] = line.split("=");
                                            return (
                                                <DescriptionListGroup key={i}>
                                                    <DescriptionListTerm>{key}</DescriptionListTerm>
                                                    <DescriptionListDescription>{rest.join("=")}</DescriptionListDescription>
                                                </DescriptionListGroup>
                                            );
                                        })}
                                    </DescriptionList>
                                )}
                        </CardBody>
                    </Card>
                </Tab>
            </Tabs>
        </>
    );
};
