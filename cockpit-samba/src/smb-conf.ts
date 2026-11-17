/**
 * Lossless smb.conf parser and serializer.
 *
 * Every line keeps its original text; only lines changed through the editing
 * functions are regenerated, so comments, unknown parameters, includes and
 * formatting survive a round trip. Follows Samba's params.c: `#` and `;` start
 * comment lines (never inline), a trailing `\` continues parameter and section
 * lines, and section and parameter names are matched case-insensitively.
 */

import { invertBooleanText, isRepeatableParameter, parameterKey, resolveParameter } from './parameters.js';

export type LineKind = "blank" | "comment" | "parameter" | "unparsed";

export interface ConfigurationLine {
    kind: LineKind;
    /** Original physical lines, several when continued with "\"; null for lines created or changed here. */
    rawLines: string[] | null;
    /** Parameter name as written (parameters only). */
    name: string;
    /** Parameter value with continuations joined, trimmed (parameters only). */
    value: string;
    /** Leading whitespace kept from the original line when a parameter is rewritten. */
    indentation?: string;
}

export interface ConfigurationSection {
    /** Section name as written, without brackets. */
    name: string;
    /** Original header lines; null when created or renamed here. */
    headerRawLines: string[] | null;
    /** Comment lines directly above the header; they go with the section when it is removed. */
    leadingLines: ConfigurationLine[];
    lines: ConfigurationLine[];
}

export interface ConfigurationDocument {
    /** Lines before the first section header. */
    preamble: ConfigurationLine[];
    sections: ConfigurationSection[];
    endsWithNewline: boolean;
}

export const GLOBAL_SECTION = "global";

const DEFAULT_INDENTATION = "\t";

