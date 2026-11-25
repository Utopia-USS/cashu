// Investments payloads: account settings, imports, transactions, instruments and profile overrides
// (events.md 8.5, 8.6).
import { z } from "zod";
import { keyedPatch, patchOf, payload } from "./helpers.js";
import {
  assetCurrency,
  blobRef,
  calendarDate,
  decimal,
  gid,
  jsonObject,
  nonEmpty,
  sha256Hex,
  timestamp,
} from "./primitives.js";

export const ACCOUNT_WRAPPERS = ["regular", "ike", "ikze", "oipe", "other"] as const;
export const ASSET_CLASSES = [
  "equity",
  "etf",
  "fund",
  "bond",
  "treasury_bond",
  "cash",
  "crypto",
  "commodity",
  "claim",
  "other",
] as const;
export const TXN_TYPES = [
  "buy",
  "sell",
  "dividend",
  "deposit",
  "withdrawal",
  "fee",
  "tax",
  "interest",
  "fx_conversion",
  "split",
  "transfer_in",
  "transfer_out",
  "adjustment",
] as const;
export const TXN_SOURCES = ["import", "manual", "reconciliation"] as const;
export const VALUATION_MODES = ["market", "cost", "manual"] as const;
export const INSTRUMENT_STATUSES = ["active", "delisted", "frozen"] as const;
/** `domain.plan.PLAN_VALUES` (the model recommendation, legacy name "plan"). */
export const PLAN_VALUES = ["buy_asap", "buy", "hold", "reduce", "exit_asap"] as const;
export const SEGMENT_SETTERS = ["owner", "agent"] as const;
/** `domain.POSITION_STRENGTHS` (the model's assessment of how well the thesis holds). */
export const POSITION_STRENGTHS = ["strong", "neutral", "weak"] as const;
/** `domain.STRENGTH_BASES` (why the strength). */
export const STRENGTH_BASES = [
  "on_track",
  "fulfilled",
  "undermined",
  "environment_against",
  "no_progress",
] as const;
export const MERGE_REASONS = ["owner", "alias_collision"] as const;

const segmentKey = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "expected a segment catalog key");
const aliasNamespace = z.string().regex(/^[a-z0-9_]+$/, "expected an alias namespace");
/**
 * dedupHashV2 (gid.md 4.6): sha256 hex; `manual:<gid>` for manual entries (the event gid: a ULID, or
 * the genesis UUIDv8 of a migrated row, gid.md 7; `parseEvent` checks it equals `manual:` + gid);
 * `legacy:<v1 hash>` only for genesis rows whose columns cannot rebuild v2 (gid.md section 7).
 */
