import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Tabs, Tab, TabTitleText } from "@patternfly/react-core/dist/esm/components/Tabs/index.js";
import { MenuToggle } from "@patternfly/react-core/dist/esm/components/MenuToggle/index.js";
import { Select, SelectOption, SelectList } from "@patternfly/react-core/dist/esm/components/Select/index.js";
import { Breadcrumb, BreadcrumbItem } from "@patternfly/react-core/dist/esm/components/Breadcrumb/index.js";
import { Pagination } from "@patternfly/react-core/dist/esm/components/Pagination/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;
const BASE_PATH = "/srv/git";
const COMMITS_PER_PAGE = 30;

interface RepoBrowserProps {
    repoName: string;
    currentRef: string;
    currentPath: string;
    commitHash: string;
}

interface TreeEntry {
    mode: string;
    type: "blob" | "tree";
    hash: string;
    name: string;
}

interface CommitInfo {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    message: string;
}

export const RepoBrowser = ({ repoName, currentRef, currentPath, commitHash }: RepoBrowserProps) => {
    const repoPath = `${BASE_PATH}/${repoName}`;
    const [activeTab, setActiveTab] = useState(commitHash ? 2 : (currentPath ? 1 : 0));

    // Ref selector state
    const [branches, setBranches] = useState<string[]>([]);
    const [tags, setTags] = useState<string[]>([]);
    const [selectedRef, setSelectedRef] = useState(currentRef);
    const [refSelectOpen, setRefSelectOpen] = useState(false);

    // Commits tab
    const [commits, setCommits] = useState<CommitInfo[]>([]);
    const [commitPage, setCommitPage] = useState(1);
    const [totalCommits, setTotalCommits] = useState(0);

    // File tree tab
    const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([]);
    const [browsingPath, setBrowsingPath] = useState(currentPath);

    // File viewer tab
    const [fileContent, setFileContent] = useState("");
    const [viewingFile, setViewingFile] = useState("");

    // Diff viewer
    const [diffContent, setDiffContent] = useState("");
    const [viewingCommit, setViewingCommit] = useState<CommitInfo | null>(null);

    const [loading, setLoading] = useState(true);
    const [error] = useState("");

    const gitCmd = useCallback((args: string[]) =>
        cockpit.spawn(["git", "--git-dir", repoPath, ...args], { superuser: "try", err: "ignore" })
                .catch(() => ""), [repoPath]);

    // Load branches and tags
    useEffect(() => {
        Promise.all([
            gitCmd(["branch", "--format=%(refname:short)"]),
            gitCmd(["tag"]),
        ]).then(([branchOut, tagOut]: [string, string]) => {
            setBranches(branchOut.trim().split("\n")
                    .filter(Boolean));
            setTags(tagOut.trim().split("\n")
                    .filter(Boolean));
        });
    }, [gitCmd]);

    // Load commits
    const loadCommits = useCallback(() => {
        setLoading(true);
        const skip = (commitPage - 1) * COMMITS_PER_PAGE;

        Promise.all([
            gitCmd(["log", selectedRef, `--format=%H|%h|%an|%ai|%s`, `-${COMMITS_PER_PAGE}`, `--skip=${skip}`]),
            gitCmd(["rev-list", "--count", selectedRef]),
        ]).then(([logOut, countOut]: [string, string]) => {
            const parsed = logOut.trim().split("\n")
                    .filter(Boolean)
                    .map(line => {
                        const [hash, shortHash, author, date, ...msgParts] = line.split("|");
                        return { hash, shortHash, author, date, message: msgParts.join("|") };
                    });
            setCommits(parsed);
            setTotalCommits(parseInt(countOut.trim()) || 0);
            setLoading(false);
        })
                .catch(() => {
                    setCommits([]);
                    setTotalCommits(0);
                    setLoading(false);
                });
    }, [gitCmd, selectedRef, commitPage]);

    useEffect(() => {
        if (activeTab === 0) loadCommits();
    }, [activeTab, loadCommits]);

    // Load file tree
    const loadTree = useCallback(() => {
        setLoading(true);
        const treePath = browsingPath ? `${selectedRef}:${browsingPath}` : selectedRef;

        gitCmd(["ls-tree", treePath]).then((output: string) => {
            const entries = output.trim().split("\n")
                    .filter(Boolean)
                    .map(line => {
                        const match = line.match(/^(\d+)\s+(blob|tree)\s+([0-9a-f]+)\s+(.+)$/);
                        if (!match) return null;
                        return { mode: match[1], type: match[2] as "blob" | "tree", hash: match[3], name: match[4] };
                    })
                    .filter(Boolean) as TreeEntry[];

            // Sort: directories first, then files
            entries.sort((a, b) => {
                if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            setTreeEntries(entries);
            setLoading(false);
        })
                .catch(() => {
                    setTreeEntries([]);
                    setLoading(false);
                });
    }, [gitCmd, selectedRef, browsingPath]);

    useEffect(() => {
        if (activeTab === 1) loadTree();
    }, [activeTab, loadTree]);

    // View file content
    const viewFile = useCallback((filePath: string) => {
        setLoading(true);
        setViewingFile(filePath);
        setActiveTab(2);

        gitCmd(["show", `${selectedRef}:${filePath}`]).then((content: string) => {
            setFileContent(content);
            setLoading(false);
        })
                .catch(() => {
                    setFileContent(_("Unable to display file content"));
                    setLoading(false);
                });
    }, [gitCmd, selectedRef]);

    // View commit diff
    const viewCommitDiff = useCallback((commit: CommitInfo) => {
        setLoading(true);
        setViewingCommit(commit);
        setActiveTab(3);

        gitCmd(["diff", `${commit.hash}^..${commit.hash}`, "--stat"]).then((statOut: string) => {
            return gitCmd(["diff", `${commit.hash}^..${commit.hash}`]).then((diffOut: string) => {
                setDiffContent(statOut + "\n" + diffOut);
                setLoading(false);
            });
        })
                .catch(() => {
                    // First commit — no parent
                    gitCmd(["diff", "--root", commit.hash]).then((diffOut: string) => {
                        setDiffContent(diffOut);
                        setLoading(false);
                    })
                            .catch(() => {
                                setDiffContent(_("Unable to display diff"));
                                setLoading(false);
                            });
                });
    }, [gitCmd]);

    // If commitHash was provided, load that diff
    useEffect(() => {
        if (commitHash) {
            viewCommitDiff({ hash: commitHash, shortHash: commitHash.substring(0, 7), author: "", date: "", message: "" });
        }
    }, [commitHash, viewCommitDiff]);

    const navigateTree = (entry: TreeEntry) => {
        if (entry.type === "tree") {
            setBrowsingPath(browsingPath ? `${browsingPath}/${entry.name}` : entry.name);
        } else {
            const fullPath = browsingPath ? `${browsingPath}/${entry.name}` : entry.name;
            viewFile(fullPath);
        }
    };

    const goUpDirectory = () => {
        const parts = browsingPath.split("/");
        parts.pop();
        setBrowsingPath(parts.join("/"));
    };

    const goBack = () => cockpit.location.go(["repo", encodeURIComponent(repoName)]);

    const refOptions = [
        ...branches.map(b => ({ value: b, label: `branch: ${b}` })),
        ...tags.map(t => ({ value: t, label: `tag: ${t}` })),
    ];

    const pathParts = browsingPath ? browsingPath.split("/") : [];

    return (
        <>
            <div className="repo-header">
                <div>
                    <Button variant="link" onClick={goBack}>← {_("Back to")} {repoName}</Button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                    <Select
                        isOpen={refSelectOpen}
                        selected={selectedRef}
                        onSelect={(_e, val) => { setSelectedRef(val as string); setRefSelectOpen(false) }}
                        onOpenChange={setRefSelectOpen}
                        toggle={(toggleRef) => (
                            <MenuToggle ref={toggleRef} onClick={() => setRefSelectOpen(!refSelectOpen)} isExpanded={refSelectOpen}>
                                {selectedRef}
                            </MenuToggle>
                        )}
                    >
                        <SelectList>
                            {refOptions.map(opt => (
                                <SelectOption key={opt.value} value={opt.value}>{opt.label}</SelectOption>
                            ))}
                        </SelectList>
                    </Select>
                </div>
            </div>

            {error && <Alert variant="danger" title={error} isInline style={{ marginBottom: "1rem" }} />}

            <Tabs activeKey={activeTab} onSelect={(_e, key) => setActiveTab(key as number)}>
                <Tab eventKey={0} title={<TabTitleText>{_("Commits")}</TabTitleText>}>
                    {loading
                        ? <Spinner aria-label={_("Loading")} />
                        : (
                            <Card>
                                <CardBody>
                                    {commits.length === 0
                                        ? <p>{_("No commits")}</p>
                                        : (
                                            <>
                                                <ul style={{ listStyle: "none", padding: 0 }}>
                                                    {commits.map(c => (
                                                        <li key={c.hash} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--pf-t--global--border--color--default)" }}>
                                                            <div style={{ display: "flex", justifyContent: "space-between" }}>
                                                                <div>
                                                                    <Button variant="link" isInline onClick={() => viewCommitDiff(c)}>
                                                                        <span className="commit-hash">{c.shortHash}</span>
                                                                    </Button>
                                                                    {" "}{c.message}
                                                                </div>
                                                                <div style={{ fontSize: "small", color: "var(--pf-t--global--text--color--subtle)" }}>
                                                                    {c.author} — {c.date}
                                                                </div>
                                                            </div>
                                                        </li>
                                                    ))}
                                                </ul>
                                                {totalCommits > COMMITS_PER_PAGE && (
                                                    <Pagination
                                                        itemCount={totalCommits}
                                                        perPage={COMMITS_PER_PAGE}
                                                        page={commitPage}
                                                        onSetPage={(_e, p) => setCommitPage(p)}
                                                        variant="bottom"
                                                    />
                                                )}
                                            </>
                                        )}
                                </CardBody>
                            </Card>
                        )}
                </Tab>

                <Tab eventKey={1} title={<TabTitleText>{_("Files")}</TabTitleText>}>
                    {loading
                        ? <Spinner aria-label={_("Loading")} />
                        : (
                            <Card>
                                <CardBody>
                                    {/* Breadcrumb navigation */}
                                    <Breadcrumb style={{ marginBottom: "1rem" }}>
                                        <BreadcrumbItem>
                                            <Button variant="link" isInline onClick={() => setBrowsingPath("")}>
                                                /
                                            </Button>
                                        </BreadcrumbItem>
                                        {pathParts.map((part, i) => (
                                            <BreadcrumbItem key={i} isActive={i === pathParts.length - 1}>
                                                <Button variant="link" isInline onClick={() => setBrowsingPath(pathParts.slice(0, i + 1).join("/"))}>
                                                    {part}
                                                </Button>
                                            </BreadcrumbItem>
                                        ))}
                                    </Breadcrumb>

                                    {browsingPath && (
                                        <Button variant="link" onClick={goUpDirectory} style={{ marginBottom: "0.5rem" }}>
                                            ↑ ..
                                        </Button>
                                    )}

                                    {treeEntries.length === 0
                                        ? <p>{_("Empty directory or no files at this ref")}</p>
                                        : (
                                            <ul style={{ listStyle: "none", padding: 0 }}>
                                                {treeEntries.map(entry => (
                                                    <li key={entry.name} style={{ padding: "0.25rem 0", borderBottom: "1px solid var(--pf-t--global--border--color--default)" }}>
                                                        <Button variant="link" isInline onClick={() => navigateTree(entry)}>
                                                            {entry.type === "tree" ? "📁 " : "📄 "}
                                                            {entry.name}
                                                        </Button>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                </CardBody>
                            </Card>
                        )}
                </Tab>

                <Tab eventKey={2} title={<TabTitleText>{viewingFile || _("File Viewer")}</TabTitleText>}>
                    {loading
                        ? <Spinner aria-label={_("Loading")} />
                        : (
                            <Card>
                                <CardTitle>{viewingFile || _("Select a file to view")}</CardTitle>
                                <CardBody>
                                    {fileContent
                                        ? <div className="file-content-viewer">{fileContent}</div>
                                        : <p>{_("No file selected. Use the Files tab to browse and select a file.")}</p>}
                                </CardBody>
                            </Card>
                        )}
                </Tab>

                <Tab eventKey={3} title={<TabTitleText>{viewingCommit ? `${_("Diff")}: ${viewingCommit.shortHash}` : _("Diff Viewer")}</TabTitleText>}>
                    {loading
                        ? <Spinner aria-label={_("Loading")} />
                        : (
                            <Card>
                                {viewingCommit && (
                                    <CardTitle>
                                        <span className="commit-hash">{viewingCommit.shortHash}</span>
                                        {" "}{viewingCommit.message}
                                        {viewingCommit.author && (
                                            <span style={{ fontSize: "small", color: "var(--pf-t--global--text--color--subtle)", marginLeft: "1rem" }}>
                                                {viewingCommit.author} — {viewingCommit.date}
                                            </span>
                                        )}
                                    </CardTitle>
                                )}
                                <CardBody>
                                    {diffContent
                                        ? (
                                            <div className="diff-viewer">
                                                {diffContent.split("\n").map((line, i) => {
                                                    let className = "";
                                                    if (line.startsWith("+") && !line.startsWith("+++")) className = "diff-add";
                                                    else if (line.startsWith("-") && !line.startsWith("---")) className = "diff-remove";
                                                    else if (line.startsWith("@@")) className = "diff-hunk";
                                                    return <div key={i} className={className}>{line}</div>;
                                                })}
                                            </div>
                                        )
                                        : <p>{_("No diff selected. Use the Commits tab to select a commit.")}</p>}
                                </CardBody>
                            </Card>
                        )}
                </Tab>
            </Tabs>
        </>
    );
};
