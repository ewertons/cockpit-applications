/**
 * Minimal nftables text tokenizer and statement splitter. Understands enough
 * of the syntax (strings, comments, braces, statement separators) to find
 * top-level tables in /etc/nftables.conf and to read this app's own table
 * back, both from the file and from `nft list table` output.
 */

export type TokenKind = "word" | "string" | "punctuation" | "newline";

export interface Token {
    kind: TokenKind;
    /** Token text; for strings, the text between the quotes. */
    text: string;
    /** Offset of the first character in the source. */
    start: number;
    /** Offset just past the last character in the source. */
    end: number;
}

const PUNCTUATION = new Set(["{", "}", ";", ",", "="]);

/** Splits nftables text into tokens. `#` comments are dropped; newlines are kept as separators. */
export function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;
    while (index < text.length) {
        const character = text[index];
        if (character === "\n") {
            tokens.push({ kind: "newline", text: "\n", start: index, end: index + 1 });
            index++;
        } else if (character === " " || character === "\t" || character === "\r") {
            index++;
        } else if (character === "\\" && text[index + 1] === "\n") {
            index += 2;
        } else if (character === "#") {
            while (index < text.length && text[index] !== "\n")
                index++;
        } else if (character === "\"") {
            const closing = text.indexOf("\"", index + 1);
            const end = closing === -1 ? text.length : closing + 1;
            tokens.push({ kind: "string", text: text.slice(index + 1, closing === -1 ? text.length : closing), start: index, end });
            index = end;
        } else if (PUNCTUATION.has(character)) {
            tokens.push({ kind: "punctuation", text: character, start: index, end: index + 1 });
            index++;
        } else {
            const start = index;
            while (index < text.length && !/[\s#"{};,=]/.test(text[index]))
                index++;
            tokens.push({ kind: "word", text: text.slice(start, index), start, end: index });
        }
    }
    return tokens;
}

/** A statement: tokens up to a newline or ";" outside braces. Nested blocks stay inside it. */
export interface Statement {
    tokens: Token[];
    start: number;
    end: number;
}

/** Splits tokens into statements at newlines and semicolons that are not inside braces. */
export function splitStatements(tokens: Token[]): Statement[] {
    const statements: Statement[] = [];
    let current: Token[] = [];
    let depth = 0;
    const flush = () => {
        if (current.length > 0)
            statements.push({ tokens: current, start: current[0].start, end: current[current.length - 1].end });
        current = [];
    };
    for (const token of tokens) {
        if (depth === 0 && (token.kind === "newline" || (token.kind === "punctuation" && token.text === ";"))) {
            flush();
            continue;
        }
        if (token.kind === "newline")
            continue;
        if (token.kind === "punctuation" && token.text === "{")
            depth++;
        else if (token.kind === "punctuation" && token.text === "}")
            depth = Math.max(0, depth - 1);
        current.push(token);
    }
    flush();
    return statements;
}

/** @returns the tokens between the statement's first "{" and its matching "}", or null when it has no block. */
export function blockBody(statement: Statement): Token[] | null {
    const open = statement.tokens.findIndex(token => token.kind === "punctuation" && token.text === "{");
    if (open === -1)
        return null;
    let depth = 0;
    for (let index = open; index < statement.tokens.length; index++) {
        const token = statement.tokens[index];
        if (token.kind === "punctuation" && token.text === "{")
            depth++;
        else if (token.kind === "punctuation" && token.text === "}" && --depth === 0)
            return statement.tokens.slice(open + 1, index);
    }
    return statement.tokens.slice(open + 1);
}

/** Splits the statements inside a block body; newlines inside the body are needed, so the source is re-tokenized. */
export function bodyStatements(source: string, body: Token[]): Statement[] {
    if (body.length === 0)
        return [];
    return splitStatements(tokenize(source.slice(body[0].start, body[body.length - 1].end)))
            .map(statement => shiftStatement(statement, body[0].start));
}

function shiftStatement(statement: Statement, offset: number): Statement {
    return {
        tokens: statement.tokens.map(token => ({ ...token, start: token.start + offset, end: token.end + offset })),
        start: statement.start + offset,
        end: statement.end + offset,
    };
}

/** @returns the word/string texts of a statement, without punctuation. */
export function words(statement: Statement): string[] {
    return statement.tokens.filter(token => token.kind !== "punctuation").map(token => token.text);
}

/** A top-level `table FAMILY NAME` statement (with or without a body) or `delete table FAMILY NAME`. */
export interface TableStatement {
    statement: Statement;
    family: string;
    name: string;
    isDelete: boolean;
    /** Body tokens, or null for a bare declaration or a delete. */
    body: Token[] | null;
}

/** @returns all top-level table declarations, definitions and deletions in the text. */
export function topLevelTables(text: string): TableStatement[] {
    const result: TableStatement[] = [];
    for (const statement of splitStatements(tokenize(text))) {
        const texts = statement.tokens.map(token => token.text);
        const isDelete = texts[0] === "delete" || texts[0] === "destroy";
        const offset = isDelete ? 1 : 0;
        if (texts[offset] !== "table" || statement.tokens.length < offset + 3)
            continue;
        result.push({
            statement,
            family: texts[offset + 1],
            name: texts[offset + 2],
            isDelete,
            body: isDelete ? null : blockBody(statement),
        });
    }
    return result;
}
