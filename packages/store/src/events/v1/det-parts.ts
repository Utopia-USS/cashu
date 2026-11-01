// Payload-derived deterministic gids (gid.md 4, events.md 7.10): the DET domain and parts an event's
// gid must be built from. Parts are read from the (upcast) payload as written, references unresolved.
// One table for the store's gid check and the reference fold; genesis (S26) and the Python outbox
// (S30) MUST build these gids from exactly these parts.
import type { EventType } from "./catalog.js";
import type { GidTable } from "./namespaces.js";

export interface DetParts {
  readonly table: GidTable;
  readonly parts: readonly string[];
}

const s = (v: unknown): string => String(v);
const det = (table: GidTable, ...parts: string[]): DetParts => ({ table, parts });

/** `undefined` = the type's gid is not derived from its payload (not checked). */
export function detPartsOf(
  type: string,
  data: Readonly<Record<string, unknown>>,
): DetParts | undefined {
  switch (type) {
    case "module.enabled":
    case "module.disabled":
      return det("profile_modules", s(data.moduleId));
    case "balance.recorded":
      return det("balances", s(data.account), s(data.date), s(data.source));
    case "budgetSettings.cushionSet":
      return det("budget_settings", "cushion");
    case "txn.imported":
      return det("transactions", s(data.account), s(data.dedupHash), s(data.occurrence));
    case "categoryRule.set":
      return det("category_rules", s(data.merchantKey));
    case "loan.termsSet":
    case "loan.paymentMatchingSet":
      return det("loans", s(data.account));
    case "depreciation.set":
      return det("depreciations", s(data.account));
    case "assetDetails.noteSet":
      return det("asset_details", s(data.account));
    case "invAccount.settingsSet":
      return det("inv_account_settings", s(data.account));
    case "invTxn.imported":
      // A manual entry's gid is a ULID (or a genesis gid), its dedupHash `manual:<gid>` (gid.md 4.6, 7).
      if (s(data.dedupHash).startsWith("manual:")) return undefined;
      return det("inv_transactions", s(data.account), s(data.dedupHash));
    case "position.snapshotImported":
    case "position.snapshotUpdated":
      return det("inv_position_snapshots", s(data.account), s(data.instrument), s(data.asOf));
    case "instrumentRename.recorded":
      return det("inv_instrument_renames", s(data.date), s(data.old), s(data.new));
    case "valuation.set":
      return det("inv_manual_valuations", s(data.instrument), s(data.asOf));
    case "instrument.created":
      // Without a creation alias the gid is a ULID or a genesis gid (gid.md 4.6, 7).
      if (data.creationAlias === null || data.creationAlias === undefined) return undefined;
      return det("inv_instruments", s(data.creationAlias));
    case "instrument.aliasAdded":
      return det("inv_instrument_aliases", s(data.namespace), s(data.value));
    case "instrumentOverride.set":
    case "instrumentOverride.planSet":
    case "instrumentOverride.segmentSet":
      return det("inv_profile_instruments", s(data.instrument));
    case "watchlist.added":
      return det("watchlist_items", s(data.instrument));
    case "topicThesis.ownerSaved":
    case "topicThesis.draftProposed":
    case "topicThesis.marketViewSet":
      return det("inv_topic_theses", s(data.segment));
    case "connectorBinding.set":
      return det("connector_bindings", s(data.account), s(data.connectorId));
    default:
      return undefined;
  }
}

/**
 * Catalog types with a DET gid whose payload does not carry the parts: they address an existing row
 * by its gid (events.md 6.4 N1) and are not checked. `detPartsOf` returns parts for every other DET
 * type (det-parts.test.ts forces the split to be complete).
 */
export const NOT_PAYLOAD_DERIVED: ReadonlySet<EventType> = new Set<EventType>([
  "watchlist.updated",
  "watchlist.removed",
  "topicThesis.rejected",
  "connectorBinding.removed",
  "connectorBinding.cursorAdvanced",
]);
