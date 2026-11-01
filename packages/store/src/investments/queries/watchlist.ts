// Watchlist reads of the write side (Python `service/instrument_search.py:stored_by_yahoo`) and the
// instrument an add would watch, without writing: the caller's answer to an `already_watched`
// refusal (the refusal carries a code only). The list / item reads are in `alerts.ts`.
import { AliasNamespace } from "@cashu/domain/investments";
import { pyUpper } from "@cashu/domain/text";
import { aliasOwner, normalizeAlias } from "./instruments.js";
import { gidOf, instrumentGid, marks, type Read } from "./shared.js";

/**
 * Python `stored_by_yahoo`: the instruments holding a Yahoo alias (guessed or confirmed) among
 * `symbols`, keyed by the upper-case symbol (SQLite `UPPER` on the stored value, as Python's
 * `func.upper`). Values are instrument root gids.
 */
export function storedByYahoo(read: Read, symbols: Iterable<string>): Map<string, string> {
  const wanted = [...new Set([...symbols].filter((s) => s !== "").map(pyUpper))].sort();
  if (wanted.length === 0) return new Map();
  const rows = read<{ value: string; instrument: string }>(
    `SELECT value, ${gidOf("instrument_id")} AS instrument FROM inv_instrument_aliases
     WHERE namespace = ? AND UPPER(value) IN (${marks(wanted.length)}) ORDER BY id`,
    AliasNamespace.YAHOO,
    ...wanted,
  );
  return new Map(rows.map((r) => [pyUpper(r.value), r.instrument]));
}

/** The identity part of a planned instrument (`InstrumentSpec` of `commands/instruments.ts`). */
export interface PlannedIdentity {
  readonly isin?: string | null | undefined;
  readonly aliases: readonly { readonly namespace: string; readonly value: string }[];
}

/**
 * The stored instrument a planned one would turn out to be: the holder of `yahooSymbol` (Python
 * `_insert_once`: another instrument took the listing meanwhile), else the holder of its creation
 * alias (`storeInstrument`: its ISIN, else its first alias). Undefined = it would be created.
 */
export function plannedHolder(
  read: Read,
  planned: PlannedIdentity,
  yahooSymbol?: string,
): string | undefined {
  if (yahooSymbol) {
    const owner = storedByYahoo(read, [yahooSymbol]).get(pyUpper(yahooSymbol));
    if (owner !== undefined) return owner;
  }
  const aliases = planned.aliases
    .map((a) => ({ namespace: a.namespace, value: normalizeAlias(a.namespace, a.value) }))
    .filter((a) => a.value !== "");
  const isin =
    (planned.isin ? planned.isin.trim().toUpperCase() : null) ||
    (aliases.find((a) => a.namespace === AliasNamespace.ISIN)?.value ?? null);
  const creation = isin ? { namespace: AliasNamespace.ISIN, value: isin } : aliases[0];
  if (creation === undefined) return undefined;
  return aliasOwner(read, creation.namespace, creation.value)?.instrument;
}

/** What an add names (`addToWatchlist` input `target`). */
export type WatchTargetRef =
  | { readonly instrument: string }
  | { readonly stored: string }
  | { readonly planned: PlannedIdentity; readonly yahooSymbol?: string | undefined };

/** The stored instrument (root gid) `target` names, undefined when it does not exist (yet). */
export function watchTargetInstrument(read: Read, target: WatchTargetRef): string | undefined {
  if ("planned" in target) return plannedHolder(read, target.planned, target.yahooSymbol);
  return instrumentGid(read, "instrument" in target ? target.instrument : target.stored);
}
