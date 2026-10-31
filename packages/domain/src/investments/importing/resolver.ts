/**
 * Instrument resolution for one import (one broker), without writing anything (port of
 * `importing/resolver.py`).
 *
 * Order: ISIN -> broker alias (namespace = broker id; the symbol as exported, or the name when the row
 * has no symbol) -> symbol + market (instrument symbol and MIC, then guessed stooq / Yahoo aliases) ->
 * plan a new instrument with `needsClassification: true`, a guessed asset class (`ETF` / `UCITS` in
 * the name -> etf, a well-known crypto symbol -> crypto, a known market -> equity, else other) and
 * guessed stooq / Yahoo aliases flagged `guessed`.
 *
 * R10: a planned instrument's currency comes from the strongest `CurrencyEvidence` among the rows
 * naming it (a priced trade row beats a position line or unpriced trade, which beat a dividend / tax /
 * fee row booked in the account currency), whatever their order in the file; trade rows that disagree
 * are noted. Planned instruments and aliases are visible to later rows of the same import, so one new
 * instrument is planned once. Matching an existing instrument also plans the aliases it lacks (its
 * ISIN, the broker symbol) when no other instrument owns them.
 *
 * The store implements `InstrumentLookup` (read-only) and writes `newInstruments` and `newAliases` on
 * commit.
 */

import { ZERO } from "../../decimal.js";
import { pyStrip, pyUpper } from "../../text.js";
import {
  AliasNamespace,
  AssetClass,
  aliasOf,
  type Currency,
  type Instrument,
  type InstrumentAlias,
  type InstrumentId,
  InvariantError,
  instrument,
  instrumentAlias,
  TxnType,
  toCurrency,
} from "../domain/index.js";
import { equivalentNamespaces, type ParsedPosition, type ParsedTxn } from "./contract.js";
import {
  CRYPTO,
  cryptoBase,
  type ExchangeInfo,
  exchangeForHint,
  splitBrokerSymbol,
  stooqSymbol,
  yahooSymbol,
} from "./exchanges.js";

/** Read-only access to the stored instruments (implemented by the store). */
export interface InstrumentLookup {
  /** The instrument whose ISIN (display field or `isin` alias) is `isin` (upper-case). */
  byIsin(isin: string): Instrument | null;
  /** The instrument owning alias (`namespace`, `value`), guessed or confirmed. */
  byAlias(namespace: string, value: string): Instrument | null;
  /** Instruments with `symbol` (case-insensitive) listed on `mic`, oldest first. */
  bySymbol(symbol: string, mic: string): readonly Instrument[];
}

/** `InstrumentLookup` over a list of instruments (tests, previews over loaded data). */
export class InMemoryInstrumentLookup implements InstrumentLookup {
  private readonly instruments: Instrument[];

  constructor(instruments: Iterable<Instrument> = []) {
    this.instruments = [...instruments];
  }

  add(item: Instrument): void {
    this.instruments.push(item);
  }

  byIsin(isin: string): Instrument | null {
    const wanted = pyUpper(pyStrip(isin));
    for (const item of this.instruments) {
      if (pyUpper(item.isin ?? "") === wanted) return item;
      for (const alias of item.aliases) {
        if (alias.namespace === AliasNamespace.ISIN && pyUpper(alias.value) === wanted) return item;
      }
    }
    return null;
  }

  byAlias(namespace: string, value: string): Instrument | null {
    if (namespace === AliasNamespace.ISIN) return this.byIsin(value);
    for (const item of this.instruments) {
      for (const alias of item.aliases) {
        if (alias.namespace === namespace && alias.value === value) return item;
      }
    }
    return null;
  }

  bySymbol(symbol: string, mic: string): readonly Instrument[] {
    const upper = pyUpper(symbol);
    return this.instruments.filter(
      (item) => pyUpper(item.symbol ?? "") === upper && item.mic === mic,
    );
  }
}

