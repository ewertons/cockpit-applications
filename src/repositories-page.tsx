import React, { useCallback, useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { EmptyState, EmptyStateBody, EmptyStateFooter, EmptyStateActions } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { ClipboardCopy } from "@patternfly/react-core/dist/esm/components/ClipboardCopy/index.js";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";

import cockpit from 'cockpit';

const _ = cockpit.gettext;
const BASE_PATH = "/srv/git";

interface RepoInfo {
    name: string;
    path: string;
    size: string;
    lastModified: string;
}

export const RepositoriesPage = () => {
    const [repos, setRepos] = useState<RepoInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [hostname, setHostname] = useState("localhost");
    const [filter, setFilter] = useState("");

    // Create modal
    const [showCreate, setShowCreate] = useState(false);
    const [newRepoName, setNewRepoName] = useState("");
    const [createError, setCreateError] = useState("");
    const [creating, setCreating] = useState(false);

    // Just-created info
    const [justCreated, setJustCreated] = useState<{ name: string; path: string } | null>(null);

    // Delete modal
    const [deleteRepo, setDeleteRepo] = useState<RepoInfo | null>(null);
    const [deleting, setDeleting] = useState(false);

    useEffect(() => {
        const h = cockpit.file('/etc/hostname');
        h.watch(content => setHostname(content?.trim() ?? "localhost"));
        return h.close;
    }, []);

    const loadRepos = useCallback(() => {
        setLoading(true);
        setError("");

        cockpit.spawn(
            ["find", BASE_PATH, "-maxdepth", "1", "-name", "*.git", "-type", "d"],
            { superuser: "try", err: "ignore" }
        )
                .then((output: string) => {
                    const dirs = output.trim().split("\n").filter(Boolean);
                    if (dirs.length === 0) {
                        setRepos([]);
                        setLoading(false);
                        return;
                    }

                    const promises = dirs.map(dir => {
                        const name = dir.split("/").pop()!;
                        return Promise.all([
                            cockpit.spawn(["du", "-sh", dir], { superuser: "try", err: "ignore" }),
                            cockpit.spawn(["stat", "-c", "%Y", dir], { superuser: "try", err: "ignore" }),
                        ]).then(([duOut, statOut]: [string, string]) => ({
                            name,
                            path: dir,
                            size: duOut.split("\t")[0] || "?",
                            lastModified: new Date(parseInt(statOut.trim()) * 1000).toLocaleString(),
                        }));
                    });

                    return Promise.all(promises).then(results => {
                        setRepos(results);
                        setLoading(false);
                    });
                })
                .catch((ex: cockpit.BasicError) => {
                    if (ex.problem === "not-found" || ex.exit_status) {
                        setRepos([]);
                    } else {
                        setError(ex.message || String(ex));
                    }
                    setLoading(false);
                });
    }, []);

    useEffect(() => { loadRepos() }, [loadRepos]);

    const handleCreate = () => {
        const name = newRepoName.trim();
        if (!name) return;
        // Validate: only allow alphanumeric, hyphens, underscores, dots
        if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
            setCreateError(_("Repository name may only contain letters, numbers, hyphens, underscores, and dots."));
            return;
        }
        const repoPath = `${BASE_PATH}/${name.endsWith(".git") ? name : name + ".git"}`;

        setCreating(true);
        setCreateError("");

        cockpit.spawn(["git", "init", "--bare", "--initial-branch=main", repoPath], { superuser: "require" })
                .then(() => cockpit.spawn(["chown", "-R", "git:git", repoPath], { superuser: "require", err: "ignore" }))
                .then(() => {
                    setShowCreate(false);
                    setCreating(false);
                    setJustCreated({ name: name.endsWith(".git") ? name : name + ".git", path: repoPath });
                    setNewRepoName("");
                    loadRepos();
                })
                .catch((ex: cockpit.BasicError) => {
                    setCreateError(ex.message || String(ex));
                    setCreating(false);
                });
    };

    const handleDelete = () => {
        if (!deleteRepo) return;
        setDeleting(true);

        cockpit.spawn(["rm", "-rf", deleteRepo.path], { superuser: "require" })
                .then(() => {
                    setDeleteRepo(null);
                    setDeleting(false);
                    loadRepos();
                })
                .catch((ex: cockpit.BasicError) => {
                    setError(ex.message || String(ex));
                    setDeleteRepo(null);
                    setDeleting(false);
                });
    };

    const navigateToRepo = (repo: RepoInfo) => {
        cockpit.location.go(["repo", encodeURIComponent(repo.name)]);
    };

    const navigateToBrowse = (repo: RepoInfo) => {
        cockpit.location.go(["repo", encodeURIComponent(repo.name), "browse"]);
    };

    if (loading) {
        return <Spinner aria-label={_("Loading repositories")} />;
    }

    return (
        <>
            <div className="repo-header">
                {repos.length > 0 && (
                    <SearchInput
                        placeholder={_("Filter repositories…")}
                        value={filter}
                        onChange={(_e, val) => setFilter(val)}
                        onClear={() => setFilter("")}
                        style={{ maxWidth: "300px" }}
                    />
                )}
                {repos.length > 0 && (
                    <Button variant="primary" onClick={() => setShowCreate(true)}>
                        {_("Create Repository")}
                    </Button>
                )}
            </div>

            {error && <Alert variant="danger" title={error} isInline />}

            {justCreated && (
                <Card style={{ marginBottom: "1rem" }}>
                    <CardTitle>
                        {cockpit.format(_("Repository $0 created successfully"), justCreated.name)}
                        <Button variant="plain" onClick={() => setJustCreated(null)} style={{ float: "right" }}>✕</Button>
                    </CardTitle>
                    <CardBody>
                        <p style={{ marginBottom: "1rem" }}><strong>{_("Quick setup — clone URL:")}</strong></p>
                        <ClipboardCopy isReadOnly>{`git@${hostname}:${justCreated.path}`}</ClipboardCopy>

                        <p style={{ marginTop: "1rem" }}><strong>{_("…or create a new repository on the command line")}</strong></p>
                        <pre style={{ background: "var(--pf-t--global--background--color--secondary--default)", padding: "0.75rem", borderRadius: "var(--pf-t--global--border--radius--small)", marginBottom: "1rem", whiteSpace: "pre-wrap" }}>
{`echo "# ${justCreated.name.replace(/\.git$/, "")}" >> README.md
git init
git add README.md
git commit -m "first commit"
git branch -M main
git remote add origin git@${hostname}:${justCreated.path}
git push -u origin main`}
                        </pre>

                        <p><strong>{_("…or push an existing repository from the command line")}</strong></p>
                        <pre style={{ background: "var(--pf-t--global--background--color--secondary--default)", padding: "0.75rem", borderRadius: "var(--pf-t--global--border--radius--small)", whiteSpace: "pre-wrap" }}>
{`git remote add origin git@${hostname}:${justCreated.path}
git branch -M main
git push -u origin main`}
                        </pre>
                    </CardBody>
                </Card>
            )}

            {repos.length === 0
                ? (
                    <EmptyState>
                        <EmptyStateBody>
                            {_("No bare Git repositories found in ") + BASE_PATH}
                        </EmptyStateBody>
                        <EmptyStateFooter>
                            <EmptyStateActions>
                                <Button variant="primary" onClick={() => setShowCreate(true)}>
                                    {_("Create Repository")}
                                </Button>
                            </EmptyStateActions>
                        </EmptyStateFooter>
                    </EmptyState>
                )
                : repos
                    .filter(repo => !filter || repo.name.toLowerCase().includes(filter.toLowerCase()))
                    .map(repo => (
                        <Card key={repo.name} isCompact isFlat style={{ marginBottom: "0.5rem", padding: "0.5rem" }}>
                            <CardBody style={{ padding: "0.5rem" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <div style={{ flex: 1 }}>
                                        <Button variant="link" isInline onClick={() => navigateToRepo(repo)} style={{ fontWeight: "bold" }}>
                                            {repo.name}
                                        </Button>
                                        <span style={{ marginLeft: "1rem", fontSize: "small", color: "var(--pf-t--global--text--color--subtle)" }}>
                                            {repo.size} · {repo.lastModified}
                                        </span>
                                    </div>
                                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                        <ClipboardCopy isReadOnly variant="inline-compact">{`git@${hostname}:${repo.path}`}</ClipboardCopy>
                                        <Button variant="secondary" size="sm" onClick={() => navigateToBrowse(repo)}>
                                            {_("Browse")}
                                        </Button>
                                        <Button variant="danger" size="sm" onClick={() => setDeleteRepo(repo)}>
                                            {_("Delete")}
                                        </Button>
                                    </div>
                                </div>
                            </CardBody>
                        </Card>
                    ))}

            {showCreate && (
                <Modal variant="small" isOpen onClose={() => { setShowCreate(false); setCreateError("") }}>
                    <ModalHeader title={_("Create Repository")} />
                    <ModalBody>
                        {createError && <Alert variant="danger" title={createError} isInline />}
                        <FormGroup label={_("Repository Name")} fieldId="repo-name">
                            <TextInput
                                id="repo-name"
                                value={newRepoName}
                                onChange={(_e, val) => setNewRepoName(val)}
                                placeholder="my-project"
                            />
                        </FormGroup>
                        <p style={{ marginTop: "0.5rem", fontSize: "small", color: "var(--pf-t--global--text--color--subtle)" }}>
                            {_("Will create: ") + BASE_PATH + "/" + (newRepoName.trim() || "...") + (newRepoName.trim().endsWith(".git") ? "" : ".git")}
                        </p>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="primary" onClick={handleCreate} isLoading={creating} isDisabled={creating || !newRepoName.trim()}>
                            {_("Create")}
                        </Button>
                        <Button variant="link" onClick={() => { setShowCreate(false); setCreateError("") }}>
                            {_("Cancel")}
                        </Button>
                    </ModalFooter>
                </Modal>
            )}

            {deleteRepo && (
                <Modal variant="small" isOpen onClose={() => setDeleteRepo(null)}>
                    <ModalHeader title={_("Delete Repository")} />
                    <ModalBody>
                        <Alert variant="warning" title={_("This action cannot be undone.")} isInline />
                        <p style={{ marginTop: "0.5rem" }}>
                            {cockpit.format(_("Are you sure you want to delete $0?"), deleteRepo.name)}
                        </p>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="danger" onClick={handleDelete} isLoading={deleting} isDisabled={deleting}>
                            {_("Delete")}
                        </Button>
                        <Button variant="link" onClick={() => setDeleteRepo(null)}>
                            {_("Cancel")}
                        </Button>
                    </ModalFooter>
                </Modal>
            )}
        </>
    );
};
