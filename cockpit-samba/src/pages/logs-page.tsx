import React, { useCallback, useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";

import cockpit from 'cockpit';

import { ErrorAlert, PageHeader } from '../components.jsx';
import { errorMessage, listLogFiles, readJournal, readLogFile } from '../samba-backend.js';
import { LogFile, SAMBA_LOG_DIRECTORY } from '../services.js';

const _ = cockpit.gettext;

const LINE_COUNTS = [100, 500, 2000];

/** Journal of smbd/nmbd and Samba's own per-client log files. */
export const LogsPage = () => {
    const [lineCount, setLineCount] = useState(LINE_COUNTS[0]);
    const [journal, setJournal] = useState("");
    const [files, setFiles] = useState<LogFile[]>([]);
    const [selected, setSelected] = useState("");
    const [fileText, setFileText] = useState("");
    const [error, setError] = useState<string | null>(null);

    const loadJournal = useCallback(() => {
        readJournal(lineCount).then(setJournal, journalError => setError(errorMessage(journalError)));
        listLogFiles().then(setFiles);
    }, [lineCount]);

    useEffect(loadJournal, [loadJournal]);

    useEffect(() => {
        setFileText("");
        if (selected)
            readLogFile(selected, lineCount).then(setFileText, fileError => setError(errorMessage(fileError)));
    }, [selected, lineCount]);

    return (
        <>
            <PageHeader
                title={_("Logs")}
                actions={
                    <>
                        <FormSelect id="log-lines" aria-label={_("Lines")} value={String(lineCount)} onChange={(_event, value) => setLineCount(Number(value))}>
                            {LINE_COUNTS.map(count => <FormSelectOption key={count} value={String(count)} label={cockpit.format(_("Last $0 lines"), count)} />)}
                        </FormSelect>
                        <Button variant="secondary" onClick={loadJournal}>{_("Refresh")}</Button>
                    </>
                }
            />
            <ErrorAlert error={error} />
            <Card isCompact className="smb-card">
                <CardTitle>{_("smbd and nmbd journal")}</CardTitle>
                <CardBody>
                    <pre className="smb-log">{journal || _("No entries.")}</pre>
                </CardBody>
            </Card>
            <Card isCompact className="smb-card">
                <CardTitle>{cockpit.format(_("Samba log files ($0)"), SAMBA_LOG_DIRECTORY)}</CardTitle>
                <CardBody>
                    <p className="smb-muted">{_("Per-client logs (log.<machine or address>) are written when \"log file\" contains %m or %I. Raise \"log level\" in Global settings for more detail.")}</p>
                    <FormSelect id="log-file" aria-label={_("Log file")} value={selected} onChange={(_event, value) => setSelected(value)} className="smb-picker">
                        <FormSelectOption value="" label={files.length ? _("Choose a log file…") : _("No log files")} />
                        {files.map(file => (
                            <FormSelectOption key={file.name} value={file.name} label={`${file.name} (${cockpit.format_bytes(file.size)}, ${file.modifiedAt.toLocaleString()})`} />
                        ))}
                    </FormSelect>
                    {selected && <pre className="smb-log">{fileText || _("Empty.")}</pre>}
                </CardBody>
            </Card>
        </>
    );
};
