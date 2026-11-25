// Instrument reads (Python `store/instruments.py`): domain instruments with their aliases, the vault's
// overrides overlaid, the import lookup (`DbInstrumentLookup`), `find_confirmed` and the instruments
// the vault references. A vault is one profile, so "as the profile sees it" is the instrument with
// this vault's `inv_profile_instruments` row applied; `shared: true` gives the market defaults.
import { toCurrency } from "@cashu/domain";
import {
  AliasNamespace,
  asInstrumentId,
  type Instrument,
  type InstrumentAlias,
  instrument,
  instrumentAlias,
  parseAssetClass,
  parseInstrumentStatus,
  parseValuationMode,
} from "@cashu/domain/investments";
import { gidOf, instrumentRoot, jsonStrings, marks, type Read, storedTime } from "./shared.js";

/** Python `_normalize`: trimmed; an ISIN upper-cased. */
export function normalizeAlias(namespace: string, value: string): string {
  const v = value.trim();
  return namespace === AliasNamespace.ISIN ? v.toUpperCase() : v;
}

interface InstrumentRow {
  id: number;
  gid: string;
  name: string;
  currency: string;
  asset_class: string;
  symbol: string | null;
  isin: string | null;
  mic: string | null;
  region: string | null;
  sector: string | null;
  tags: string;
  needs_classification: number;
  valuation_mode: string;
  status: string;
}

/** This vault's override row of an instrument (`inv_profile_instruments`), decoded. */
export interface InstrumentOverride {
  readonly instrument: string;
  readonly name: string | null;
  readonly assetClass: string | null;
  readonly tags: readonly string[] | null;
  readonly region: string | null;
  readonly sector: string | null;
  readonly valuationMode: string | null;
  readonly status: string | null;
  readonly needsClassification: boolean | null;
  readonly plan: string | null;
  readonly planAt: string | null;
  readonly planReason: string | null;
  readonly positionStrength: string | null;
  readonly strengthBasis: string | null;
  readonly strengthReason: string | null;
  readonly strengthAt: string | null;
  readonly segment: string | null;
  readonly segmentBy: string | null;
}

const INSTRUMENT_COLUMNS =
  "id, gid, name, currency, asset_class, symbol, isin, mic, region, sector, tags, needs_classification, valuation_mode, status";

function aliasesOf(read: Read, ids: readonly number[]): Map<number, InstrumentAlias[]> {
  const out = new Map<number, InstrumentAlias[]>();
  if (ids.length === 0) return out;
  // Python `convert.instrument` sorts by (namespace, guessed, id).
  const rows = read<{ instrument_id: number; namespace: string; value: string; guessed: number }>(
    `SELECT instrument_id, namespace, value, guessed FROM inv_instrument_aliases
     WHERE instrument_id IN (${marks(ids.length)}) ORDER BY namespace, guessed, id`,
    ...ids,
  );
  for (const r of rows) {
    const list = out.get(r.instrument_id) ?? [];
    list.push(instrumentAlias(r.namespace, r.value, r.guessed === 1));
    out.set(r.instrument_id, list);
  }
  return out;
}

function toInstrument(row: InstrumentRow, aliases: readonly InstrumentAlias[]): Instrument {
  return instrument({
    id: asInstrumentId(row.gid),
    name: row.name,
    currency: toCurrency(row.currency),
    assetClass: parseAssetClass(row.asset_class),
    symbol: row.symbol,
    isin: row.isin,
    mic: row.mic,
    region: row.region,
    sector: row.sector,
    tags: jsonStrings(row.tags) ?? [],
    needsClassification: row.needs_classification === 1,
    aliases,
    valuationMode: parseValuationMode(row.valuation_mode),
    status: parseInstrumentStatus(row.status),
  });
}

/**
 * Python `apply_override`: the vault's overrides (null = keep, "" = clear a text attribute) and the
 * model recommendation (legacy name `plan`), the position strength and segment.
 */
export function applyOverride(base: Instrument, o: InstrumentOverride): Instrument {
  return instrument({
    ...base,
    name: o.name ? o.name : base.name,
    assetClass: o.assetClass ? parseAssetClass(o.assetClass) : base.assetClass,
    tags: o.tags ?? base.tags,
    region: o.region === null ? base.region : o.region || null,
    sector: o.sector === null ? base.sector : o.sector || null,
    valuationMode: o.valuationMode ? parseValuationMode(o.valuationMode) : base.valuationMode,
    status: o.status ? parseInstrumentStatus(o.status) : base.status,
    needsClassification: o.needsClassification ?? base.needsClassification,
    ...(o.plan === null
      ? {}
      : {
          plan: o.plan,
          planAt: o.planAt === null ? null : storedTime(o.planAt),
          planReason: o.planReason,
        }),
    ...(o.positionStrength === null
      ? {}
      : {
          positionStrength: o.positionStrength,
          strengthBasis: o.strengthBasis,
          strengthReason: o.strengthReason,
          strengthAt: o.strengthAt === null ? null : storedTime(o.strengthAt),
        }),
    ...(o.segment === null ? {} : { segment: o.segment, segmentBy: o.segmentBy }),
  });
}

