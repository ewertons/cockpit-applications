/**
 * Derives what the UI shows from what the host holds: /etc/nftables.conf,
 * the live table and files of earlier versions. Pure, so it can be unit tested.
 */

import { FirewallConfiguration, LEGACY_NAT_TABLE_NAME, createEmptyConfiguration, requiresForwarding } from './model.js';
import { managedPartOfFile, replaceManagedBlock, stockFilterTableState } from './nftables-file.js';
import { topLevelTables } from './nft-syntax.js';
import { ParsedRuleset, parseManagedTable } from './ruleset-parser.js';
import { generateRuleset, liveApplyText } from './ruleset.js';

/** Raw host state, as read by firewall-backend.ts. */
export interface HostFiles {
    /** /etc/nftables.conf, null when absent. */
    fileText: string | null;
    /** `nft list table inet cockpit_fw`, "" when not loaded. */
    liveOwnTable: string;
    /** `nft list ruleset`. */
    liveRuleset: string;
    /** Converted config.json of an earlier version, if any. */
    legacyConfiguration: FirewallConfiguration | null;
    legacyFilesPresent: boolean;
}

export type ConfigurationSource = "legacy" | "file" | "live" | "empty";

export interface DerivedState {
    fileRuleset: ParsedRuleset | null;
    liveRuleset: ParsedRuleset | null;
    /** Configuration the editor starts from. */
    initialConfiguration: FirewallConfiguration;
    source: ConfigurationSource;
    /** The live table differs from the one in the file (or only one of them exists). */
    drift: boolean;
    /** The stock accept-all `table inet filter` exists (file and/or live) and nothing else uses that name. */
    stockFilterTableRemovable: boolean;
    /** The NAT table of earlier versions is loaded; the next apply deletes it. */
    legacyNatTableLoaded: boolean;
}

/**
 * @returns a comparable form of a parsed table: its regenerated text (or its
 * configuration when invalid) plus the statements the parser did not understand,
 * with counter values removed, so unknown rules also count as differences.
 */
function canonical(parsed: ParsedRuleset | null): string {
    if (!parsed)
        return "";
    let configurationText: string;
    try {
        configurationText = generateRuleset(parsed.configuration).text;
    } catch {
        configurationText = JSON.stringify(parsed.configuration);
    }
    const unrecognized = parsed.unrecognized.map(text => text.replace(/\bcounter packets \d+ bytes \d+/g, "counter"));
    return [configurationText, ...unrecognized].join("\n");
}

/** @returns the UI state for the host files. */
export function deriveState(files: HostFiles): DerivedState {
    const fileRuleset = parseManagedTable(managedPartOfFile(files.fileText ?? ""));
    const liveRuleset = parseManagedTable(files.liveOwnTable);
    let source: ConfigurationSource = "empty";
    let initialConfiguration = createEmptyConfiguration();
    if (files.legacyConfiguration) {
        source = "legacy";
        initialConfiguration = files.legacyConfiguration;
    } else if (fileRuleset) {
        source = "file";
        initialConfiguration = fileRuleset.configuration;
    } else if (liveRuleset) {
        source = "live";
        initialConfiguration = liveRuleset.configuration;
    }
    const fileStock = stockFilterTableState(files.fileText ?? "");
    const liveStock = stockFilterTableState(files.liveRuleset);
    return {
        fileRuleset,
        liveRuleset,
        initialConfiguration,
        source,
        drift: canonical(fileRuleset) !== canonical(liveRuleset),
        stockFilterTableRemovable: fileStock !== "modified" && liveStock !== "modified" && (fileStock === "stock" || liveStock === "stock"),
        legacyNatTableLoaded: topLevelTables(files.liveRuleset).some(table => table.family === "ip" && table.name === LEGACY_NAT_TABLE_NAME),
    };
}

export interface ApplyPlan {
    /** Text loaded live with `nft -f`: only this app's tables (and the stock table when removed). */
    liveText: string;
    /** New /etc/nftables.conf. */
    candidateFile: string;
    enableForwarding: boolean;
    removeStockFilterTable: boolean;
}

/**
 * @returns what Apply loads and what confirmation writes.
 * @throws ConfigurationError when the configuration is invalid.
 */
export function planApply(fileText: string | null, configuration: FirewallConfiguration, removeStockFilterTable: boolean): ApplyPlan {
    const block = generateRuleset(configuration).text;
    return {
        liveText: liveApplyText(block, removeStockFilterTable),
        candidateFile: replaceManagedBlock(fileText ?? "", block, removeStockFilterTable),
        enableForwarding: requiresForwarding(configuration),
        removeStockFilterTable,
    };
}

/** @returns whether applying would change nothing on the host. */
export function isUpToDate(files: HostFiles, state: DerivedState, plan: ApplyPlan): boolean {
    return plan.candidateFile === (files.fileText ?? "") && !state.drift && !files.legacyFilesPresent &&
        !state.legacyNatTableLoaded && !plan.removeStockFilterTable;
}
