/**
 * Market segments (`research/segments.py`, P5): a small fixed catalog of asset classes and sectors
 * behind the portfolio, the segment of each instrument and the automatic assignment of well-known
 * funds. Pure.
 *
 * An instrument's segment is per profile (set by the owner or the research agent); without one,
 * `autoSegment` guesses from the asset class and a table of well-known fund symbols; otherwise it
 * has none (the attribution shows it as `unassigned`). Order of `SEGMENTS` is the UI tie-break.
 * Labels are Polish (`label`: MCP, matching) with an English `labelEn` for the UI. `MACRO_SEGMENTS`
 * (P6) holds the macro regime cards as segment-note targets only.
 */

import { pickLabel, type UiLang } from "../../core/i18n.js";
import { pyRegex } from "../../pyRegex.js";
import { pyStrip, pyUpper } from "../../text.js";
import { AssetClass } from "../domain/enums.js";
import { AliasNamespace, type Instrument } from "../domain/instrument.js";

export type SegmentSource = "owner" | "agent" | "auto";
/** Who set an instrument's segment: the owner in the app or the research agent over MCP. */
export const SEGMENT_SETTERS: readonly string[] = Object.freeze(["owner", "agent"]);

export interface Segment {
  /** Stable id, `[a-z_]+` (API, MCP, DB). */
  readonly key: string;
  /** Polish, UI. */
  readonly label: string;
  /** `asset` | `sector` | `macro`. */
  readonly group: string;
  /** English, UI. */
  readonly labelEn: string;
}

function seg(key: string, label: string, group: string, labelEn: string): Segment {
  return Object.freeze({ key, label, group, labelEn });
}

/** The label in `lang` (`label` stays Polish: MCP, matching). */
export function displayLabel(segment: Segment, lang: UiLang): string {
  return pickLabel(lang, segment.label, segment.labelEn);
}

export const SEGMENTS: readonly Segment[] = Object.freeze([
  seg("equity_global", "Akcje globalne", "asset", "Global equities"),
  seg("equity_pl", "Akcje polskie", "asset", "Polish equities"),
  seg("equity_em", "Rynki wschodzące", "asset", "Emerging markets"),
  seg("bonds", "Obligacje i stopy", "asset", "Bonds and rates"),
  seg("gold", "Złoto i górnicy", "asset", "Gold and miners"),
  seg("energy", "Ropa i gaz", "asset", "Oil and gas"),
  seg("power", "Energetyka: atom i OZE", "asset", "Power: nuclear and renewables"),
  seg("metals", "Metale i ziemie rzadkie", "asset", "Metals and rare earths"),
  seg("crypto", "Krypto", "asset", "Crypto"),
  seg("real_estate", "Nieruchomości", "asset", "Real estate"),
  seg("semis_ai", "AI: chipy i centra danych", "sector", "AI: chips and data centers"),
  seg("software", "AI i oprogramowanie", "sector", "AI and software"),
  seg("robotics", "Robotyka", "sector", "Robotics"),
  seg("healthcare", "Ochrona zdrowia", "sector", "Healthcare"),
  seg("financials", "Płatności i finanse", "sector", "Payments and finance"),
  seg("consumer", "Konsumpcja", "sector", "Consumer"),
  seg("games_media", "Gry", "sector", "Games"),
  seg("industrials", "Przemysł i obronność", "sector", "Industrials and defense"),
  seg("quantum", "Komputery kwantowe", "sector", "Quantum computing"),
]);
export const SEGMENT_KEYS: readonly string[] = Object.freeze(SEGMENTS.map((s) => s.key));
export const SEGMENT_GROUPS: readonly string[] = Object.freeze(["asset", "sector"]);
/** Pseudo row of the attribution for holdings without a segment (never a catalog key). */
export const UNASSIGNED = "unassigned";
export const UNASSIGNED_LABEL = "Bez tematu";
export const UNASSIGNED_LABEL_EN = "No topic";

/**
 * The macro regime cards as note targets (P6): a segment note may name one, an instrument never gets
 * one (not in `SEGMENTS`, never an attribution row). Labels = the regime card titles.
 */