interface OverrideRow {
  instrument: string;
  name: string | null;
  asset_class: string | null;
  tags: string | null;
  region: string | null;
  sector: string | null;
  valuation_mode: string | null;
  status: string | null;
  needs_classification: number | null;
  plan: string | null;
  plan_at: string | null;
  plan_reason: string | null;
  strength: string | null;
  strength_basis: string | null;
  strength_reason: string | null;
  strength_at: string | null;
  segment: string | null;
  segment_by: string | null;
}

const toOverride = (r: OverrideRow): InstrumentOverride => ({
  instrument: r.instrument,
  name: r.name,
  assetClass: r.asset_class,
  tags: jsonStrings(r.tags),
  region: r.region,
  sector: r.sector,
  valuationMode: r.valuation_mode,
  status: r.status,
  needsClassification: r.needs_classification === null ? null : r.needs_classification === 1,
  plan: r.plan,
  planAt: r.plan_at,
  planReason: r.plan_reason,
  positionStrength: r.strength,
  strengthBasis: r.strength_basis,
  strengthReason: r.strength_reason,
  strengthAt: r.strength_at,
  segment: r.segment,
  segmentBy: r.segment_by,
});

/** The vault's override rows by instrument (root) gid; `gids` limits them (members resolve). */
export function overrides(read: Read, gids?: Iterable<string>): Map<string, InstrumentOverride> {
  const wanted =
    gids === undefined ? undefined : [...new Set([...gids].map((g) => instrumentRoot(read, g)))];
  if (wanted !== undefined && wanted.length === 0) return new Map();
  const rows = read<OverrideRow>(
    `SELECT i.gid AS instrument, o.name, o.asset_class, o.tags, o.region, o.sector, o.valuation_mode,
       o.status, o.needs_classification, o.plan, o.plan_at, o.plan_reason, o.strength, o.strength_basis,
       o.strength_reason, o.strength_at, o.segment, o.segment_by
     FROM inv_profile_instruments o JOIN inv_instruments i ON i.id = o.instrument_id
     ${wanted === undefined ? "" : `WHERE i.gid IN (${marks(wanted.length)})`}`,
    ...(wanted ?? []),
  );
  return new Map(rows.map((r) => [r.instrument, toOverride(r)]));
}

/**
 * Domain instruments (with aliases) by the gid asked for (a member gid finds its merged root's row);
 * with the vault's overrides applied unless `shared` (market identity code paths).
 */
export function loadInstruments(
  read: Read,
  gids: Iterable<string>,
  options: { shared?: boolean } = {},
): Map<string, Instrument> {
  const asked = [...new Set(gids)];
  const rootOf = new Map(asked.map((g) => [g, instrumentRoot(read, g)]));
  const roots = [...new Set(rootOf.values())];
  if (roots.length === 0) return new Map();
  const rows = read<InstrumentRow>(
    `SELECT ${INSTRUMENT_COLUMNS} FROM inv_instruments WHERE gid IN (${marks(roots.length)})`,
    ...roots,
  );
  const aliases = aliasesOf(
    read,
    rows.map((r) => r.id),
  );
  const found = new Map(rows.map((r) => [r.gid, toInstrument(r, aliases.get(r.id) ?? [])]));
  if (!options.shared) {
    for (const [root, o] of overrides(read, roots)) {
      const base = found.get(root);
      if (base !== undefined) found.set(root, applyOverride(base, o));
    }
  }
  const out = new Map<string, Instrument>();
  for (const [g, root] of rootOf) {
    const i = found.get(root);
    if (i !== undefined) out.set(g, i);
  }
  return out;
}

export function loadInstrument(
  read: Read,
  gid: string,
  options: { shared?: boolean } = {},
): Instrument | undefined {
  return loadInstruments(read, [gid], options).get(gid);
}

/** Every instrument of the vault (as the vault sees it), in fold order. */
export function allInstruments(read: Read, options: { shared?: boolean } = {}): Instrument[] {
  const gids = read<{ gid: string }>("SELECT gid FROM inv_instruments ORDER BY id").map(
    (r) => r.gid,
  );
  const found = loadInstruments(read, gids, options);
  return gids.flatMap((g) => found.get(g) ?? []);
}

// ------------------------------------------------------------------ import lookup