/** How an import row was matched to an instrument, in resolution order. */
export const InstrumentMatch = Object.freeze({
  ISIN: "isin",
  BROKER_ALIAS: "broker_alias",
  SYMBOL_EXCHANGE: "symbol_exchange",
  /** Not found: a new instrument with `needsClassification: true` is planned. */
  CREATED: "created",
} as const);
export type InstrumentMatch = (typeof InstrumentMatch)[keyof typeof InstrumentMatch];

/** How much a row's currency says about the instrument's trading currency (weakest first). */
export const CurrencyEvidence = Object.freeze({
  /** Dividend, withholding tax, fee, interest...: often booked in the account currency. */
  CASH_FLOW: 0,
  /** A position line, a trade row without a price, or a split. */
  WEAK: 1,
  /** A trade row with a price (buy, sell, transfer, adjustment): quoted in the trading currency. */
  TRADE: 2,
} as const);
export type CurrencyEvidence = (typeof CurrencyEvidence)[keyof typeof CurrencyEvidence];

export const TRADE_TYPES: ReadonlySet<TxnType> = new Set([
  TxnType.BUY,
  TxnType.SELL,
  TxnType.TRANSFER_IN,
  TxnType.TRANSFER_OUT,
  TxnType.ADJUSTMENT,
]);

/** The `CurrencyEvidence` of a transaction row's currency. */
export function evidenceOf(txn: ParsedTxn): CurrencyEvidence {
  if (TRADE_TYPES.has(txn.type)) {
    return txn.price?.gt(ZERO) ? CurrencyEvidence.TRADE : CurrencyEvidence.WEAK;
  }
  return txn.type === TxnType.SPLIT ? CurrencyEvidence.WEAK : CurrencyEvidence.CASH_FLOW;
}

/** What an import row says about its instrument (resolutions are cached per hint value). */
export interface InstrumentHint {
  /** Trading currency used when a new instrument is planned (weighed by `evidence`). */
  readonly currency: Currency;
  /** Symbol as written in the export (may carry a market suffix such as `PKN.PL`). */
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly name: string | null;
  readonly exchangeHint: string | null;
  readonly evidence: CurrencyEvidence;
}

export type InstrumentHintInit = Pick<InstrumentHint, "currency"> & Partial<InstrumentHint>;

/** `InstrumentHint(...)` with Python's defaults. */
export function instrumentHint(init: InstrumentHintInit): InstrumentHint {
  return Object.freeze({
    currency: init.currency,
    symbol: init.symbol ?? null,
    isin: init.isin ?? null,
    name: init.name ?? null,
    exchangeHint: init.exchangeHint ?? null,
    evidence: init.evidence ?? CurrencyEvidence.WEAK,
  });
}

/** `InstrumentHint.from_txn`. */
export function hintFromTxn(txn: ParsedTxn): InstrumentHint {
  return instrumentHint({
    currency: txn.currency,
    symbol: txn.symbol,
    isin: txn.isin,
    name: txn.name,
    exchangeHint: txn.exchangeHint,
    evidence: evidenceOf(txn),
  });
}

/** `InstrumentHint.from_position`. */
export function hintFromPosition(position: ParsedPosition): InstrumentHint {
  return instrumentHint({
    currency: position.currency,
    symbol: position.symbol,
    isin: position.isin,
    name: position.name,
    exchangeHint: position.exchangeHint,
  });
}

/** True when the hint names no instrument at all (cash rows). */
export function hintIsEmpty(hint: InstrumentHint): boolean {
  return clean(hint.symbol) === null && clean(hint.isin) === null && clean(hint.name) === null;
}

/**
 * Result of `InstrumentResolver.resolve`. Look the instrument itself up with
 * `InstrumentResolver.instrument` (a planned one can still gain an ISIN, aliases or a better currency
 * from later rows).
 */