export const MACRO_SEGMENTS: readonly Segment[] = Object.freeze([
  seg("macro_risk", "Rynek akcji", "macro", "Stock market"),
  seg("macro_dollar", "Dolar", "macro", "Dollar"),
  seg("macro_em", "Rynki wschodzące", "macro", "Emerging markets"),
  seg("macro_commodities", "Surowce", "macro", "Commodities"),
  seg("macro_rates", "Obligacje i stopy", "macro", "Bonds and rates"),
]);
export const MACRO_KEYS: readonly string[] = Object.freeze(MACRO_SEGMENTS.map((s) => s.key));
/** Every key a segment note (and a research scope) may name. */
export const NOTE_SEGMENT_KEYS: readonly string[] = Object.freeze([...SEGMENT_KEYS, ...MACRO_KEYS]);
export const MACRO_PREFIX = "macro_";
export const NOT_INSTRUMENT_SEGMENT = "macro keys are not instrument segments";

/**
 * Keys renamed in the catalog (P7: `uranium` -> `power`); `segmentOf` still reads an old value as
 * its new key.
 */
export const LEGACY_KEYS: ReadonlyMap<string, string> = new Map([["uranium", "power"]]);

const BY_KEY: ReadonlyMap<string, Segment> = new Map(SEGMENTS.map((s) => [s.key, s]));
const MACRO_BY_KEY: ReadonlyMap<string, Segment> = new Map(MACRO_SEGMENTS.map((s) => [s.key, s]));
const ORDER: ReadonlyMap<string, number> = new Map(SEGMENTS.map((s, i) => [s.key, i]));

/** Crypto symbols pegged to a currency: no market segment (they behave like cash). */
export const STABLECOINS: ReadonlySet<string> = new Set([
  "USDC",
  "USDT",
  "DAI",
  "EURC",
  "FDUSD",
  "PYUSD",
]);

/** `_FUNDS`, verbatim: segment -> well-known fund symbols (without exchange suffix). */
export const FUNDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  gold: Object.freeze(["GLD", "IAU", "SGLD", "PHAU", "GDX", "GDXJ", "RING", "SIL"]),
  power: Object.freeze(["URA", "URNM", "URNU", "NUKZ"]),
  metals: Object.freeze(["REMX", "COPX", "PICK", "XME", "LIT"]),
  energy: Object.freeze(["OIH", "XLE", "XOP", "VDE", "IXC"]),
  equity_global: Object.freeze([
    "VOO",
    "SPY",
    "IVV",
    "CSPX",
    "SXR8",
    "IUSQ",
    "VWCE",
    "VWRA",
    "VWRP",
    "ACWI",
    "SSAC",
    "EUNL",
    "IWDA",
    "SWDA",
  ]),
  equity_em: Object.freeze(["EEM", "EIMI", "IEMG", "VFEM", "MCHI", "FXI", "KWEB"]),
  semis_ai: Object.freeze(["SMH", "SOXX", "SEMI"]),
  healthcare: Object.freeze(["XLV"]),
  financials: Object.freeze(["XLF"]),
  real_estate: Object.freeze(["VNQ", "IPRP"]),
  bonds: Object.freeze(["TLT", "IEF", "AGG", "BND", "IBTM", "IGLT"]),
});
/** Well-known fund symbols (without exchange suffix) -> segment. */
export const FUND_SEGMENTS: ReadonlyMap<string, string> = new Map(
  Object.entries(FUNDS).flatMap(([segment, symbols]) => symbols.map((s) => [s, segment] as const)),
);

const BOND_CLASSES: readonly string[] = [AssetClass.BOND, AssetClass.TREASURY_BOND];
const SUFFIX = pyRegex("[.:].*$");

export function isSegment(key: unknown): key is string {
  return typeof key === "string" && BY_KEY.has(key);
}

/** A macro regime note target (`macro_rates`), never an instrument segment. */
export function isMacroKey(key: unknown): key is string {
  return typeof key === "string" && MACRO_BY_KEY.has(key);
}

/** A key a segment note may name: a market segment or a macro regime. */
export function isNoteSegment(key: unknown): key is string {
  return isSegment(key) || isMacroKey(key);
}

/** `rates` -> `macro_rates`. */
export function macroKey(regime: string): string {
  return MACRO_PREFIX + regime;
}

/** `macro_rates` -> `rates` (null for anything else). */
export function regimeOf(key: string): string | null {
  return isMacroKey(key) ? key.slice(MACRO_PREFIX.length) : null;
}

