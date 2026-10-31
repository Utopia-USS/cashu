/**
 * The broker instrument key of a v2 dedup hash (gid.md 4.6 `instrumentKey`, 7.2): the ONE rule both
 * sides use, so a TS re-import of a broker file dedups against the rows genesis migrated.
 *
 * Python's v1 hash keys a row by the RESOLVED instrument (its local id; the resolver finds the same
 * instrument through its aliases in any equivalent namespace), never by the row's own hints. v2 keeps
 * that: the key is derived from the instrument the row resolves to, after the import's aliases are
 * added, exactly as genesis derives it from the stored instrument of the stored row. A key built from
 * the row's hints instead (the symbol when present, else the ISIN) differs from genesis for an
 * ISIN-only row of an instrument with a broker alias, for a batch stored under the legacy broker name,
 * and for an instrument with two aliases in the broker's namespace, and the re-import then inserts the
 * row a second time (S26 review F2).
 *
 * In this order:
 * 1. a cash row: `""` (the caller passes no instrument);
 * 2. the instrument's alias in the broker's namespace or an equivalent one (`cashu` and its legacy
 *    name `finanse` are one), ranked: legacy namespace first (every `finanse` alias predates every
 *    `cashu` one: the rename stopped creating them), confirmed before guessed, then oldest first ->
 *    `<canonical namespace>:<value>` (the legacy name never reaches the key);
 * 3. the `isin` alias (confirmed before guessed, oldest first) -> `isin:<value>`;
 * 4. the instrument's ISIN column -> `isin:<ISIN>`;
 * 5. `gid:<instrument gid>`.
 * A row without a batch (no broker) starts at step 3. Reconciliation rows always use step 5
 * (`reconciliationInstrumentKey`).
 *
 * The key a row is stored under is `instrumentKeyV2` (byte-compatible with genesis). Which key an older
 * row was stored under depends on the instrument's aliases at that time, so the duplicate check of a
 * re-import also tries `candidateInstrumentKeys`: every key the instrument has had or has now (lead
 * decision S17d: a re-import never duplicates, whatever the alias history).
 *
 * The alias list must be oldest first within each (namespace, guessed) group: the domain
 * `Instrument.aliases` order (Python `convert.instrument`: namespace, guessed, id) and the stored alias
 * rows by ascending id both qualify, and give the same key.
 */

import { AliasNamespace, type InstrumentAlias } from "../domain/index.js";
import { equivalentNamespaces, LEGACY_NAMESPACE, namespaceOf } from "./contract.js";

/** What the key reads of an instrument. */
export interface InstrumentKeySubject {
  /** Oldest first within each (namespace, guessed) group (see the module comment). */
  readonly aliases: readonly InstrumentAlias[];
  /** The ISIN column (display ISIN). */
  readonly isin: string | null;
}

/** legacy name: an alias stored under the pre-rename namespace ranks first (it is the older one). */
function rankOf(alias: InstrumentAlias): number {
  return (alias.namespace === LEGACY_NAMESPACE ? 0 : 2) + (alias.guessed ? 1 : 0);
}

/** The first alias of `namespaces` by (legacy namespace first, confirmed first, oldest first). */
function firstAlias(
  aliases: readonly InstrumentAlias[],
  namespaces: readonly string[],
): InstrumentAlias | null {
  let best: InstrumentAlias | null = null;
  for (const alias of aliases) {
    if (!namespaces.includes(alias.namespace)) continue;
    if (best === null || rankOf(alias) < rankOf(best)) best = alias;
  }
  return best;
}

/**
 * The v2 instrument key of a non-reconciliation row of `brokerId`'s batch (null: no batch) whose
 * instrument is `subject`; `gid` is asked only when no alias or ISIN names it.
 */
export function instrumentKeyV2(
  subject: InstrumentKeySubject,
  brokerId: string | null,
  gid: () => string,
): string {
  if (brokerId !== null) {
    const broker = firstAlias(subject.aliases, equivalentNamespaces(brokerId));
    if (broker !== null) return `${namespaceOf(brokerId)}:${broker.value}`;
  }
  const isinAlias = firstAlias(subject.aliases, [AliasNamespace.ISIN]);
  if (isinAlias !== null) return `isin:${isinAlias.value}`;
  if (subject.isin) return `isin:${subject.isin}`;
  return reconciliationInstrumentKey(gid());
}

/** The v2 instrument key of a reconciliation row: always the instrument's gid. */
export function reconciliationInstrumentKey(instrumentGid: string): string {
  return `gid:${instrumentGid}`;
}

/** What `candidateInstrumentKeys` reads besides the instrument's aliases and ISIN. */
export interface CandidateKeyInput {
  readonly subject: InstrumentKeySubject & {
    /** The display ticker (not unique: kept only when no other instrument owns it). */
    readonly symbol: string | null;
  };
  /** The import's broker id (alias namespace). */
  readonly brokerId: string;
  readonly gid: string;
  /** The row's broker symbol as the resolver reads it (the symbol, else the name), stripped. */
  readonly rowSymbol: string | null;
  /** The row's ISIN, stripped and upper-cased. */
  readonly rowIsin: string | null;
  /**
   * Whether alias (`namespace`, `value`) belongs to no OTHER instrument (any equivalent namespace;
   * for `isin` also the ISIN column). Keys not taken from the instrument's own aliases are kept only
   * then, so a candidate never names another instrument's rows.
   */
  readonly free: (namespace: string, value: string) => boolean;
}

/**
 * Every instrument key a row of this instrument may have been stored under, `instrumentKeyV2` first,
 * without repeats: each own alias in the broker's equivalent namespaces under the canonical name and
 * under the name it is stored with (legacy name: `finanse:` keys of the pre-S17d genesis rule), each
 * `isin` alias, the ISIN column, the display ticker and the row's own symbol and ISIN (the gid.md 4.6
 * hint rule) when no other instrument owns them, and the gid.
 */
export function candidateInstrumentKeys(input: CandidateKeyInput): readonly string[] {
  const { subject, brokerId } = input;
  const canonical = namespaceOf(brokerId);
  const keys = new Set<string>([instrumentKeyV2(subject, brokerId, () => input.gid)]);
  const namespaces = equivalentNamespaces(brokerId);
  for (const alias of subject.aliases) {
    if (namespaces.includes(alias.namespace)) {
      keys.add(`${canonical}:${alias.value}`);
      keys.add(`${alias.namespace}:${alias.value}`);
    } else if (alias.namespace === AliasNamespace.ISIN) {
      keys.add(`isin:${alias.value}`);
    }
  }
  if (subject.isin) keys.add(`isin:${subject.isin}`);
  for (const symbol of [subject.symbol, input.rowSymbol]) {
    if (symbol && input.free(brokerId, symbol)) keys.add(`${canonical}:${symbol}`);
  }
  if (input.rowIsin && input.free(AliasNamespace.ISIN, input.rowIsin)) {
    keys.add(`isin:${input.rowIsin}`);
  }
  keys.add(reconciliationInstrumentKey(input.gid));
  return Object.freeze([...keys]);
}