export interface ResolvedInstrument {
  readonly instrumentId: InstrumentId;
  readonly match: InstrumentMatch;
  /** Conflicts and ambiguities worth showing in the preview (English, one sentence each). */
  readonly notes: readonly string[];
}

function resolved(
  instrumentId: InstrumentId,
  match: InstrumentMatch,
  notes: readonly string[] = [],
): ResolvedInstrument {
  return Object.freeze({ instrumentId, match, notes: Object.freeze([...notes]) });
}

/** `ResolvedInstrument.is_new`. */
export function isNewInstrument(result: ResolvedInstrument): boolean {
  return result.match === InstrumentMatch.CREATED;
}

/**
 * Python `re.compile(r"\b(ETF|UCITS)\b", re.IGNORECASE)` on str: word boundaries over Unicode word
 * characters (letters, numbers, `_`). Case-insensitive matching follows Unicode simple case folding
 * (Python also lets dotless `ı` match `I`; no instrument name relies on that).
 */
const ETF_NAME = /(?<![\p{L}\p{N}_])(?:ETF|UCITS)(?![\p{L}\p{N}_])/iu;

/**
 * Asset class guess for a planned instrument: ETF / UCITS in the name -> etf, crypto (pseudo-market or
 * a well-known crypto symbol without a real market) -> crypto, a known market -> equity, else other.
 */
export function guessAssetClass(
  name: string | null,
  symbol: string | null,
  exchange: ExchangeInfo | null,
): AssetClass {
  if (name && ETF_NAME.test(name)) return AssetClass.ETF;
  if (exchange?.crypto || (exchange === null && cryptoBase(symbol) !== null)) {
    return AssetClass.CRYPTO;
  }
  if (exchange !== null) return AssetClass.EQUITY;
  return AssetClass.OTHER;
}

/** The normalized identifiers of a hint used for matching. */
interface HintKey {
  readonly isin: string | null;
  /** The symbol as exported (or the name when the row has no symbol): the broker alias value. */
  readonly brokerSymbol: string | null;
  /** Bare ticker (market suffix split off; crypto pairs reduced to the base coin). */
  readonly ticker: string | null;
  readonly exchange: ExchangeInfo | null;
}

function hintKey(hint: InstrumentHint): HintKey {
  const isinText = clean(hint.isin);
  const isin = isinText === null ? null : pyUpper(isinText);
  const symbolText = clean(hint.symbol);
  const brokerSymbol = symbolText ?? clean(hint.name);
  if (symbolText === null) {
    return { isin, brokerSymbol, ticker: null, exchange: exchangeForHint(hint.exchangeHint) };
  }
  const split = splitBrokerSymbol(symbolText, hint.exchangeHint);
  let ticker = split.symbol;
  let exchange = split.exchange;
  if (exchange === null && !ETF_NAME.test(hint.name ?? "")) {
    const base = cryptoBase(ticker);
    if (base !== null) {
      ticker = base;
      exchange = CRYPTO;
    }
  } else if (exchange?.crypto) {
    ticker = cryptoBase(ticker) ?? ticker;
  }
  return { isin, brokerSymbol, ticker, exchange };
}

/** The broker symbol (the symbol as exported, else the name) and the ISIN a hint is matched by. */
export function hintIdentifiers(hint: InstrumentHint): {
  readonly brokerSymbol: string | null;
  readonly isin: string | null;
} {
  const { brokerSymbol, isin } = hintKey(hint);
  return { brokerSymbol, isin };
}

/** Python dataclass hash of a hint: one string per distinct hint value. */
function cacheKey(hint: InstrumentHint): string {
  return JSON.stringify([
    hint.currency,
    hint.symbol,
    hint.isin,
    hint.name,
    hint.exchangeHint,
    hint.evidence,
  ]);
}

const USD = toCurrency("USD");

/**
 * Maps import rows to instruments for one import (one broker) without writing anything.
 *
 * `idFactory` makes the ids of planned instruments (the caller supplies it: random UUIDs in the app,
 * counters in tests); the commit may keep them or remap them to stored ids.
 */