export function segment(key: string): Segment | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * The label of `key` in `lang` (`Bez tematu` / `No topic` for the unassigned row, the key itself
 * when unknown, e.g. a key dropped from the catalog later).
 */
export function segmentLabel(key: string, lang: UiLang): string {
  if (key === UNASSIGNED) return pickLabel(lang, UNASSIGNED_LABEL, UNASSIGNED_LABEL_EN);
  const found = BY_KEY.get(key) ?? MACRO_BY_KEY.get(key);
  return found !== undefined ? displayLabel(found, lang) : key;
}

export function segmentGroup(key: string): string | null {
  return (BY_KEY.get(key) ?? MACRO_BY_KEY.get(key))?.group ?? null;
}

/** Position in `SEGMENTS` (unknown keys and the unassigned row last). */
export function catalogOrder(key: string | null | undefined): number {
  return ORDER.get(key ?? "") ?? SEGMENTS.length;
}

/** `GDXJ.L` / `gdxj.us` / `XETR:SXR8` -> `GDXJ` / `SXR8` (upper case, no exchange). */
export function bareSymbol(symbol: string | null | undefined): string {
  let text = pyUpper(pyStrip(symbol ?? ""));
  const colon = text.lastIndexOf(":");
  if (colon >= 0) text = text.slice(colon + 1);
  return text.replace(SUFFIX, "");
}

/**
 * The instrument's ticker, then its price-source aliases (an instrument without a display symbol
 * still matches by its Yahoo / stooq symbol).
 */
function symbols(instrument: Instrument): string[] {
  const out = instrument.symbol ? [instrument.symbol] : [];
  for (const alias of instrument.aliases) {
    if (
      (alias.namespace === AliasNamespace.YAHOO || alias.namespace === AliasNamespace.STOOQ) &&
      alias.value
    ) {
      out.push(alias.value);
    }
  }
  return out;
}

/**
 * The segment guessed when nothing was set: bonds and treasury bonds -> `bonds`; crypto -> `crypto`
 * except stablecoins; a well-known fund symbol (exchange suffix ignored) -> its segment; else null.
 */
export function autoSegment(instrument: Instrument): string | null {
  if (BOND_CLASSES.includes(instrument.assetClass)) return "bonds";
  const values = symbols(instrument);
  if (instrument.assetClass === AssetClass.CRYPTO) {
    for (const value of values) {
      // crypto pairs are written BTC-USD / USDT-USD: the base asset decides
      const bare = bareSymbol(value);
      const dash = bare.indexOf("-");
      if (STABLECOINS.has(dash < 0 ? bare : bare.slice(0, dash))) return null;
    }
    return "crypto";
  }
  for (const value of values) {
    const found = FUND_SEGMENTS.get(bareSymbol(value));
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * `[segment, source]`: the profile's own value (source = who set it, `owner` or `agent`; `owner`
 * when unknown) wins over `autoSegment` (`auto`); `[null, null]` when neither gives one. A renamed
 * key reads as its new key; an explicit value no longer in the catalog is ignored.
 */
export function segmentOf(
  instrument: Instrument,
  explicit: string | null | undefined,
  setBy: string | null = null,
): readonly [string | null, SegmentSource | null] {
  const key =
    explicit === null || explicit === undefined ? null : (LEGACY_KEYS.get(explicit) ?? explicit);
  if (isSegment(key)) {
    return [
      key,
      setBy !== null && SEGMENT_SETTERS.includes(setBy) ? (setBy as SegmentSource) : "owner",
    ];
  }
  const guessed = autoSegment(instrument);
  if (guessed !== null) return [guessed, "auto"];
  return [null, null];
}

export interface CatalogRow {
  readonly segment: string;
  readonly label: string;
  readonly group: string;
}

/** The catalog as JSON rows (API / MCP), labels in `lang`. */
export function catalog(lang: UiLang): CatalogRow[] {
  return SEGMENTS.map((s) => ({ segment: s.key, label: displayLabel(s, lang), group: s.group }));
}

/** The macro note targets as JSON rows (API / MCP), apart from the instrument catalog. */
export function macroCatalog(lang: UiLang): CatalogRow[] {
  return MACRO_SEGMENTS.map((s) => ({
    segment: s.key,
    label: displayLabel(s, lang),
    group: s.group,
  }));
}