const dedupHashV2 = z.union([
  sha256Hex,
  z
    .string()
    .regex(
      /^manual:([0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/,
    ),
  z.string().regex(/^legacy:[0-9a-f]{64}$/),
]);

const instrumentFields = {
  name: nonEmpty,
  currency: assetCurrency,
  assetClass: z.enum(ASSET_CLASSES),
  symbol: z.string().min(1).nullable(),
  isin: z.string().min(1).nullable(),
  mic: z.string().min(1).nullable(),
  region: z.string().nullable(),
  sector: z.string().nullable(),
  tags: z.array(z.string()),
  needsClassification: z.boolean(),
  valuationMode: z.enum(VALUATION_MODES),
  status: z.enum(INSTRUMENT_STATUSES),
};

/** A broker position snapshot: CREATE (first import) and its LWW update (re-import, S31c). */
const positionSnapshot = {
  account: gid,
  instrument: gid,
  asOf: calendarDate,
  quantity: decimal,
  currency: assetCurrency,
  avgPrice: decimal.nullable(),
  marketValue: decimal.nullable(),
  batch: gid.nullable(),
};

export const investmentsEvents = {
  "invAccount.settingsSet": keyedPatch(
    { account: gid },
    {
      wrapper: z.enum(ACCOUNT_WRAPPERS),
      importer: z.string().min(1).nullable(),
      mappingYaml: z.string().nullable(),
    },
  ),

  "invImport.recorded": payload({
    account: gid,
    importer: nonEmpty,
    broker: nonEmpty,
    fileName: nonEmpty,
    fileSha256: sha256Hex,
    archive: blobRef.optional(),
    txnCount: z.int().min(0),
    duplicateCount: z.int().min(0),
    positionCount: z.int().min(0),
    renameCount: z.int().min(0),
    statusChangeCount: z.int().min(0),
    instrumentCount: z.int().min(0),
    correctionCount: z.int().min(0),
    warnings: z.array(jsonObject),
  }),

  "invTxn.imported": payload({
    account: gid,
    batch: gid.nullable(),
    type: z.enum(TXN_TYPES),
    tradeDate: calendarDate,
    settleDate: calendarDate.nullable(),
    instrument: gid.nullable(),
    quantity: decimal.nullable(),
    price: decimal.nullable(),
    currency: assetCurrency,
    grossAmount: decimal,
    fee: decimal,
    tax: decimal,
    cashAmount: decimal,
    cashCurrency: assetCurrency,
    fxRate: decimal.nullable(),
    splitRatio: decimal.nullable(),
    note: z.string().nullable(),
    source: z.enum(TXN_SOURCES),
    externalRef: z.string().nullable(),
    dedupHash: dedupHashV2,
    /** Required: the chronological rank of same-day rows (domain.chronological_key). */
    createdAt: timestamp,
  }).refine((v) => (v.source === "manual") === v.dedupHash.startsWith("manual:"), {
    message: "manual entries (and only they) use dedupHash manual:<gid>",
  }),

  "position.snapshotImported": payload(positionSnapshot),
  /**
   * A re-import with changed figures for a held (account, instrument, asOf) (S31c): the whole
   * snapshot again, LWW on the row key (Python's upsert keeps the newest import's figures, batch and
   * time).
   */
  "position.snapshotUpdated": payload(positionSnapshot),

  "instrumentRename.recorded": payload({
    date: calendarDate,
    old: gid,
    new: gid,
    note: z.string().nullable(),
    batch: gid.nullable(),
  }),

  "valuation.set": payload({
    instrument: gid,
    asOf: calendarDate,
    unitValue: decimal,
    currency: assetCurrency,
    note: z.string().nullable(),
  }),

  "instrument.created": payload({
    ...instrumentFields,
    /** `namespace:value` the DET gid was derived from (gid.md 4.6); null for a ULID instrument. */
    creationAlias: z
      .string()
      .regex(/^[a-z0-9_]+:.+$/)
      .nullable(),
  }),
  "instrument.updated": patchOf(instrumentFields),
  "instrument.aliasAdded": payload({
    instrument: gid,
    namespace: aliasNamespace,
    value: nonEmpty,
    guessed: z.boolean(),
  }),
  "instrument.merged": payload({
    source: gid,
    target: gid,
    reason: z.enum(MERGE_REASONS),
  }).refine((v) => v.source !== v.target, { message: "source and target must differ" }),

  // null = back to the shared default; "" clears a text attribute for this profile.
  "instrumentOverride.set": keyedPatch(
    { instrument: gid },
    {
      name: z.string().nullable(),
      assetClass: z.enum(ASSET_CLASSES).nullable(),
      tags: z.array(z.string()).nullable(),
      region: z.string().nullable(),
      sector: z.string().nullable(),
      valuationMode: z.enum(VALUATION_MODES).nullable(),
      status: z.enum(INSTRUMENT_STATUSES).nullable(),
      needsClassification: z.boolean().nullable(),
    },
  ),
  "instrumentOverride.planSet": payload({
    instrument: gid,
    plan: z.enum(PLAN_VALUES).nullable(),
    reason: z.string().nullable(),
  }),
  // strength null clears strength, basis, reason and strength_at together
  "instrumentOverride.strengthSet": payload({
    instrument: gid,
    strength: z.enum(POSITION_STRENGTHS).nullable(),
    basis: z.enum(STRENGTH_BASES).nullable(),
    reason: z.string().nullable(),
  }),
  "instrumentOverride.segmentSet": payload({
    instrument: gid,
    segment: segmentKey.nullable(),
    by: z.enum(SEGMENT_SETTERS),
  }),
} as const;
