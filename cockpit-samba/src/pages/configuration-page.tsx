import React, { useEffect, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";

import cockpit from 'cockpit';

import { ConfigurationPageProps } from '../app.jsx';
import { ErrorAlert, PageHeader, SimpleTable } from '../components.jsx';
import { errorMessage, listBackups, readBackup } from '../samba-backend.js';
import { BackupEntry, DEFAULT_PATHS } from '../transaction.js';

const _ = cockpit.gettext;

/** Full smb.conf text editor and the backups taken before each apply. */
export const ConfigurationPage = ({ snapshot, onReview }: ConfigurationPageProps) => {
    const [text, setText] = useState(snapshot.text);
    const [backups, setBackups] = useState<BackupEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        listBackups().then(setBackups, listError => {
            setBackups([]);
            setError(errorMessage(listError));
        });
    }, []);

    const restore = (backup: BackupEntry) => {
        readBackup(backup.name)
                .then(content => onReview({ title: cockpit.format(_("Restore backup $0"), backup.name), text: content }))
                .catch(readError => setError(errorMessage(readError)));
    };

    const backupRows = (backups ?? []).map(backup => [
        backup.name,
        backup.createdAt.toLocaleString(),
        cockpit.format_bytes(backup.size),
        <Button key="restore" variant="secondary" size="sm" onClick={() => restore(backup)}>{_("Review and restore")}</Button>,
    ]);

    return (
        <>
            <PageHeader
                title={_("Configuration file")}
                description={_("Edit /etc/samba/smb.conf directly. Changes go through the same testparm check, diff, backup and reload.")}
                actions={
                    <>
                        <Button variant="secondary" isDisabled={text === snapshot.text} onClick={() => setText(snapshot.text)}>{_("Discard")}</Button>
                        <Button variant="primary" isDisabled={text === snapshot.text} onClick={() => onReview({ title: _("Review smb.conf"), text })}>{_("Review and apply")}</Button>
                    </>
                }
            />
            <ErrorAlert error={error} />
            {/^\s*config\s*backend\s*=\s*registry/im.test(text) &&
                <Alert variant="warning" isInline className="smb-alert" title={_("\"config backend = registry\" is set: Samba reads its settings from the registry (net conf), and most of this file is ignored.")} />}
            <Card isCompact className="smb-card">
                <CardBody>
                    <TextArea
                        id="raw-configuration" aria-label={_("smb.conf")} className="smb-raw-editor"
                        value={text} onChange={(_event, value) => setText(value)}
                        resizeOrientation="vertical" spellCheck={false}
                    />
                </CardBody>
            </Card>
            <Card isCompact className="smb-card">
                <CardTitle>{_("Backups")}</CardTitle>
                <CardBody>
                    <p className="smb-muted">{cockpit.format(_("Taken automatically before every change, in $0. The newest 50 are kept."), DEFAULT_PATHS.backupDirectory)}</p>
                    <SimpleTable headers={[_("File"), _("Taken"), _("Size"), ""]} rows={backupRows} emptyText={backups === null ? _("Loading…") : _("No backups yet.")} />
                </CardBody>
            </Card>
        </>
    );
};
