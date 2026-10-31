// The v1 event catalog: every type with its payload schema and its sync metadata (events.md 8.1),
// plus `parseEvent`, which applies the forward-compatibility rules of events.md section 7.
import type { z } from "zod";
import { agentEvents } from "./agent.js";
import { assetsLoansEvents } from "./assets-loans.js";
import { budgetEvents } from "./budget.js";
import { coreEvents } from "./core.js";
import { type Envelope, envelopeSchema } from "./envelope.js";
import { investmentsEvents } from "./investments.js";
import { journalEvents } from "./journal.js";
import { researchEvents } from "./research.js";
import { signalsEvents } from "./signals.js";

/** Conflict rule codes (events.md 6.2). LEADER is an emitter constraint, see `emitter`. */
export type Rule = "CREATE" | "LWW-F" | "SOFT" | "TOMB" | "APPEND" | "FWW" | "GUARD" | "LIFECYCLE";
/** How the event's `gid` is minted (gid.md section 4). */
export type GidStrategy = "VAULT" | "DET" | "ULID" | "DET-or-ULID";
/** Who may emit it: any device, only the fetch-lease holder, or the leader for rule outcomes and any device for owner-caused ones. */
export type Emitter = "any" | "leader" | "leader-or-owner";

export interface EventMeta {
  /** View table the event's `gid` belongs to. */
  table: string;
  rule: Rule;
  gid: GidStrategy;
  emitter: Emitter;
}

const m = (table: string, rule: Rule, gid: GidStrategy, emitter: Emitter = "any"): EventMeta => ({
  table,
  rule,
  gid,
  emitter,
});

export const PAYLOADS = {
  ...coreEvents,
  ...budgetEvents,
  ...assetsLoansEvents,
  ...investmentsEvents,
  ...signalsEvents,
  ...journalEvents,
  ...researchEvents,
  ...agentEvents,
} as const;

export type EventType = keyof typeof PAYLOADS;

export const META: Record<EventType, EventMeta> = {
  "profile.created": m("profiles", "CREATE", "VAULT"),
  "profile.renamed": m("profiles", "LWW-F", "VAULT"),
  "profile.settingsChanged": m("profiles", "LWW-F", "VAULT"),
  "module.enabled": m("profile_modules", "LWW-F", "DET"),
  "module.disabled": m("profile_modules", "LWW-F", "DET"),
  "account.opened": m("accounts", "CREATE", "DET-or-ULID"),
  "account.renamed": m("accounts", "LWW-F", "DET-or-ULID"),
  "account.typeSet": m("accounts", "LWW-F", "DET-or-ULID"),
  "account.removed": m("accounts", "SOFT", "DET-or-ULID"),
  "account.restored": m("accounts", "SOFT", "DET-or-ULID"),
  "balance.recorded": m("balances", "LWW-F", "DET"),
  "budgetSettings.cushionSet": m("budget_settings", "LWW-F", "DET"),

  "txn.imported": m("transactions", "CREATE", "DET"),
  "txn.cashExpenseAdded": m("transactions", "CREATE", "ULID"),
  "txn.categorySet": m("transactions", "GUARD", "DET-or-ULID"),
  "txn.categoryCleared": m("transactions", "LWW-F", "DET-or-ULID"),
  "txn.deleted": m("transactions", "TOMB", "ULID"),
  "categoryRule.set": m("category_rules", "GUARD", "DET"),
  "importBatch.recorded": m("import_batches", "APPEND", "ULID"),

  "loan.termsSet": m("loans", "LWW-F", "DET"),
  "loan.paymentMatchingSet": m("loans", "LWW-F", "DET"),
  "depreciation.set": m("depreciations", "LWW-F", "DET"),
  "assetDetails.noteSet": m("asset_details", "LWW-F", "DET"),

  "invAccount.settingsSet": m("inv_account_settings", "LWW-F", "DET"),
  "invImport.recorded": m("inv_import_batches", "APPEND", "ULID"),
  "invTxn.imported": m("inv_transactions", "CREATE", "DET"),
  "position.snapshotImported": m("inv_position_snapshots", "CREATE", "DET"),
  "instrumentRename.recorded": m("inv_instrument_renames", "CREATE", "DET"),
  "valuation.set": m("inv_manual_valuations", "LWW-F", "DET"),
  "instrument.created": m("inv_instruments", "CREATE", "DET-or-ULID"),
  "instrument.updated": m("inv_instruments", "LWW-F", "DET-or-ULID"),
  "instrument.aliasAdded": m("inv_instrument_aliases", "CREATE", "DET"),
  "instrument.merged": m("inv_instruments", "TOMB", "DET-or-ULID"),
  "instrumentOverride.set": m("inv_profile_instruments", "LWW-F", "DET"),
  "instrumentOverride.planSet": m("inv_profile_instruments", "LWW-F", "DET"),
  "instrumentOverride.segmentSet": m("inv_profile_instruments", "GUARD", "DET"),

  "signal.opened": m("inv_signals", "LIFECYCLE", "DET", "leader"),
  "signal.refreshed": m("inv_signals", "LIFECYCLE", "DET", "leader"),
  "signal.escalated": m("inv_signals", "LIFECYCLE", "DET", "leader"),
  "signal.closed": m("inv_signals", "LIFECYCLE", "DET", "leader-or-owner"),
  "signal.reopened": m("inv_signals", "LIFECYCLE", "DET"),
  "signal.snoozed": m("inv_signals", "LWW-F", "DET"),
  "signal.woken": m("inv_signals", "LIFECYCLE", "DET", "leader"),
  "ruleRun.finished": m("inv_rule_runs", "APPEND", "ULID", "leader"),
  "alert.created": m("alerts", "CREATE", "ULID"),
  "alert.updated": m("alerts", "LWW-F", "ULID"),
  "alert.statusSet": m("alerts", "LWW-F", "ULID"),
  "alert.deleted": m("alerts", "SOFT", "ULID"),
  "alert.restored": m("alerts", "SOFT", "ULID"),
  "alert.evaluated": m("alerts", "LWW-F", "ULID", "leader"),

  "decision.recorded": m("inv_decisions", "APPEND", "ULID"),
  "decision.undone": m("inv_decisions", "TOMB", "ULID"),
  "thesis.created": m("inv_theses", "CREATE", "ULID"),
  "thesis.updated": m("inv_theses", "LWW-F", "ULID"),
  "thesis.deleted": m("inv_theses", "TOMB", "ULID"),
  "strategy.versionSaved": m("inv_strategy_versions", "APPEND", "ULID"),
  "plannedDeposit.created": m("inv_planned_deposits", "CREATE", "ULID"),
  "plannedDeposit.cancelled": m("inv_planned_deposits", "FWW", "ULID"),
  "plannedDeposit.booked": m("inv_planned_deposits", "FWW", "ULID"),

  "watchlist.added": m("watchlist_items", "CREATE", "DET"),
  "watchlist.updated": m("watchlist_items", "LWW-F", "DET"),
  "watchlist.removed": m("watchlist_items", "SOFT", "DET"),
  "topicThesis.ownerSaved": m("inv_topic_theses", "GUARD", "DET"),
  "topicThesis.draftProposed": m("inv_topic_theses", "GUARD", "DET"),
  "topicThesis.rejected": m("inv_topic_theses", "SOFT", "DET"),
  "topicThesis.marketViewSet": m("inv_topic_theses", "LWW-F", "DET"),
  "researchRun.started": m("research_runs", "APPEND", "ULID"),
  "researchRun.finished": m("research_runs", "LWW-F", "ULID"),
  "note.added": m("research_notes", "APPEND", "ULID"),
  "note.read": m("research_notes", "LWW-F", "ULID"),
  "note.dismissed": m("research_notes", "LWW-F", "ULID"),
  "note.restored": m("research_notes", "LWW-F", "ULID"),

  "review.done": m("reviews", "APPEND", "ULID"),
  "review.undone": m("reviews", "TOMB", "ULID"),
  "proposal.created": m("proposals", "CREATE", "ULID"),
  "proposal.approved": m("proposals", "FWW", "ULID"),
  "proposal.rejected": m("proposals", "FWW", "ULID"),
  "proposal.failed": m("proposals", "FWW", "ULID"),
  "connectorBinding.set": m("connector_bindings", "LWW-F", "DET"),
  "connectorBinding.removed": m("connector_bindings", "TOMB", "DET"),
};

