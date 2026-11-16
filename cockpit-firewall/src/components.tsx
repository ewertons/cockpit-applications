import React from 'react';
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

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
        return <p className="fw-muted">{emptyText}</p>;
    return (
        <table className="fw-table">
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

export interface SelectChoice {
    value: string;
    label: string;
}

/** Labelled select. */
export const SelectField = ({ label, value, choices, onChange, fieldId, ariaLabel }: {
    label: string;
    /** Accessible name when the visible label is empty (e.g. inside table rows). */
    ariaLabel?: string;
    value: string;
    choices: SelectChoice[];
    onChange: (value: string) => void;
    fieldId: string;
}) => (
    <FormGroup label={label} fieldId={fieldId}>
        <FormSelect id={fieldId} aria-label={ariaLabel} value={value} onChange={(_event, selected) => onChange(selected)}>
            {choices.map(choice => <FormSelectOption key={choice.value} value={choice.value} label={choice.label} />)}
        </FormSelect>
    </FormGroup>
);

/** Labelled text input. */
export const TextField = ({ label, value, onChange, fieldId, placeholder }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    fieldId: string;
    placeholder?: string;
}) => (
    <FormGroup label={label} fieldId={fieldId}>
        <TextInput id={fieldId} value={value} onChange={(_event, text) => onChange(text)} {...placeholder ? { placeholder } : {}} />
    </FormGroup>
);

/** @returns a copy of `items` with the element at `index` moved by `offset`. */
export function moveItem<T>(items: T[], index: number, offset: number): T[] {
    const target = index + offset;
    if (target < 0 || target >= items.length)
        return items;
    const copy = [...items];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    return copy;
}

/** @returns a copy of `items` without the element at `index`. */
export function removeItem<T>(items: T[], index: number): T[] {
    return items.filter((_item, itemIndex) => itemIndex !== index);
}

/** @returns `items` with the element at `index` replaced. */
export function replaceItem<T>(items: T[], index: number, item: T): T[] {
    return items.map((existing, itemIndex) => itemIndex === index ? item : existing);
}
