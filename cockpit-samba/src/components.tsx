import React from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

import cockpit from 'cockpit';

import { ParameterField } from './model.js';
import { SectionParameter } from './smb-conf.js';
import { diffLines } from './text-diff.js';
import { validateFieldValue, validateParameterName, validateParameterValue } from './validation.js';
import { SecurityWarning } from './warnings.js';

const _ = cockpit.gettext;

/** Page title with optional description and actions, shared look with the other apps. */
export const PageHeader = ({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) => (
    <div className="page-header">
        <div className="page-header-title">
            <h2>{title}</h2>
            {description && <p>{description}</p>}
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
    </div>
);

/** Plain table with a header row; rows are already-rendered cells. */
export const SimpleTable = ({ headers, rows, emptyText }: { headers: string[]; rows: React.ReactNode[][]; emptyText: string }) => {
    if (rows.length === 0)
        return <p className="smb-muted">{emptyText}</p>;
    return (
        <table className="smb-table">
            <thead>
                <tr>{headers.map(header => <th key={header}>{header}</th>)}</tr>
            </thead>
            <tbody>
                {rows.map((cells, rowIndex) => (
                    <tr key={rowIndex}>
                        {cells.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
                    </tr>
                ))}
            </tbody>
        </table>
    );
};

export const DiffView = ({ before, after }: { before: string; after: string }) => (
    <pre className="smb-diff">
        {diffLines(before, after).map((line, index) => (
            <div key={index} className={`smb-diff-${line.kind}`}>
                {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}{line.text}
            </div>
        ))}
    </pre>
);

const SEVERITY_VARIANT = { danger: "danger", warning: "warning", info: "info" } as const;

/** Security warnings with their mitigations. */
export const WarningList = ({ warnings, emptyText }: { warnings: SecurityWarning[]; emptyText?: string }) => {
    if (warnings.length === 0)
        return emptyText ? <p className="smb-muted">{emptyText}</p> : null;
    return (
        <>
            {warnings.map(warning => (
                <Alert
                    key={`${warning.code}-${warning.share ?? ""}`}
                    variant={SEVERITY_VARIANT[warning.severity]}
                    isInline isPlain={warning.severity === "info"}
                    className="smb-alert"
                    title={warning.share ? `[${warning.share}] ${warning.message}` : warning.message}
                >
                    {warning.mitigations.length > 0 &&
                        <ul className="smb-bullets">{warning.mitigations.map(item => <li key={item}>{item}</li>)}</ul>}
                </Alert>
            ))}
        </>
    );
};

/** Choices offered for a boolean parameter; "" leaves it unset. */
const BOOLEAN_CHOICES = ["yes", "no"];

/**
 * Widget for one known parameter. An empty value (or "Default") removes the
 * parameter so Samba's default applies.
 */
export const ParameterFieldInput = ({ field, value, onChange, fieldId, extraHelp, children }: {
    field: ParameterField;
    /** Current value, or undefined when the parameter is not set. */
    value: string | undefined;
    onChange: (value: string | null) => void;
    fieldId: string;
    extraHelp?: React.ReactNode;
    children?: React.ReactNode;
}) => {
    const error = value === undefined || value === "" ? null : validateFieldValue(field, value);
    const helper = (
        <HelperText>
            {error && <HelperTextItem variant="error">{error}</HelperTextItem>}
            {field.help && <HelperTextItem>{_(field.help)}</HelperTextItem>}
            {extraHelp}
        </HelperText>
    );

    if (field.kind === "boolean" || field.kind === "choice") {
        const choices = field.kind === "boolean" ? BOOLEAN_CHOICES : field.choices ?? [];
        const known = value === undefined || choices.some(choice => choice.toLowerCase() === value.toLowerCase());
        const selected = value === undefined ? "" : choices.find(choice => choice.toLowerCase() === value.toLowerCase()) ?? value;
        return (
            <FormGroup label={_(field.label)} fieldId={fieldId}>
                <FormSelect id={fieldId} value={selected} onChange={(_event, chosen) => onChange(chosen === "" ? null : chosen)}>
                    <FormSelectOption value="" label={cockpit.format(_("Default ($0)"), field.defaultValue)} />
                    {!known && <FormSelectOption value={value} label={value!} />}
                    {choices.map(choice => <FormSelectOption key={choice} value={choice} label={choice} />)}
                </FormSelect>
                {helper}
                {children}
            </FormGroup>
        );
    }

    return (
        <FormGroup label={_(field.label)} fieldId={fieldId}>
            <TextInput
                id={fieldId}
                value={value ?? ""}
                validated={error ? "error" : "default"}
                {...field.defaultValue ? { placeholder: cockpit.format(_("Default: $0"), field.defaultValue) } : {}}
                onChange={(_event, text) => onChange(text === "" ? null : text)}
            />
            {helper}
            {children}
        </FormGroup>
    );
};

export interface ParameterRow {
    name: string;
    value: string;
}

/** @returns a problem with a generic row, or null; `reserved` tells whether the name is edited by a dedicated field. */
export function parameterRowError(row: ParameterRow, reserved: (name: string) => boolean): string | null {
    if (row.name.trim() === "" && row.value.trim() === "")
        return null;
    const nameError = validateParameterName(row.name);
    if (nameError)
        return nameError;
    if (reserved(row.name))
        return _("This parameter has its own field above.");
    return validateParameterValue(row.value);
}

/** Free key/value editor for parameters without a dedicated field. */
export const ParameterTable = ({ rows, onChange, reserved, idPrefix }: {
    rows: ParameterRow[];
    onChange: (rows: ParameterRow[]) => void;
    reserved: (name: string) => boolean;
    idPrefix: string;
}) => (
    <div className="smb-parameter-table">
        {rows.length === 0 && <p className="smb-muted">{_("No other parameters.")}</p>}
        {rows.map((row, index) => {
            const error = parameterRowError(row, reserved);
            const update = (changed: Partial<ParameterRow>) => onChange(rows.map((existing, rowIndex) => rowIndex === index ? { ...existing, ...changed } : existing));
            return (
                <div key={index} className="smb-parameter-row">
                    <TextInput
                        id={`${idPrefix}-name-${index}`} aria-label={_("Parameter name")} value={row.name}
                        validated={error ? "error" : "default"}
                        onChange={(_event, text) => update({ name: text })}
                    />
                    <span className="smb-equals">=</span>
                    <TextInput
                        id={`${idPrefix}-value-${index}`} aria-label={_("Parameter value")} value={row.value}
                        onChange={(_event, text) => update({ value: text })}
                    />
                    <Button variant="plain" aria-label={_("Remove parameter")} onClick={() => onChange(rows.filter((_row, rowIndex) => rowIndex !== index))}>
                        ✕
                    </Button>
                    {error && <HelperText className="smb-parameter-error"><HelperTextItem variant="error">{error}</HelperTextItem></HelperText>}
                </div>
            );
        })}
        <Button variant="link" isInline onClick={() => onChange([...rows, { name: "", value: "" }])}>{_("Add parameter")}</Button>
    </div>
);

/** @returns rows without empty lines, as section parameters. */
export function rowsToParameters(rows: ParameterRow[]): SectionParameter[] {
    return rows.filter(row => row.name.trim() !== "").map(row => ({ name: row.name.trim().replace(/\s+/g, " "), value: row.value.trim() }));
}

export const ErrorAlert = ({ error, title }: { error: string | null; title?: string }) =>
    error ? <Alert variant="danger" isInline className="smb-alert" title={title ?? _("Operation failed")}><pre className="smb-pre-wrap">{error}</pre></Alert> : null;
