import React from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";

import cockpit from 'cockpit';

import { ConfigurationPageProps } from '../app.jsx';
import { PageHeader, WarningList } from '../components.jsx';
import { GLOBAL_FIELDS, PRINTING_PARAMETER_NAMES, isPrintingEnabled, setPrintingEnabled } from '../model.js';
import { GLOBAL_SECTION, serializeConfiguration } from '../smb-conf.js';
import { securityWarnings } from '../warnings.js';
import { OtherParameters, SectionForm, useSectionDraft } from './section-editor.jsx';

const _ = cockpit.gettext;

export const GlobalPage = ({ document, paths, onReview }: ConfigurationPageProps) => {
    const draft = useSectionDraft(document, GLOBAL_SECTION, GLOBAL_FIELDS, PRINTING_PARAMETER_NAMES);
    const text = serializeConfiguration(draft.document);
    const changed = text !== serializeConfiguration(document);
    const warnings = securityWarnings(draft.document, paths).filter(warning => warning.share === null);
    const printing = isPrintingEnabled(draft.fieldDocument);

    return (
        <>
            <PageHeader
                title={_("Global settings")}
                description={_("The [global] section: server identity, network access, protocols and authentication.")}
                actions={
                    <>
                        <Button variant="secondary" isDisabled={!changed} onClick={() => draft.reset()}>
                            {_("Discard")}
                        </Button>
                        <Button variant="primary" isDisabled={!changed || !draft.valid} onClick={() => onReview({ title: _("Review global settings"), text })}>
                            {_("Review and apply")}
                        </Button>
                    </>
                }
            />
            <WarningList warnings={warnings} />
            <Card isCompact className="smb-card">
                <CardTitle>{_("Settings")}</CardTitle>
                <CardBody>
                    <SectionForm draft={draft} sectionName={GLOBAL_SECTION} fields={GLOBAL_FIELDS} idPrefix="global" accounts={[]} />
                    <Switch
                        id="global-printing" className="smb-switch"
                        label={_("Printer sharing")}
                        isChecked={printing}
                        onChange={(_event, checked) => draft.setFieldDocument(current => setPrintingEnabled(current, checked))}
                    />
                    {!printing && <p className="smb-muted">{cockpit.format(_("Disabled with: $0."), PRINTING_PARAMETER_NAMES.join(", "))}</p>}
                </CardBody>
            </Card>
            <Card isCompact className="smb-card">
                <CardTitle>{_("Other global parameters")}</CardTitle>
                <CardBody>
                    <p className="smb-muted">{_("Any other smb.conf parameter of [global]. Unknown names are reported by testparm before applying.")}</p>
                    <OtherParameters draft={draft} idPrefix="global-other" />
                </CardBody>
            </Card>
        </>
    );
};
