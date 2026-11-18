import React, { useEffect, useMemo, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Form } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";

import cockpit from 'cockpit';

import { ParameterFieldInput, ParameterRow, ParameterTable, parameterRowError, rowsToParameters } from '../components.jsx';
import { ParameterField, isFieldParameter, joinList, splitList } from '../model.js';
import { createDirectory, errorMessage, listLinuxGroups, listSambaUsers, readPathInformation } from '../samba-backend.js';
import { parameterKey } from '../parameters.js';
import { ConfigurationDocument, GLOBAL_SECTION, getParameter, listParameters, replaceParameters, setParameter } from '../smb-conf.js';
import { validateFieldValue } from '../validation.js';
import { PathInformation, isWorldWritableMode } from '../warnings.js';

const _ = cockpit.gettext;

/** Draft of one section: dedicated fields plus free key/value rows. */
export interface SectionDraft {
    /** Base document with the dedicated field edits applied. */
    fieldDocument: ConfigurationDocument;
    setFieldDocument: React.Dispatch<React.SetStateAction<ConfigurationDocument>>;
    rows: ParameterRow[];
    setRows: (rows: ParameterRow[]) => void;
    /** Whether a name belongs to a dedicated field. */
    reserved: (name: string) => boolean;
    /** Field edits and rows merged; only valid when `rowsValid`. */
    document: ConfigurationDocument;
    rowsValid: boolean;
    /** Rows and every dedicated field hold valid values. */
    valid: boolean;
    /** Drops every edit. */
    reset: () => void;
}

/**
 * @param otherReserved parameter names controlled by other widgets of the page (e.g. the printing switch).
 */
export function useSectionDraft(base: ConfigurationDocument, sectionName: string, fields: ParameterField[], otherReserved: string[] = []): SectionDraft {
    const reservedKey = otherReserved.join("\n");
    const reserved = useMemo(() => {
        const otherKeys = reservedKey.split("\n").filter(Boolean)
                .map(parameterKey);
        return (name: string) => isFieldParameter(fields, name) || otherKeys.includes(parameterKey(name));
    }, [fields, reservedKey]);
    const initialRows = () => listParameters(base, sectionName).filter(parameter => !reserved(parameter.name));
    const [fieldDocument, setFieldDocument] = useState(base);
    const [rows, setRows] = useState<ParameterRow[]>(initialRows);
    const reset = () => {
        setFieldDocument(base);
        setRows(initialRows());
    };
    const rowsValid = rows.every(row => parameterRowError(row, reserved) === null);
    const document = useMemo(() => {
        if (!rowsValid)
            return fieldDocument;
        const fieldParameters = listParameters(fieldDocument, sectionName).filter(parameter => reserved(parameter.name));
        return replaceParameters(fieldDocument, sectionName, [...fieldParameters, ...rowsToParameters(rows)]);
    }, [fieldDocument, rows, rowsValid, sectionName, reserved]);
    const fieldsValid = fields.every(field => {
        const value = getParameter(fieldDocument, sectionName, field.parameter);
        return value === undefined || validateFieldValue(field, value) === null;
    });
    return { fieldDocument, setFieldDocument, rows, setRows, reserved, document, rowsValid, valid: rowsValid && fieldsValid, reset };
}

