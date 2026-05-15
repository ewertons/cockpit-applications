import React, { useCallback, useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { EmptyState, EmptyStateBody, EmptyStateFooter, EmptyStateActions } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";

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

    // Create modal
    const [showCreate, setShowCreate] = useState(false);
    const [newRepoName, setNewRepoName] = useState("");
    const [createError, setCreateError] = useState("");
    const [creating, setCreating] = useState(false);

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

        cockpit.spawn(["git", "init", "--bare", repoPath], { superuser: "require" })
                .then(() => {
                    setShowCreate(false);
                    setNewRepoName("");
                    setCreating(false);
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
                <CardTitle>{_("Git Repositories")}</CardTitle>
                <Button variant="primary" onClick={() => setShowCreate(true)}>
                    {_("Create Repository")}
                </Button>
            </div>

            {error && <Alert variant="danger" title={error} isInline />}

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
                : repos.map(repo => (
                    <Card key={repo.name} isCompact style={{ marginBottom: "1rem" }}>
                        <CardTitle>
                            <Button variant="link" onClick={() => navigateToRepo(repo)}>
                                {repo.name}
                            </Button>
                        </CardTitle>
                        <CardBody>
                            <DescriptionList isHorizontal isCompact>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Clone URL")}</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        <span className="clone-url">git@{hostname}:{repo.path}</span>
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Size")}</DescriptionListTerm>
                                    <DescriptionListDescription>{repo.size}</DescriptionListDescription>
                                </DescriptionListGroup>
                                <DescriptionListGroup>
                                    <DescriptionListTerm>{_("Last Modified")}</DescriptionListTerm>
                                    <DescriptionListDescription>{repo.lastModified}</DescriptionListDescription>
                                </DescriptionListGroup>
                            </DescriptionList>
                            <div style={{ marginTop: "0.5rem" }}>
                                <Button variant="secondary" onClick={() => navigateToBrowse(repo)} style={{ marginRight: "0.5rem" }}>
                                    {_("Browse")}
                                </Button>
                                <Button variant="danger" onClick={() => setDeleteRepo(repo)}>
                                    {_("Delete")}
                                </Button>
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