export class InstrumentResolver {
  readonly brokerId: string;
  private readonly lookup: InstrumentLookup;
  private readonly idFactory: () => InstrumentId;
  private readonly planned = new Map<InstrumentId, Instrument>();
  private readonly plannedEvidence = new Map<InstrumentId, CurrencyEvidence>();
  private readonly currencyConflicts = new Set<InstrumentId>();
  private readonly existing = new Map<InstrumentId, Instrument>();
  private readonly plannedAliases = new Map<InstrumentId, InstrumentAlias[]>();
  private readonly cache = new Map<string, ResolvedInstrument>();

  constructor(lookup: InstrumentLookup, brokerId: string, idFactory: () => InstrumentId) {
    this.lookup = lookup;
    this.brokerId = brokerId;
    this.idFactory = idFactory;
  }

  /** Instruments to create, in the order they were first needed. */
  get newInstruments(): readonly Instrument[] {
    return Object.freeze([...this.planned.values()]);
  }

  /** Aliases to add to existing instruments. */
  get newAliases(): ReadonlyMap<InstrumentId, readonly InstrumentAlias[]> {
    return new Map(
      [...this.plannedAliases].map(([key, value]) => [key, Object.freeze([...value])] as const),
    );
  }

  /** Current state of a resolved instrument (planned or existing), null if never resolved. */
  instrument(instrumentId: InstrumentId): Instrument | null {
    return this.planned.get(instrumentId) ?? this.existing.get(instrumentId) ?? null;
  }

  isPlanned(instrumentId: InstrumentId): boolean {
    return this.planned.has(instrumentId);
  }

  /**
   * The instrument (planned or stored) owning alias (`namespace`, `value`) in any equivalent
   * namespace, the ISIN column counting for `isin`; null when nobody owns it. Plans nothing.
   */
  ownerOf(namespace: string, value: string): InstrumentId | null {
    return this.owner(namespace, value);
  }

  /**
   * Resolve `hint`, planning a new instrument when nothing matches; a hint naming no instrument
   * (`hintIsEmpty`) is a broken invariant of the caller.
   */
  resolve(hint: InstrumentHint): ResolvedInstrument {
    if (hintIsEmpty(hint)) {
      throw new InvariantError("The hint names no instrument (no symbol, ISIN or name)");
    }
    const keyText = cacheKey(hint);
    const cached = this.cache.get(keyText);
    if (cached !== undefined) return cached;
    const key = hintKey(hint);
    const notes: string[] = [];
    const found = this.match(key, notes);
    let result: ResolvedInstrument;
    if (found === null) {
      const planned = this.plan(hint, key);
      result = resolved(planned.id, InstrumentMatch.CREATED);
    } else {
      const [instrumentId, match] = found;
      this.learn(instrumentId, key.isin, key.brokerSymbol, notes);
      this.weighCurrency(instrumentId, hint, notes);
      result = resolved(instrumentId, match, notes);
    }
    this.cache.set(keyText, result);
    return result;
  }

  /**
   * Match without planning or learning anything (corporate actions naming an instrument that must
   * already exist in the store or among this import's rows); null when nothing matches.
   */
  find(
    query: {
      readonly symbol?: string | null;
      readonly isin?: string | null;
      readonly name?: string | null;
      readonly exchangeHint?: string | null;
    } = {},
  ): ResolvedInstrument | null {
    // the currency is unused: matching never reads it
    const key = hintKey(instrumentHint({ currency: USD, ...query }));
    if (key.isin === null && key.brokerSymbol === null) return null;
    const notes: string[] = [];
    const found = this.match(key, notes);
    return found === null ? null : resolved(found[0], found[1], notes);
  }