/** Existence, owner and mode of a share path, with a button to create it. */
const PathCheck = ({ path }: { path: string }) => {
    const [information, setInformation] = useState<PathInformation | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [generation, setGeneration] = useState(0);

    useEffect(() => {
        setInformation(null);
        if (!path.startsWith("/"))
            return;
        let cancelled = false;
        const timer = window.setTimeout(() => {
            readPathInformation(path).then(result => { if (!cancelled) setInformation(result); });
        }, 400);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [path, generation]);

    if (!path)
        return null;
    if (!path.startsWith("/"))
        return <HelperTextItem variant="error">{_("Use an absolute path.")}</HelperTextItem>;
    if (!information)
        return <HelperTextItem>{_("Checking path…")}</HelperTextItem>;
    if (!information.exists) {
        return (
            <HelperTextItem variant="warning">
                {_("The path does not exist.")}{" "}
                <Button
                    variant="link" isInline
                    onClick={() => createDirectory(path).then(() => setGeneration(value => value + 1), createError => setError(errorMessage(createError)))}
                >
                    {_("Create directory")}
                </Button>
                {error && ` ${error}`}
            </HelperTextItem>
        );
    }
    const description = cockpit.format(_("$0, owner $1:$2, mode $3"),
                                       information.isDirectory ? _("Directory") : _("Not a directory"),
                                       information.owner, information.group, information.mode);
    if (!information.isDirectory)
        return <HelperTextItem variant="error">{description}</HelperTextItem>;
    if (isWorldWritableMode(information.mode))
        return <HelperTextItem variant="warning">{description} — {_("writable by every local user")}</HelperTextItem>;
    return <HelperTextItem variant="success">{description}</HelperTextItem>;
};

/** Select appending a Samba user or @group to a user list field. */
const AccountPicker = ({ fieldId, value, onChange, accounts }: { fieldId: string; value: string | undefined; onChange: (value: string) => void; accounts: string[] }) => {
    const current = splitList(value ?? "");
    const available = accounts.filter(account => !current.includes(account));
    if (available.length === 0)
        return null;
    return (
        <FormSelect
            id={`${fieldId}-picker`} aria-label={_("Add user or group")} value="" className="smb-picker"
            onChange={(_event, chosen) => chosen && onChange(joinList([...current, chosen]))}
        >
            <FormSelectOption value="" label={_("Add user or @group…")} />
            {available.map(account => <FormSelectOption key={account} value={account} label={account} />)}
        </FormSelect>
    );
};

/** @returns Samba user names followed by @groups, for the user list pickers. */
export function useAccountNames(): string[] {
    const [names, setNames] = useState<string[]>([]);
    useEffect(() => {
        Promise.all([listSambaUsers().catch(() => []), listLinuxGroups().catch(() => [])])
                .then(([users, groups]) => setNames([
                    ...users.map(user => user.userName),
                    ...groups.filter(group => group.id >= 1000 || group.members.length > 0 || ["users", "sambashare"].includes(group.name))
                            .map(group => `@${group.name}`),
                ]));
    }, []);
    return names;
}

/** Dedicated fields of one section, and the free key/value editor below them. */
export const SectionForm = ({ draft, sectionName, fields, idPrefix, accounts }: {
    draft: SectionDraft;
    sectionName: string;
    fields: ParameterField[];
    idPrefix: string;
    accounts: string[];
}) => (
    <Form isHorizontal onSubmit={event => event.preventDefault()}>
        {fields.map(field => {
            const fieldId = `${idPrefix}-${field.parameter.replace(/\s+/g, "-")}`;
            const value = getParameter(draft.fieldDocument, sectionName, field.parameter);
            const inheritedValue = sectionName === GLOBAL_SECTION ? undefined : getParameter(draft.fieldDocument, GLOBAL_SECTION, field.parameter);
            const onChange = (changed: string | null) => draft.setFieldDocument(document => setParameter(document, sectionName, field.parameter, changed));
            return (
                <ParameterFieldInput
                    key={field.parameter} field={field} fieldId={fieldId} value={value} inheritedValue={inheritedValue} onChange={onChange}
                    extraHelp={field.kind === "path" ? <PathCheck path={value ?? ""} /> : undefined}
                >
                    {field.kind === "users" && <AccountPicker fieldId={fieldId} value={value} onChange={onChange} accounts={accounts} />}
                </ParameterFieldInput>
            );
        })}
    </Form>
);

export const OtherParameters = ({ draft, idPrefix }: { draft: SectionDraft; idPrefix: string }) => (
    <ParameterTable rows={draft.rows} onChange={rows => draft.setRows(rows)} reserved={draft.reserved} idPrefix={idPrefix} />
);
