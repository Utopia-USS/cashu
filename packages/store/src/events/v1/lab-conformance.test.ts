/// <reference types="node" />
// Genesis conformance (review M4): every real value of an enum-like or formatted column must pass the
// v1.1 zod field schema, or genesis would park it (and everything referencing it). Runs only when
// CASHU_LAB_DB points at a COPY of a cashU database (never the owner's live data dir). Reports counts
// per column only, never values: nothing from the database reaches the test output or git.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { z as zod } from "zod";
import { MCP_PRIVACY } from "./core.js";
import {
  ACCOUNT_WRAPPERS,
  ASSET_CLASSES,
  INSTRUMENT_STATUSES,
  PLAN_VALUES,
  SEGMENT_SETTERS,
  TXN_SOURCES,
  TXN_TYPES,
  VALUATION_MODES,
} from "./investments.js";
import { DECISION_ACTIONS, STRATEGY_STATES, THESIS_ENTRY_TYPES } from "./journal.js";
import { calendarDate, decimal, key } from "./primitives.js";
import {
  RESEARCH_CREATORS,
  RESEARCH_NOTE_KINDS,
  RESEARCH_THESIS_FIELDS,
  RESEARCH_THESIS_RELATIONS,
  WATCHLIST_SOURCES,
} from "./research.js";
import {
  ALERT_KINDS,
  ALERT_SCOPES,
  ALERT_SOURCES,
  POLARITIES,
  SIGNAL_SEVERITIES,
} from "./signals.js";

const DB = process.env.CASHU_LAB_DB;

type Check = [table: string, column: string, schema: z.ZodType, nullable?: boolean];
const e = (values: readonly [string, ...string[]]) => zod.enum(values);

const CHECKS: Check[] = [
  ["profiles", "mcp_privacy", e(MCP_PRIVACY)],
  ["inv_account_settings", "wrapper", e(ACCOUNT_WRAPPERS)],
  ["inv_instruments", "asset_class", e(ASSET_CLASSES)],
  ["inv_instruments", "valuation_mode", e(VALUATION_MODES)],
  ["inv_instruments", "status", e(INSTRUMENT_STATUSES)],
  ["inv_transactions", "type", e(TXN_TYPES)],
  ["inv_transactions", "source", e(TXN_SOURCES)],
  ["inv_transactions", "trade_date", calendarDate],
  ["inv_transactions", "gross_amount", decimal],
  ["inv_transactions", "cash_amount", decimal],
  ["inv_transactions", "fee", decimal],
  ["inv_transactions", "tax", decimal],
  ["inv_transactions", "quantity", decimal, true],
  ["inv_transactions", "price", decimal, true],
  ["inv_transactions", "fx_rate", decimal, true],
  ["inv_position_snapshots", "quantity", decimal],
  ["inv_manual_valuations", "unit_value", decimal],
  ["inv_profile_instruments", "plan", e(PLAN_VALUES), true],
  ["inv_profile_instruments", "segment_by", e(SEGMENT_SETTERS), true],
  ["inv_profile_instruments", "asset_class", e(ASSET_CLASSES), true],
  ["inv_strategy_versions", "state", e(STRATEGY_STATES)],
  ["inv_rule_runs", "trigger", key],
  ["inv_signals", "severity", e(SIGNAL_SEVERITIES)],
  ["inv_signals", "polarity", e(POLARITIES)],
  ["inv_decisions", "action", e(DECISION_ACTIONS)],
  ["inv_theses", "entry_type", e(THESIS_ENTRY_TYPES)],
  ["alerts", "kind", e(ALERT_KINDS)],
  ["alerts", "scope", e(ALERT_SCOPES)],
  ["alerts", "polarity", e(POLARITIES)],
  ["alerts", "severity", e(SIGNAL_SEVERITIES)],
  ["alerts", "source", e(ALERT_SOURCES)],
  ["alerts", "created_by", key],
  ["watchlist_items", "source", e(WATCHLIST_SOURCES)],
  ["research_notes", "kind", e(RESEARCH_NOTE_KINDS)],
  ["research_notes", "polarity", e(POLARITIES)],
  ["research_notes", "thesis_relation", e(RESEARCH_THESIS_RELATIONS)],
  ["research_notes", "thesis_field", e(RESEARCH_THESIS_FIELDS), true],
  ["research_notes", "created_by", e(RESEARCH_CREATORS)],
];

describe.skipIf(!DB)("lab conformance (CASHU_LAB_DB, counts only)", () => {
  it("every enum-like and formatted value passes its v1.1 schema", async () => {
    if (DB?.includes("Application Support/cashU/")) throw new Error("refusing the live data dir");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(DB as string, { readOnly: true });
    const failures: Record<string, number> = {};
    let checked = 0;
    for (const [table, column, schema, nullable] of CHECKS) {
      const rows = db.prepare(`SELECT "${column}" AS v FROM "${table}"`).all() as Array<{
        v: unknown;
      }>;
      for (const { v } of rows) {
        checked += 1;
        if (v === null && nullable) continue;
        if (!schema.safeParse(v).success) {
          const k = `${table}.${column}`;
          failures[k] = (failures[k] ?? 0) + 1;
        }
      }
    }
    db.close();
    expect(checked).toBeGreaterThan(0);
    expect(failures).toEqual({});
  });
});
