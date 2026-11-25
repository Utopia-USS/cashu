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
import { VAULT_ID_RE } from "./primitives.js";
import { researchEvents } from "./research.js";
import { signalsEvents } from "./signals.js";

/**
 * Conflict rule codes (events.md 6.2). LEADER is an emitter constraint, see `emitter`. IDENTITY =
 * an identity claim or merge (events.md 6.4); EPISODE = the signal episode fold (events.md 8.7).
 */
export type Rule =
  | "CREATE"
  | "LWW-F"
  | "SOFT"
  | "TOMB"
  | "APPEND"
  | "FWW"
  | "GUARD"
  | "IDENTITY"
  | "EPISODE";
/** How the event's `gid` is minted (gid.md section 4). */
export type GidStrategy = "VAULT" | "DET" | "ULID" | "DET-or-ULID";
/**
 * Who may emit it (an emit-side constraint; reducers accept every device, events.md 6.2 LEADER):
 * - any: every device;
 * - leader: only the fetch-lease holder;
 * - leader-or-owner: the leader for rule outcomes, any device for owner-caused closes / reopens;
 * - leader-or-research: the leader for rule / plan / alert signals, the device running the research
 *   agent for research signals (`research:` keys);
 * - leader-for-imports: any device for strategy / custom_rule / account_removal proposals, only the
 *   leader for the import-like kinds (`import`, `budget_import`, O3 / O4).
 */
export type Emitter =
  | "any"
  | "leader"
  | "leader-or-owner"
  | "leader-or-research"
  | "leader-for-imports";

export interface EventMeta {
  /** View table the event's `gid` belongs to. */
  table: string;
  rule: Rule;
  gid: GidStrategy;
  emitter: Emitter;
  /**
   * Causal revocation (events.md 6.6): a held event of this type revokes the side effects caused by
   * one event of type `cause` with the same gid, named by eid in the payload field `field`, when it
   * sorts after it (those effects are suppressed); that event itself stays applied.
   * `proposal.applyFailed {approval}` revokes what that `proposal.approved` caused.
   */
  revokes?: Revocation;
}

/** Which caused events a revoker suppresses (events.md 6.6). */
export interface Revocation {
  /** The type of the cause whose effects are revoked. */
  readonly cause: string;
  /** The revoker's payload field holding that cause's eid. */
  readonly field: string;
}

const m = (
  table: string,
  rule: Rule,
  gid: GidStrategy,
  emitter: Emitter = "any",
  revokes?: Revocation,
): EventMeta => ({
  table,
  rule,
  gid,
  emitter,
  ...(revokes === undefined ? {} : { revokes }),
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
  "account.opened": m("accounts", "IDENTITY", "DET-or-ULID"),
  "account.identified": m("accounts", "IDENTITY", "DET-or-ULID"),
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
  "transferRun.started": m("transfer_runs", "APPEND", "ULID"),
  "transferPair.claimed": m("transfer_runs", "APPEND", "ULID"),
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
  "position.snapshotUpdated": m("inv_position_snapshots", "LWW-F", "DET"),
  "instrumentRename.recorded": m("inv_instrument_renames", "CREATE", "DET"),
  "valuation.set": m("inv_manual_valuations", "LWW-F", "DET"),
  "instrument.created": m("inv_instruments", "CREATE", "DET-or-ULID"),
  "instrument.updated": m("inv_instruments", "LWW-F", "DET-or-ULID"),
  "instrument.aliasAdded": m("inv_instrument_aliases", "IDENTITY", "DET"),
  "instrument.merged": m("inv_instruments", "IDENTITY", "DET-or-ULID"),
  "instrumentOverride.set": m("inv_profile_instruments", "LWW-F", "DET"),
  "instrumentOverride.planSet": m("inv_profile_instruments", "LWW-F", "DET"),
  "instrumentOverride.strengthSet": m("inv_profile_instruments", "LWW-F", "DET"),
  "instrumentOverride.segmentSet": m("inv_profile_instruments", "GUARD", "DET"),

  "signal.opened": m("inv_signals", "EPISODE", "ULID", "leader-or-research"),
  "signal.refreshed": m("inv_signals", "EPISODE", "ULID", "leader-or-research"),
  "signal.escalated": m("inv_signals", "EPISODE", "ULID", "leader-or-research"),
  "signal.closed": m("inv_signals", "EPISODE", "ULID", "leader-or-owner"),
  "signal.reopened": m("inv_signals", "EPISODE", "ULID", "leader-or-owner"),
  "signal.snoozed": m("inv_signals", "LWW-F", "ULID"),
  "signal.woken": m("inv_signals", "GUARD", "ULID", "leader"),
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
  "plannedDeposit.booked": m("inv_planned_deposits", "FWW", "ULID", "any"),

  "watchlist.added": m("watchlist_items", "LWW-F", "DET"),
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
  "note.candidateUpdated": m("research_notes", "LWW-F", "ULID"),
  "note.signalLinked": m("research_notes", "LWW-F", "ULID", "leader-or-research"),

  "review.done": m("reviews", "APPEND", "ULID"),
  "review.undone": m("reviews", "TOMB", "ULID"),
  "proposal.created": m("proposals", "CREATE", "ULID"),
  "proposal.approved": m("proposals", "FWW", "ULID", "leader-for-imports"),
  "proposal.rejected": m("proposals", "FWW", "ULID", "leader-for-imports"),
  "proposal.failed": m("proposals", "FWW", "ULID", "leader-for-imports"),
  // The execution result after an approval (S31c): not FWW (the decision is), GUARD on approved.
  "proposal.applyFailed": m("proposals", "GUARD", "ULID", "leader-for-imports", {
    cause: "proposal.approved",
    field: "approval",
  }),
  "connectorBinding.set": m("connector_bindings", "LWW-F", "DET"),
  "connectorBinding.removed": m("connector_bindings", "SOFT", "DET"),
  "connectorBinding.cursorAdvanced": m("connector_bindings", "LWW-F", "DET", "leader"),
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

/** Envelope / payload consistency rules that a payload schema alone cannot see. */
function crossFieldOk(type: EventType, envelope: Envelope, data: unknown): boolean {
  // gid.md 2: the vault id is the gid of the VAULT-strategy (`profile.*`) events and of nothing else
  if (META[type].gid === "VAULT") return envelope.gid === envelope.vault;
  if (VAULT_ID_RE.test(envelope.gid)) return false;
  if (type === "instrument.merged") return (data as { source: string }).source === envelope.gid; // m11
  if (type === "invTxn.imported") {
    // gid.md 4.6 / 7: a manual entry's dedupHash names its own gid (ULID, or a genesis UUIDv8)
    const hash = (data as { dedupHash: string }).dedupHash;
    return !hash.startsWith("manual:") || hash === `manual:${envelope.gid}`;
  }
  return true;
}

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
  if (!crossFieldOk(envelope.type, envelope, data.data)) {
    return { status: "parked", reason: "invalid-payload", envelope };
  }
  return { status: "known", event: { ...envelope, data: data.data } as ParsedEvent };
}