/** The payload schema version of every v1 type (events.md section 2: all start at 1). */
export const CURRENT_VERSION: Record<EventType, number> = Object.fromEntries(
  Object.keys(PAYLOADS).map((t) => [t, 1]),
) as Record<EventType, number>;

/** Type prefixes owned by other scopes (events.md 8.11); never defined in this catalog. */
export const RESERVED_PREFIXES = ["device.", "lease.", "snapshot."] as const;

export function isEventType(type: string): type is EventType {
  return Object.hasOwn(PAYLOADS, type);
}

export type ParsedEvent<T extends EventType = EventType> = Envelope & {
  type: T;
  data: z.infer<(typeof PAYLOADS)[T]>;
};

export type ParseResult =
  | { status: "known"; event: ParsedEvent }
  /** Keep in the log, do not apply, re-apply after an upgrade (events.md section 7 rules 1, 2, 4). */
  | {
      status: "parked";
      reason: "unknown-type" | "newer-version" | "invalid-payload";
      envelope: Envelope;
    }
  /** Not a valid envelope at all: reject and report (corrupt or foreign data). */
  | { status: "rejected"; error: string };

/**
 * Validate one raw event. Envelope errors reject; an unknown type, a newer version or a payload
 * that fails this reader's schema parks the event (never dropped, never half applied). Unknown
 * fields pass through untouched.
 */
export function parseEvent(raw: unknown): ParseResult {
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) return { status: "rejected", error: env.error.message };
  const envelope = env.data;
  if (!isEventType(envelope.type)) return { status: "parked", reason: "unknown-type", envelope };
  if (envelope.v > CURRENT_VERSION[envelope.type]) {
    return { status: "parked", reason: "newer-version", envelope };
  }
  const data = PAYLOADS[envelope.type].safeParse(envelope.data);
  if (!data.success) return { status: "parked", reason: "invalid-payload", envelope };
  return { status: "known", event: { ...envelope, data: data.data } as ParsedEvent };
}