function withoutCarriageReturn(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function isCommentText(text: string): boolean {
    return /^\s*[#;]/.test(text);
}

function endsWithContinuation(text: string): boolean {
    return text.endsWith("\\");
}

/** @returns the parsed document; never throws, unparsable lines are kept verbatim. */
export function parseConfiguration(text: string): ConfigurationDocument {
    const document: ConfigurationDocument = { preamble: [], sections: [], endsWithNewline: text === "" || text.endsWith("\n") };
    if (text === "")
        return document;
    const physicalLines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    let currentLines = document.preamble;

    let index = 0;
    while (index < physicalLines.length) {
        const first = withoutCarriageReturn(physicalLines[index]);
        if (first.trim() === "") {
            currentLines.push({ kind: "blank", rawLines: [physicalLines[index]], name: "", value: "" });
            index++;
            continue;
        }
        if (isCommentText(first)) {
            currentLines.push({ kind: "comment", rawLines: [physicalLines[index]], name: "", value: "" });
            index++;
            continue;
        }

        const rawLines = [physicalLines[index]];
        let logical = first;
        while (endsWithContinuation(logical) && index + 1 < physicalLines.length) {
            index++;
            rawLines.push(physicalLines[index]);
            logical = logical.slice(0, -1) + withoutCarriageReturn(physicalLines[index]);
        }
        index++;

        const header = /^\s*\[([^\]]*)\]/.exec(logical);
        if (header) {
            const leadingLines: ConfigurationLine[] = [];
            while (currentLines.length > 0 && currentLines[currentLines.length - 1].kind === "comment")
                leadingLines.unshift(currentLines.pop()!);
            const section: ConfigurationSection = { name: header[1].trim(), headerRawLines: rawLines, leadingLines, lines: [] };
            document.sections.push(section);
            currentLines = section.lines;
            continue;
        }

        const equals = logical.indexOf("=");
        if (equals > 0 && logical.slice(0, equals).trim() !== "") {
            currentLines.push({
                kind: "parameter",
                rawLines,
                name: logical.slice(0, equals).trim(),
                value: logical.slice(equals + 1).trim(),
            });
        } else {
            currentLines.push({ kind: "unparsed", rawLines, name: "", value: "" });
        }
    }
    return document;
}

/** @returns the leading whitespace used by existing parameter lines of the section, or a tab. */
function sectionIndentation(section: ConfigurationSection): string {
    for (const line of section.lines) {
        if (line.kind === "parameter" && line.rawLines)
            return /^\s*/.exec(line.rawLines[0])![0];
    }
    return DEFAULT_INDENTATION;
}

function lineText(line: ConfigurationLine, indentation: string): string[] {
    if (line.rawLines)
        return line.rawLines;
    return [`${line.indentation ?? indentation}${line.name} = ${line.value}`];
}

/** @returns the smb.conf text; an unmodified document yields exactly the parsed text. */
export function serializeConfiguration(document: ConfigurationDocument): string {
    const output: string[] = [];
    for (const line of document.preamble)
        output.push(...lineText(line, ""));
    for (const section of document.sections) {
        if (!section.headerRawLines && output.length > 0 && output[output.length - 1].trim() !== "")
            output.push("");
        const indentation = sectionIndentation(section);
        for (const line of section.leadingLines)
            output.push(...lineText(line, indentation));
        output.push(...section.headerRawLines ?? [`[${section.name}]`]);
        for (const line of section.lines)
            output.push(...lineText(line, indentation));
    }
    if (output.length === 0)
        return "";
    return output.join("\n") + (document.endsWithNewline ? "\n" : "");
}

/** @returns whether two section names refer to the same Samba service (case-insensitive). */
export function sameSectionName(first: string, second: string): boolean {
    return first.trim().toLowerCase() === second.trim().toLowerCase();
}

/** @returns section names in file order, each once (Samba merges repeated sections). */
export function listSectionNames(document: ConfigurationDocument): string[] {
    const names: string[] = [];
    for (const section of document.sections) {
        if (!names.some(name => sameSectionName(name, section.name)))
            names.push(section.name);
    }
    return names;
}

/** @returns whether a section with this name exists. */
export function hasSection(document: ConfigurationDocument, sectionName: string): boolean {
    return document.sections.some(section => sameSectionName(section.name, sectionName));
}

/**
 * @returns the parameter lines that apply to a section, in order. Parameters
 * before the first header belong to [global], as in Samba.
 */
function parameterLines(document: ConfigurationDocument, sectionName: string): ConfigurationLine[] {
    const lines: ConfigurationLine[] = [];
    if (sameSectionName(sectionName, GLOBAL_SECTION))
        lines.push(...document.preamble.filter(line => line.kind === "parameter"));
    for (const section of document.sections) {
        if (sameSectionName(section.name, sectionName))
            lines.push(...section.lines.filter(line => line.kind === "parameter"));
    }
    return lines;
}

/**
 * @returns the effective value of a parameter set directly in the section
 * (last occurrence of the name or any synonym; inverted synonyms are
 * translated), or undefined when not set there.
 */
export function getParameter(document: ConfigurationDocument, sectionName: string, parameterName: string): string | undefined {
    const wanted = resolveParameter(parameterName);
    let result: string | undefined;
    for (const line of parameterLines(document, sectionName)) {
        const resolved = resolveParameter(line.name);
        if (resolved.canonicalKey !== wanted.canonicalKey)
            continue;
        result = resolved.inverted !== wanted.inverted ? invertBooleanText(line.value) : line.value;
    }
    return result;
}

/** @returns all values of a parameter (and synonyms) in the section, in order; used for repeatable ones like include. */
export function getParameterValues(document: ConfigurationDocument, sectionName: string, parameterName: string): string[] {
    const wanted = resolveParameter(parameterName);
    return parameterLines(document, sectionName)
            .filter(line => resolveParameter(line.name).canonicalKey === wanted.canonicalKey)
            .map(line => resolveParameter(line.name).inverted !== wanted.inverted ? invertBooleanText(line.value) : line.value);
}

export interface SectionParameter {
    /** Name as written in the file. */
    name: string;
    value: string;
}

/** @returns every parameter line of the section in order, as written. */
export function listParameters(document: ConfigurationDocument, sectionName: string): SectionParameter[] {
    return parameterLines(document, sectionName).map(line => ({ name: line.name, value: line.value }));
}

function cloneDocument(document: ConfigurationDocument): ConfigurationDocument {
    return {
        preamble: [...document.preamble],
        sections: document.sections.map(section => ({ ...section, leadingLines: [...section.leadingLines], lines: [...section.lines] })),
        endsWithNewline: document.endsWithNewline,
    };
}

/** @returns the line lists holding the section's parameters, in file order. */
function sectionLineLists(document: ConfigurationDocument, sectionName: string): ConfigurationLine[][] {
    const lists: ConfigurationLine[][] = [];
    if (sameSectionName(sectionName, GLOBAL_SECTION) && document.preamble.some(line => line.kind === "parameter"))
        lists.push(document.preamble);
    for (const section of document.sections) {
        if (sameSectionName(section.name, sectionName))
            lists.push(section.lines);
    }
    return lists;
}

/** How a parameter line relates to the parameter being edited. */
type LineMatcher = (name: string) => { matched: boolean; inverted: boolean };

/** Shared implementation of setParameterValues and replaceParameters. */
function setMatchingValues(document: ConfigurationDocument, sectionName: string, matcher: LineMatcher, newName: string, values: string[]): ConfigurationDocument {
    const result = cloneDocument(document);
    const isGlobal = sameSectionName(sectionName, GLOBAL_SECTION);
    if (!hasSection(result, sectionName) && !(isGlobal && result.preamble.some(line => line.kind === "parameter"))) {
        if (values.length === 0)
            return document;
        const created: ConfigurationSection = { name: sectionName, headerRawLines: null, leadingLines: [], lines: [] };
        if (isGlobal)
            result.sections.unshift(created);
        else
            result.sections.push(created);
    }

    const lists = sectionLineLists(result, sectionName);
    const remaining = [...values];
    let lastList = lists[lists.length - 1];
    let insertAfter = -1;
    for (const list of lists) {
        for (let index = 0; index < list.length; index++) {
            const line = list[index];
            if (line.kind !== "parameter")
                continue;
            const match = matcher(line.name);
            if (!match.matched) {
                lastList = list;
                insertAfter = index;
                continue;
            }
            if (remaining.length === 0) {
                list.splice(index, 1);
                index--;
                continue;
            }
            const value = remaining.shift()!;
            const written = match.inverted ? invertBooleanText(value) : value;
            if (written !== line.value)
                list[index] = { ...line, rawLines: null, value: written, ...line.rawLines ? { indentation: /^\s*/.exec(line.rawLines[0])![0] } : {} };
            lastList = list;
            insertAfter = index;
        }
    }
    if (remaining.length > 0) {
        const position = insertAfter < 0 ? firstTrailingBlank(lastList) : insertAfter + 1;
        lastList.splice(position, 0, ...remaining.map(value => ({ kind: "parameter" as const, rawLines: null, name: newName.trim(), value })));
    }
    return result;
}

/**
 * @returns a document where the parameter (matched with its synonyms) has
 * exactly `values`, in order. Existing lines are reused in place (keeping
 * the spelling and any inverted synonym), extra ones are removed and missing
 * ones are added after the section's last parameter. An empty list removes
 * the parameter. The section is created when missing and values are given.
 */
export function setParameterValues(document: ConfigurationDocument, sectionName: string, parameterName: string, values: string[]): ConfigurationDocument {
    const wanted = resolveParameter(parameterName);
    return setMatchingValues(document, sectionName, name => {
        const resolved = resolveParameter(name);
        return { matched: resolved.canonicalKey === wanted.canonicalKey, inverted: resolved.inverted !== wanted.inverted };
    }, parameterName, values);
}

/** @returns the index where trailing blank lines of the list start. */
function firstTrailingBlank(lines: ConfigurationLine[]): number {
    let index = lines.length;
    while (index > 0 && lines[index - 1].kind === "blank")
        index--;
    return index;
}

/**
 * @returns a document with the parameter set to `value`, or removed when
 * `value` is null. Duplicates (and synonyms) are collapsed to one line, except
 * for repeatable parameters such as include, where only the last is replaced.
 */
export function setParameter(document: ConfigurationDocument, sectionName: string, parameterName: string, value: string | null): ConfigurationDocument {
    if (value === null)
        return setParameterValues(document, sectionName, parameterName, []);
    if (isRepeatableParameter(parameterName)) {
        const values = getParameterValues(document, sectionName, parameterName);
        values[Math.max(values.length - 1, 0)] = value;
        return setParameterValues(document, sectionName, parameterName, values);
    }
    if (getParameter(document, sectionName, parameterName) === value && getParameterValues(document, sectionName, parameterName).length === 1)
        return document;
    return setParameterValues(document, sectionName, parameterName, [value]);
}

/**
 * @returns a document where the section's parameters equal `parameters`
 * (generic key/value editing). Parameters are compared by Samba's key; only
 * names whose values changed are rewritten, so untouched lines stay verbatim.
 */
export function replaceParameters(document: ConfigurationDocument, sectionName: string, parameters: SectionParameter[]): ConfigurationDocument {
    const before = listParameters(document, sectionName);
    const keysOf = (list: SectionParameter[]) => new Set(list.map(parameter => parameterKey(parameter.name)));
    const keys = new Set([...keysOf(before), ...keysOf(parameters)]);
    let result = document;
    for (const key of keys) {
        const oldValues = before.filter(parameter => parameterKey(parameter.name) === key).map(parameter => parameter.value);
        const newEntries = parameters.filter(parameter => parameterKey(parameter.name) === key);
        const newValues = newEntries.map(parameter => parameter.value);
        if (oldValues.length === newValues.length && oldValues.every((value, index) => value === newValues[index]))
            continue;
        const name = newEntries[0]?.name ?? before.find(parameter => parameterKey(parameter.name) === key)!.name;
        result = setExactParameterValues(result, sectionName, name, newValues);
    }
    return result;
}

/** Like setParameterValues, but matches only this exact key (no synonyms), so generic edits never touch a synonym line. */
function setExactParameterValues(document: ConfigurationDocument, sectionName: string, parameterName: string, values: string[]): ConfigurationDocument {
    const key = parameterKey(parameterName);
    return setMatchingValues(document, sectionName, name => ({ matched: parameterKey(name) === key, inverted: false }), parameterName, values);
}

/** @returns a document with an empty section appended (no-op when it exists). */
export function addSection(document: ConfigurationDocument, sectionName: string): ConfigurationDocument {
    if (hasSection(document, sectionName))
        return document;
    const result = cloneDocument(document);
    result.sections.push({ name: sectionName, headerRawLines: null, leadingLines: [], lines: [] });
    return result;
}

/** @returns a document without the section (every occurrence), its leading comments included. */
export function removeSection(document: ConfigurationDocument, sectionName: string): ConfigurationDocument {
    const result = cloneDocument(document);
    result.sections = result.sections.filter(section => !sameSectionName(section.name, sectionName));
    return result;
}

/** @returns a document with every occurrence of the section renamed. */
export function renameSection(document: ConfigurationDocument, oldName: string, newName: string): ConfigurationDocument {
    if (oldName === newName)
        return document;
    const result = cloneDocument(document);
    result.sections = result.sections.map(section => sameSectionName(section.name, oldName)
        ? { ...section, name: newName, headerRawLines: null }
        : section);
    return result;
}
