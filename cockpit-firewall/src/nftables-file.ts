/**
 * Edits /etc/nftables.conf: replaces only this app's block and keeps every
 * other line verbatim, including `flush ruleset` and tables of other tools.
 */

import { INET_TABLE_NAME, LEGACY_NAT_TABLE_NAME } from './model.js';
import { BLOCK_BEGIN_MARKER, BLOCK_END_MARKER } from './ruleset.js';
import { TableStatement, bodyStatements, blockBody, splitStatements, tokenize, topLevelTables, words } from './nft-syntax.js';

export const NFTABLES_CONFIGURATION_PATH = "/etc/nftables.conf";
/** Header of a newly created /etc/nftables.conf. No `flush ruleset`: it would wipe tables of other tools on reload. */
export const NEW_FILE_HEADER = "#!/usr/sbin/nft -f\n";
export const STOCK_FILTER_TABLE = { family: "inet", name: "filter" } as const;

interface TextRange {
    start: number;
    end: number;
}

function isOwnTableStatement(table: TableStatement): boolean {
    return (table.family === "inet" && table.name === INET_TABLE_NAME) ||
        (table.family === "ip" && table.name === LEGACY_NAT_TABLE_NAME);
}

function isStockFilterStatement(table: TableStatement): boolean {
    return table.family === STOCK_FILTER_TABLE.family && table.name === STOCK_FILTER_TABLE.name;
}

/** Widens a range to whole lines when nothing but blanks shares those lines with it. */
function wholeLines(text: string, range: TextRange): TextRange {
    let start = range.start;
    while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t"))
        start--;
    if (start > 0 && text[start - 1] !== "\n")
        start = range.start;
    let end = range.end;
    while (end < text.length && (text[end] === " " || text[end] === "\t" || text[end] === ";"))
        end++;
    if (end < text.length && text[end] === "\n")
        end++;
    else if (end < text.length)
        end = range.end;
    return { start, end };
}

/** @returns the range of the marker block, null when absent. @throws Error when the markers are unbalanced. */
function markerRange(text: string): TextRange | null {
    const begin = text.search(new RegExp(`^${BLOCK_BEGIN_MARKER}[ \\t]*$`, "m"));
    const endMatch = new RegExp(`^${BLOCK_END_MARKER}[ \\t]*$`, "m").exec(text.slice(Math.max(begin, 0)));
    if (begin === -1 && !endMatch)
        return null;
    if (begin === -1 || !endMatch)
        throw new Error(`${NFTABLES_CONFIGURATION_PATH} has "${BLOCK_BEGIN_MARKER}" without "${BLOCK_END_MARKER}" or the other way round; fix it by hand`);
    const end = begin + endMatch.index + endMatch[0].length;
    return { start: begin, end: end < text.length && text[end] === "\n" ? end + 1 : end };
}

/**
 * Replaces this app's block in the file text. Everything else is kept byte for byte.
 * The block takes the place of the marker block, or of the first `inet cockpit_fw`
 * (or legacy `ip cockpit_fw_nat`) statement, or is appended.
 * @param fileText current file content; "" when the file does not exist.
 * @param block generated block (see generateRuleset), or "" to remove it.
 * @param removeStockFilterTable also cut the stock accept-all `table inet filter`.
 * @throws Error when the markers are unbalanced.
 */
export function replaceManagedBlock(fileText: string, block: string, removeStockFilterTable: boolean): string {
    if (fileText.trim() === "")
        return block === "" ? fileText : NEW_FILE_HEADER + "\n" + block;
    const ranges: TextRange[] = [];
    const marker = markerRange(fileText);
    if (marker)
        ranges.push(marker);
    for (const table of topLevelTables(fileText))
        if (isOwnTableStatement(table) || (removeStockFilterTable && isStockFilterStatement(table)))
            ranges.push(wholeLines(fileText, table.statement));
    if (ranges.length === 0) {
        if (block === "")
            return fileText;
        const separator = fileText.endsWith("\n\n") ? "" : fileText.endsWith("\n") ? "\n" : "\n\n";
        return fileText + separator + block;
    }
    ranges.sort((first, second) => first.start - second.start);
    const merged: TextRange[] = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end)
            last.end = Math.max(last.end, range.end);
        else
            merged.push({ ...range });
    }
    let result = "";
    let position = 0;
    merged.forEach((range, index) => {
        result += fileText.slice(position, range.start);
        if (index === 0)
            result += block;
        position = range.end;
    });
    return result + fileText.slice(position);
}

/** @returns the app's part of the file: the marker block or its own table statements; "" when none. */
export function managedPartOfFile(fileText: string): string {
    const marker = markerRange(fileText);
    if (marker)
        return fileText.slice(marker.start, marker.end);
    return topLevelTables(fileText).filter(isOwnTableStatement)
            .map(table => fileText.slice(table.statement.start, table.statement.end))
            .join("\n");
}

/** @returns the file text without this app's part, to show foreign content read-only. */
export function foreignPartOfFile(fileText: string): string {
    return replaceManagedBlock(fileText, "", false);
}

/**
 * State of `table inet filter` in some nftables text: absent, the stock
 * accept-all table (only base chains with policy accept and no rules), or modified.
 */
export type StockFilterTableState = "absent" | "stock" | "modified";

/** @returns whether a chain body only declares a filter hook with policy accept. */
function isEmptyAcceptChain(source: string, chainBody: ReturnType<typeof blockBody>): boolean {
    for (const statement of bodyStatements(source, chainBody ?? [])) {
        const texts = words(statement);
        if (texts[0] === "type" && texts[1] === "filter" && texts[2] === "hook")
            continue;
        if (texts[0] === "policy" && texts[1] === "accept")
            continue;
        return false;
    }
    return true;
}

/** @returns the state of `table inet filter` in the text (file or `nft list ruleset` output). */
export function stockFilterTableState(text: string): StockFilterTableState {
    const tables = topLevelTables(text).filter(table => isStockFilterStatement(table) && !table.isDelete && table.body !== null);
    if (tables.length === 0)
        return "absent";
    for (const table of tables)
        for (const statement of bodyStatements(text, table.body!)) {
            const texts = words(statement);
            if (texts[0] !== "chain" || !isEmptyAcceptChain(text, blockBody(statement)))
                return "modified";
        }
    return "stock";
}

/** @returns whether the file contains a top-level `flush ruleset`. */
export function hasFlushRuleset(fileText: string): boolean {
    return splitStatements(tokenize(fileText)).some(statement => {
        const texts = words(statement);
        return texts[0] === "flush" && texts[1] === "ruleset";
    });
}

/** @returns "family name" of every table the file defines or declares. */
export function tablesDefinedInFile(fileText: string): string[] {
    return [...new Set(topLevelTables(fileText).filter(table => !table.isDelete)
            .map(table => `${table.family} ${table.name}`))];
}