export interface LookupOptions {
  /** Only confirmed (never guessed) aliases count (`find_confirmed`). */
  readonly confirmedOnly?: boolean;
}

/** Python `DbInstrumentLookup.by_isin`: the display ISIN (case-insensitive), else an ISIN alias. */
export function instrumentByIsin(
  read: Read,
  isin: string,
  options: LookupOptions = {},
): Instrument | undefined {
  const wanted = isin.trim().toUpperCase();
  const row = read<{ gid: string }>(
    "SELECT gid FROM inv_instruments WHERE UPPER(isin) = ? ORDER BY id LIMIT 1",
    wanted,
  )[0];
  if (row !== undefined) return loadInstrument(read, row.gid, { shared: true });
  return aliasHolder(read, AliasNamespace.ISIN, wanted, options);
}

/** Python `DbInstrumentLookup.by_alias` (an ISIN goes through `instrumentByIsin`). */
export function instrumentByAlias(
  read: Read,
  namespace: string,
  value: string,
  options: LookupOptions = {},
): Instrument | undefined {
  if (namespace === AliasNamespace.ISIN) return instrumentByIsin(read, value, options);
  return aliasHolder(read, namespace, normalizeAlias(namespace, value), options);
}

function aliasHolder(
  read: Read,
  namespace: string,
  value: string,
  options: LookupOptions,
): Instrument | undefined {
  const row = read<{ gid: string }>(
    `SELECT i.gid FROM inv_instrument_aliases a JOIN inv_instruments i ON i.id = a.instrument_id
     WHERE a.namespace = ? AND a.value = ? ${options.confirmedOnly ? "AND a.guessed = 0" : ""}`,
    namespace,
    value,
  )[0];
  return row === undefined ? undefined : loadInstrument(read, row.gid, { shared: true });
}

/** Python `DbInstrumentLookup.by_symbol`: same symbol (case-insensitive) on the MIC, oldest first. */
export function instrumentsBySymbol(read: Read, symbol: string, mic: string): Instrument[] {
  const gids = read<{ gid: string }>(
    "SELECT gid FROM inv_instruments WHERE UPPER(symbol) = ? AND mic = ? ORDER BY id",
    symbol.trim().toUpperCase(),
    mic,
  ).map((r) => r.gid);
  const found = loadInstruments(read, gids, { shared: true });
  return gids.flatMap((g) => found.get(g) ?? []);
}

/** The alias row holding `namespace:value` (normalized): its instrument root gid and guess flag. */
export function aliasOwner(
  read: Read,
  namespace: string,
  value: string,
): { readonly instrument: string; readonly guessed: boolean } | undefined {
  const r = read<{ instrument: string; guessed: number }>(
    `SELECT ${gidOf("instrument_id")} AS instrument, guessed
     FROM inv_instrument_aliases WHERE namespace = ? AND value = ?`,
    namespace,
    normalizeAlias(namespace, value),
  )[0];
  return r === undefined ? undefined : { instrument: r.instrument, guessed: r.guessed === 1 };
}

// ------------------------------------------------------------------ the vault's instruments

/** Instrument references of the vault (`profile_instrument_ids`), as union members over view ids. */
const REFERENCES = `
  SELECT instrument_id AS id FROM inv_transactions WHERE instrument_id IS NOT NULL
  UNION SELECT instrument_id FROM inv_position_snapshots
  UNION SELECT old_instrument_id FROM inv_instrument_renames
  UNION SELECT new_instrument_id FROM inv_instrument_renames
  UNION SELECT instrument_id FROM inv_manual_valuations
  UNION SELECT instrument_id FROM inv_theses
  UNION SELECT instrument_id FROM watchlist_items
  UNION SELECT instrument_id FROM inv_profile_instruments
  UNION SELECT instrument_id FROM inv_signals WHERE instrument_id IS NOT NULL
  UNION SELECT instrument_id FROM inv_decisions WHERE instrument_id IS NOT NULL
  UNION SELECT instrument_id FROM alerts WHERE instrument_id IS NOT NULL AND deleted_at IS NULL
  UNION SELECT instrument_id FROM research_notes WHERE instrument_id IS NOT NULL`;

/**
 * Python `profile_instrument_ids`: every instrument the vault references (transactions, broker
 * snapshots, renames, manual valuations, theses, watchlist rows incl. removed ones, overrides,
 * signals, decisions, live alerts, research notes incl. dismissed ones), as view gids. An unwatched
 * instrument stays here, so its asset page and research stay reachable (F12).
 */
export function vaultInstrumentGids(read: Read): Set<string> {
  return new Set(
    read<{ gid: string }>(
      `SELECT gid FROM inv_instruments WHERE id IN (${REFERENCES}) ORDER BY id`,
    ).map((r) => r.gid),
  );
}
