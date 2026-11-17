import React, { useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

import cockpit from 'cockpit';

import { ConfigurationPageProps } from '../app.jsx';
import { PageHeader, SimpleTable, WarningList } from '../components.jsx';
import {
    SHARE_FIELDS,
    SPECIAL_SECTIONS,
    effectiveShareBoolean,
    effectiveShareValue,
    isShareEnabled,
    listShareNames,
    setShareEnabled,
} from '../model.js';
import { ConfigurationDocument, addSection, getParameter, removeSection, renameSection, sameSectionName, serializeConfiguration, setParameter } from '../smb-conf.js';
import { validateShareName } from '../validation.js';
import { securityWarnings } from '../warnings.js';
import { OtherParameters, SectionForm, useAccountNames, useSectionDraft } from './section-editor.jsx';

const _ = cockpit.gettext;

type ShareTemplate = "empty" | "scanner";

/** Starting parameters of a new share. */
const TEMPLATES: Record<ShareTemplate, [string, string][]> = {
    empty: [["path", ""], ["read only", "no"]],
    // Hidden drop folder for a scanner; the editor then asks for its user (valid users) and address (hosts allow).
    scanner: [
        ["comment", "Scanner drop folder"],
        ["path", "/srv/samba/scans"],
        ["browseable", "no"],
        ["read only", "no"],
        ["create mask", "0660"],
        ["directory mask", "0770"],
    ],
};

function newShareDocument(document: ConfigurationDocument, name: string, template: ShareTemplate): ConfigurationDocument {
    let result = addSection(document, name);
    for (const [parameter, value] of TEMPLATES[template])
        result = setParameter(result, name, parameter, value || null);
    return result;
}

const AddShareDialog = ({ existing, onClose, onCreate }: { existing: string[]; onClose: () => void; onCreate: (name: string, template: ShareTemplate) => void }) => {
    const [name, setName] = useState("");
    const [template, setTemplate] = useState<ShareTemplate>("empty");
    const error = name ? validateShareName(name, existing) : null;
    return (
        <Modal isOpen variant="small" aria-labelledby="add-share-title" onClose={onClose}>
            <ModalHeader title={_("Add share")} labelId="add-share-title" />
            <ModalBody>
                <Form onSubmit={event => event.preventDefault()}>
                    <FormGroup label={_("Share name")} fieldId="share-name" isRequired>
                        <TextInput id="share-name" value={name} validated={error ? "error" : "default"} onChange={(_event, text) => setName(text)} />
                        {error && <HelperText><HelperTextItem variant="error">{error}</HelperTextItem></HelperText>}
                    </FormGroup>
                    <FormGroup label={_("Start from")} fieldId="share-template">
                        <FormSelect id="share-template" value={template} onChange={(_event, value) => setTemplate(value as ShareTemplate)}>
                            <FormSelectOption value="empty" label={_("Empty writable share")} />
                            <FormSelectOption value="scanner" label={_("Scanner drop folder (dedicated user, hidden, no world access)")} />
                        </FormSelect>
                    </FormGroup>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" isDisabled={!name || !!error} onClick={() => onCreate(name.trim(), template)}>{_("Continue")}</Button>
                <Button variant="link" onClick={onClose}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

/** Edits one share; nothing is written until the review dialog applies it. */
const ShareEditor = ({ base, document, shareName, isNew, onCancel, props }: {
    base: ConfigurationDocument;
    document: ConfigurationDocument;
    shareName: string;
    isNew: boolean;
    onCancel: () => void;
    props: ConfigurationPageProps;
}) => {
    const draft = useSectionDraft(base, shareName, SHARE_FIELDS, ["available"]);
    const accounts = useAccountNames();
    const [name, setName] = useState(shareName);
    const otherNames = listShareNames(document).filter(existing => !sameSectionName(existing, shareName));
    const nameError = validateShareName(name, otherNames);
    const enabled = isShareEnabled(draft.fieldDocument, shareName);
    const special = SPECIAL_SECTIONS.some(section => sameSectionName(section, shareName));
    const path = getParameter(draft.fieldDocument, shareName, "path") ?? "";
    const pathMissing = !special && path.trim() === "";
    const result = renameSection(draft.document, shareName, name.trim());
    const text = serializeConfiguration(result);
    const changed = isNew || text !== serializeConfiguration(document);
    const warnings = securityWarnings(result, props.paths).filter(warning => warning.share !== null && sameSectionName(warning.share, name.trim()));

    return (
        <>
            <PageHeader
                title={isNew ? cockpit.format(_("New share [$0]"), shareName) : cockpit.format(_("Share [$0]"), shareName)}
                actions={
                    <>
                        <Button variant="link" onClick={onCancel}>{_("Back to shares")}</Button>
                        <Button
                            variant="primary"
                            isDisabled={!changed || !draft.valid || !!nameError || pathMissing}
                            onClick={() => props.onReview({ title: cockpit.format(_("Review share [$0]"), name.trim()), text })}
                        >
                            {_("Review and apply")}
                        </Button>
                    </>
                }
            />
            <WarningList warnings={warnings} />
            <Card isCompact className="smb-card">
                <CardTitle>{_("Share")}</CardTitle>
                <CardBody>
                    <Form isHorizontal onSubmit={event => event.preventDefault()}>
                        <FormGroup label={_("Name")} fieldId="share-edit-name">
                            <TextInput id="share-edit-name" value={name} isDisabled={special} validated={nameError ? "error" : "default"} onChange={(_event, text) => setName(text)} />
                            {nameError && <HelperText><HelperTextItem variant="error">{nameError}</HelperTextItem></HelperText>}
                        </FormGroup>
                        <FormGroup label={_("Enabled")} fieldId="share-enabled">
                            <Switch
                                id="share-enabled" isChecked={enabled}
                                label={enabled ? _("Available to clients") : _("Disabled (available = no)")}
                                onChange={(_event, checked) => draft.setFieldDocument(current => setShareEnabled(current, shareName, checked))}
                            />
                        </FormGroup>
                    </Form>
                    {pathMissing && <HelperText><HelperTextItem variant="error">{_("A path is required.")}</HelperTextItem></HelperText>}
                    <SectionForm draft={draft} sectionName={shareName} fields={SHARE_FIELDS} idPrefix="share" accounts={accounts} />
                </CardBody>
            </Card>
            <Card isCompact className="smb-card">
                <CardTitle>{_("Other share parameters")}</CardTitle>
                <CardBody>
                    <p className="smb-muted">{_("Any other smb.conf parameter of this share, e.g. \"veto files\" or \"recycle:repository\".")}</p>
                    <OtherParameters draft={draft} idPrefix="share-other" />
                </CardBody>
            </Card>
        </>
    );
};

export const SharesPage = (props: ConfigurationPageProps) => {
    const { document, paths, onReview } = props;
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<{ name: string; isNew: boolean; base: ConfigurationDocument } | null>(null);

    if (editing)
        return <ShareEditor base={editing.base} document={document} shareName={editing.name} isNew={editing.isNew} onCancel={() => setEditing(null)} props={props} />;

    const shares = listShareNames(document);
    const warnings = securityWarnings(document, paths);
    const review = (title: string, changed: ConfigurationDocument) => onReview({ title, text: serializeConfiguration(changed) });

    const rows = shares.map(share => {
        const enabled = isShareEnabled(document, share);
        const readOnly = effectiveShareBoolean(document, share, "read only", true);
        const guest = effectiveShareBoolean(document, share, "guest ok", false);
        const shareWarnings = warnings.filter(warning => warning.share !== null && sameSectionName(warning.share, share) && warning.severity !== "info");
        return [
            <Button key="name" variant="link" isInline onClick={() => setEditing({ name: share, isNew: false, base: document })}>{share}</Button>,
            getParameter(document, share, "path") ?? <span className="smb-muted">{_("(none)")}</span>,
            <span key="access" className="smb-labels">
                <Label isCompact color={readOnly ? "blue" : "orange"}>{readOnly ? _("Read only") : _("Writable")}</Label>
                {guest && <Label isCompact color="red">{_("Guest")}</Label>}
                {!effectiveShareBoolean(document, share, "browseable", true) && <Label isCompact>{_("Hidden")}</Label>}
            </span>,
            effectiveShareValue(document, share, "valid users", "") || <span className="smb-muted">{_("all users")}</span>,
            enabled ? <Label key="state" isCompact color="green">{_("Enabled")}</Label> : <Label key="state" isCompact>{_("Disabled")}</Label>,
            shareWarnings.length > 0 ? <Label key="warnings" isCompact color="orange">{shareWarnings.length}</Label> : "",
            <span key="actions" className="smb-row-actions">
                <Button variant="secondary" size="sm" onClick={() => setEditing({ name: share, isNew: false, base: document })}>{_("Edit")}</Button>
                <Button variant="secondary" size="sm" onClick={() => review(cockpit.format(enabled ? _("Disable share [$0]") : _("Enable share [$0]"), share), setShareEnabled(document, share, !enabled))}>
                    {enabled ? _("Disable") : _("Enable")}
                </Button>
                <Button variant="secondary" size="sm" isDanger onClick={() => review(cockpit.format(_("Delete share [$0]"), share), removeSection(document, share))}>
                    {_("Delete")}
                </Button>
            </span>,
        ];
    });

    return (
        <>
            <PageHeader
                title={_("Shares")}
                description={_("Deleting a share removes it from smb.conf only; files stay on disk.")}
                actions={<Button variant="primary" onClick={() => setAdding(true)}>{_("Add share")}</Button>}
            />
            <Card isCompact className="smb-card">
                <CardBody>
                    <SimpleTable
                        headers={[_("Name"), _("Path"), _("Access"), _("Valid users"), _("State"), _("Warnings"), ""]}
                        rows={rows}
                        emptyText={_("No shares are defined.")}
                    />
                </CardBody>
            </Card>
            {adding &&
                <AddShareDialog
                    existing={shares}
                    onClose={() => setAdding(false)}
                    onCreate={(name, template) => {
                        setAdding(false);
                        setEditing({ name, isNew: true, base: newShareDocument(document, name, template) });
                    }}
                />}
        </>
    );
};
