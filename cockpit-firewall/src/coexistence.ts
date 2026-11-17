/**
 * Read-only view of nftables tables owned by others (firewalld, docker,
 * hand-written rulesets, ...). Parses `nft -j list chains` output.
 */

import { INET_TABLE_NAME, NAT_TABLE_NAME } from './model.js';

export interface BaseChainSummary {
    name: string;
    type: string;
    hook: string;
    priority: number | string;
    policy: string;
}

export interface ForeignTable {
    family: string;
    name: string;
    chainCount: number;
    baseChains: BaseChainSummary[];
}

/** @returns whether the table belongs to this application. */
export function isOwnTable(family: string, name: string): boolean {
    return (family === "inet" && name === INET_TABLE_NAME) || (family === "ip" && name === NAT_TABLE_NAME);
}

/**
 * Parses `nft -j list chains` output into foreign tables, excluding this app's own tables.
 * Tables without chains are not listed by that command and are therefore omitted.
 */
export function parseForeignTables(jsonText: string): ForeignTable[] {
    let document: unknown;
    try {
        document = JSON.parse(jsonText);
    } catch {
        return [];
    }
    const entries = (document as { nftables?: unknown })?.nftables;
    if (!Array.isArray(entries))
        return [];

    const tables = new Map<string, ForeignTable>();
    for (const entry of entries) {
        const chainObject = (entry as { chain?: Record<string, unknown> })?.chain;
        if (!chainObject)
            continue;
        const family = String(chainObject.family ?? "");
        const tableName = String(chainObject.table ?? "");
        if (!family || !tableName || isOwnTable(family, tableName))
            continue;
        const key = `${family} ${tableName}`;
        let table = tables.get(key);
        if (!table) {
            table = { family, name: tableName, chainCount: 0, baseChains: [] };
            tables.set(key, table);
        }
        table.chainCount++;
        if (typeof chainObject.hook === "string")
            table.baseChains.push({
                name: String(chainObject.name ?? ""),
                type: String(chainObject.type ?? ""),
                hook: chainObject.hook,
                priority: typeof chainObject.prio === "number" ? chainObject.prio : String(chainObject.prio ?? ""),
                policy: String(chainObject.policy ?? "accept"),
            });
    }
    return [...tables.values()].sort((first, second) => `${first.family} ${first.name}`.localeCompare(`${second.family} ${second.name}`));
}

/** Hooks this application also uses; a foreign drop there can override our accept. */
export const SHARED_HOOKS: readonly string[] = ["forward", "input", "postrouting"];

/** @returns warnings for foreign base chains that share a hook with this app and drop by default. */
export function foreignTableWarnings(tables: ForeignTable[]): string[] {
    const warnings: string[] = [];
    for (const table of tables)
        for (const chain of table.baseChains)
            if (SHARED_HOOKS.includes(chain.hook) && chain.policy === "drop")
                warnings.push(`table ${table.family} ${table.name}, chain ${chain.name}: hook ${chain.hook} has policy drop`);
    return warnings;
}
