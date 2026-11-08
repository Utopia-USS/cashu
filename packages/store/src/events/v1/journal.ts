// Decisions, theses, strategy versions, planned deposits payloads (events.md 8.8).
import { z } from "zod";
import { empty, patchOf, payload } from "./helpers.js";
import { assetCurrency, calendarDate, decimal, gid, jsonObject, sha256Hex } from "./primitives.js";

export const DECISION_ACTIONS = ["bought", "sold", "held", "ignored", "other"] as const;
export const THESIS_ENTRY_TYPES = ["sentiment_correction", "trend", "special_situation"] as const;
export const STRATEGY_STATES = ["valid", "partial", "invalid"] as const;

const thesisFields = {
  entryType: z.enum(THESIS_ENTRY_TYPES),
  thesis: z.string().min(1),
  invalidation: z.string().nullable(),
  exitPlan: z.string().nullable(),
  sizePlan: z.string().nullable(),
};

export const journalEvents = {
  "decision.recorded": payload({
    signals: z.array(gid),
    instrument: gid.nullable(),
    account: gid.nullable(),
    action: z.enum(DECISION_ACTIONS),
    quantity: decimal.nullable(),
    price: decimal.nullable(),
    currency: assetCurrency.nullable(),
    reason: z.string().nullable(),
  }).refine((v) => new Set(v.signals).size === v.signals.length, {
    message: "a decision links each signal once",
  }),
  "decision.undone": empty,

  "thesis.created": payload({ instrument: gid, ...thesisFields }),
  "thesis.updated": patchOf({ ...thesisFields, reviewed: z.literal(true) }),
  "thesis.deleted": empty,

  "strategy.versionSaved": payload({
    yamlText: z.string(),
    mdText: z.string().nullable(),
    sha256: sha256Hex,
    state: z.enum(STRATEGY_STATES),
    issues: z.array(jsonObject),
    // The version this text was edited on top of (null: none was recorded yet). Absent in versions
    // recorded before base tracking: their base is unknown (events.md 8.8).
    base: gid.nullable().optional(),
  }),

  "plannedDeposit.created": payload({
    account: gid.nullable(),
    amount: decimal.refine((s) => !s.startsWith("-") && /[1-9]/.test(s), "amount must be > 0"),
    currency: assetCurrency,
    plannedDate: calendarDate,
    note: z.string().nullable(),
  }),
  "plannedDeposit.cancelled": empty,
  "plannedDeposit.booked": payload({ txn: gid }),
} as const;