  private match(key: HintKey, notes: string[]): [InstrumentId, InstrumentMatch] | null {
    if (key.isin !== null) {
      const owner = this.owner(AliasNamespace.ISIN, key.isin);
      if (owner !== null) return [owner, InstrumentMatch.ISIN];
    }
    if (key.brokerSymbol !== null) {
      const owner = this.owner(this.brokerId, key.brokerSymbol);
      if (owner !== null) return [owner, InstrumentMatch.BROKER_ALIAS];
    }
    if (key.ticker !== null && key.exchange !== null) {
      const owner = this.bySymbolAndExchange(key.ticker, key.exchange, notes);
      if (owner !== null) return [owner, InstrumentMatch.SYMBOL_EXCHANGE];
    }
    return null;
  }

  // --- matching ----------------------------------------------------------------------------------

  private bySymbolAndExchange(
    symbol: string,
    exchange: ExchangeInfo,
    notes: string[],
  ): InstrumentId | null {
    const mic = exchange.mic;
    if (mic !== null) {
      const upper = pyUpper(symbol);
      for (const item of this.planned.values()) {
        if (pyUpper(item.symbol ?? "") === upper && item.mic === mic) return item.id;
      }
      const stored = this.lookup.bySymbol(symbol, mic);
      const oldest = stored[0];
      if (oldest !== undefined) {
        if (stored.length > 1) {
          notes.push(
            `Symbol ${symbol} on ${mic} matches ${stored.length} instruments; used the oldest (${oldest.name})`,
          );
        }
        return this.remember(oldest).id;
      }
    }
    for (const [namespace, value] of [
      [AliasNamespace.STOOQ, stooqSymbol(exchange, symbol)],
      [AliasNamespace.YAHOO, yahooSymbol(exchange, symbol)],
    ] as const) {
      if (value === null) continue;
      const owner = this.owner(namespace, value);
      if (owner !== null) return owner;
    }
    return null;
  }

  /**
   * The instrument owning alias (`namespace`, `value`) in any equivalent namespace (the canonical
   * `cashu` and its legacy name `finanse` are one): planned instruments and planned aliases first,
   * then the lookup.
   */
  private owner(namespace: string, value: string): InstrumentId | null {
    for (const ns of equivalentNamespaces(namespace)) {
      const found = this.ownerIn(ns, value);
      if (found !== null) return found;
    }
    return null;
  }

  private ownerIn(namespace: string, value: string): InstrumentId | null {
    const normalized = normalizeAlias(namespace, value);
    const owns = (alias: InstrumentAlias) =>
      alias.namespace === namespace && alias.value === normalized;
    for (const item of this.planned.values()) {
      if (namespace === AliasNamespace.ISIN && item.isin === normalized) return item.id;
      if (item.aliases.some(owns)) return item.id;
    }
    for (const [instrumentId, aliases] of this.plannedAliases) {
      if (aliases.some(owns)) return instrumentId;
    }
    const stored =
      namespace === AliasNamespace.ISIN
        ? this.lookup.byIsin(normalized)
        : this.lookup.byAlias(namespace, normalized);
    return stored === null ? null : this.remember(stored).id;
  }

  private remember(item: Instrument): Instrument {
    const known = this.existing.get(item.id);
    if (known !== undefined) return known;
    this.existing.set(item.id, item);
    return item;
  }

  // --- planning ----------------------------------------------------------------------------------

  private plan(hint: InstrumentHint, key: HintKey): Instrument {
    const { isin, brokerSymbol, ticker: symbol, exchange } = key;
    const aliases: InstrumentAlias[] = [];
    if (brokerSymbol !== null) aliases.push(instrumentAlias(this.brokerId, brokerSymbol));
    if (symbol !== null && exchange !== null) {
      for (const [namespace, value] of [
        [AliasNamespace.STOOQ, stooqSymbol(exchange, symbol)],
        [AliasNamespace.YAHOO, yahooSymbol(exchange, symbol)],
      ] as const) {
        if (value !== null && this.owner(namespace, value) === null) {
          aliases.push(instrumentAlias(namespace, value, true));
        }
      }
    }
    const name = clean(hint.name) || symbol || isin || brokerSymbol || "?";
    const planned = instrument({
      id: this.idFactory(),
      name,
      currency: hint.currency,
      assetClass: guessAssetClass(name, symbol, exchange),
      symbol,
      isin,
      mic: exchange === null ? null : exchange.mic,
      needsClassification: true,
      aliases,
    });
    this.planned.set(planned.id, planned);
    this.plannedEvidence.set(planned.id, hint.evidence);
    return planned;
  }

  /**
   * Let a later row of a planned instrument correct its currency when it is stronger evidence (R10);
   * note trade rows that disagree.
   */
  private weighCurrency(instrumentId: InstrumentId, hint: InstrumentHint, notes: string[]): void {
    const planned = this.planned.get(instrumentId);
    const evidence = this.plannedEvidence.get(instrumentId);
    if (planned === undefined || evidence === undefined) return;
    if (planned.currency === hint.currency) {
      if (hint.evidence > evidence) this.plannedEvidence.set(instrumentId, hint.evidence);
      return;
    }
    if (hint.evidence > evidence) {
      this.planned.set(instrumentId, Object.freeze({ ...planned, currency: hint.currency }));
      this.plannedEvidence.set(instrumentId, hint.evidence);
    } else if (
      hint.evidence === CurrencyEvidence.TRADE &&
      evidence === CurrencyEvidence.TRADE &&
      !this.currencyConflicts.has(instrumentId)
    ) {
      this.currencyConflicts.add(instrumentId);
      notes.push(
        `Trade rows of ${planned.name} use several currencies (${planned.currency}, ${hint.currency}); created it in ${planned.currency}`,
      );
    }
  }

  /**
   * Plan the ISIN and broker symbol aliases `instrumentId` lacks, unless another instrument owns them.
   */
  private learn(
    instrumentId: InstrumentId,
    isin: string | null,
    brokerSymbol: string | null,
    notes: string[],
  ): void {
    const current = this.instrument(instrumentId);
    if (current === null) return; // every match path remembers the instrument
    if (isin !== null) {
      const owner = this.owner(AliasNamespace.ISIN, isin);
      const known = aliasOf(current, AliasNamespace.ISIN) || current.isin;
      if (owner === null && known === null) {
        this.addAlias(instrumentId, AliasNamespace.ISIN, isin);
      } else if (owner !== instrumentId && (owner !== null || known !== isin)) {
        notes.push(
          `ISIN ${isin} of the row differs from ${current.name} (${known || "owned by another instrument"})`,
        );
      }
    }
    if (brokerSymbol !== null) {
      const owner = this.owner(this.brokerId, brokerSymbol);
      if (owner === null) {
        this.addAlias(instrumentId, this.brokerId, brokerSymbol);
      } else if (owner !== instrumentId) {
        const other = this.instrument(owner);
        notes.push(
          `Broker symbol ${brokerSymbol} belongs to ${other ? other.name : "another instrument"}, but the row was matched to ${current.name}`,
        );
      }
    }
  }

  private addAlias(instrumentId: InstrumentId, namespace: string, value: string): void {
    const planned = this.planned.get(instrumentId);
    if (planned !== undefined) {
      const next =
        namespace === AliasNamespace.ISIN
          ? { ...planned, isin: value }
          : {
              ...planned,
              aliases: Object.freeze([...planned.aliases, instrumentAlias(namespace, value)]),
            };
      this.planned.set(instrumentId, Object.freeze(next));
      return;
    }
    const list = this.plannedAliases.get(instrumentId) ?? [];
    list.push(instrumentAlias(namespace, value));
    this.plannedAliases.set(instrumentId, list);
  }
}

function normalizeAlias(namespace: string, value: string): string {
  const trimmed = pyStrip(value);
  return namespace === AliasNamespace.ISIN ? pyUpper(trimmed) : trimmed;
}

function clean(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = pyStrip(value);
  return trimmed || null;
}
