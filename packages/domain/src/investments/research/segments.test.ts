/**
 * Test-for-test translation of `tests/investments/research/test_p5_segments.py`: market segments
 * (P5), pure parts: the catalog, the automatic assignment (asset class, stablecoins, the fund table
 * with exchange suffixes), precedence of the profile's own value, segment-note validation (kinds,
 * relation, 400-character summary, no candidate / theme), the run scope's segments and the signal
 * dedup key. Synthetic input only.
 *
 * Also `tests/investments/performance/test_p7_topics.py::test_the_owner_topics_labels_and_the_power_rename`,
 * which S19a could not translate before this port (it only exercises `research.segments`).
 */
import { describe, expect, it } from "vitest";
import { AssetClass } from "../domain/enums.js";
import { type Instrument, instrument, instrumentAlias } from "../domain/instrument.js";
import { asInstrumentId, Currencies } from "../domain/values.js";
import { utcInstant } from "./instant.js";
import { researchDedupKey } from "./keys.js";
import {
  autoSegment,
  bareSymbol,
  catalog,
  catalogOrder,
  FUND_SEGMENTS,
  isSegment,
  LEGACY_KEYS,
  SEGMENT_KEYS,
  SEGMENTS,
  segmentLabel,
  segmentOf,
  UNASSIGNED,
} from "./segments.js";
import {
  ResearchInputError,
  SEGMENT_ONLY,
  SEGMENT_SUMMARY_MAX,
  validateCounts,
  validateNote,
  validateScope,
} from "./validation.js";

const NOW = utcInstant("2026-10-08", 12);

function inst(
  symbol: string | null,
  assetClass: AssetClass = AssetClass.ETF,
  aliases: readonly [string, string][] = [],
): Instrument {
  return instrument({
    id: asInstrumentId("1"),
    name: "Example fund",
    currency: Currencies.USD,
    assetClass,
    symbol,
    aliases: aliases.map(([ns, value]) => instrumentAlias(ns, value)),
  });
}

function raw(changes: Record<string, unknown> = {}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    kind: "macro",
    polarity: "negative",
    strength: 2,
    segment: "gold",
    title: "Zloto tanieje po danych z USA",
    summary: "Przykladowe dane: cena zlota spadla w tygodniu; GDXJ -4,4 %.",
    sources: [
      {
        url: "https://example.com/gold/1",
        publisher: "Example News",
        published_at: "2026-10-07",
      },
    ],
    ...changes,
  };
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null));
}

function problems(changes: Record<string, unknown> = {}): string {
  try {
    validateNote(raw(changes), NOW);
  } catch (error) {
    if (error instanceof ResearchInputError) return error.message;
    throw error;
  }
  throw new Error("expected ResearchInputError");
}

describe("market segments (test_p5_segments.py)", () => {
  // test_catalog_integrity
  it("catalog integrity", () => {
    expect(SEGMENTS).toHaveLength(19);
    expect(new Set(SEGMENT_KEYS).size).toBe(19);
    expect(SEGMENT_KEYS[0]).toBe("equity_global");
    expect(SEGMENT_KEYS.at(-1)).toBe("quantum");
    expect(SEGMENT_KEYS.every((k) => /^[a-z_]+$/.test(k))).toBe(true);
    expect(new Set(SEGMENTS.map((s) => s.group))).toEqual(new Set(["asset", "sector"]));
    expect(SEGMENTS.every((s) => s.label && s.label.trim() === s.label)).toBe(true);
    expect(SEGMENT_KEYS).not.toContain(UNASSIGNED);
    expect([...FUND_SEGMENTS.values()].every((v) => SEGMENT_KEYS.includes(v))).toBe(true);
    expect(segmentLabel("gold", "pl")).toBe("Złoto i górnicy");
    expect(segmentLabel(UNASSIGNED, "pl")).toBe("Bez tematu");
    expect(isSegment("semis_ai")).toBe(true);
    expect(isSegment("Gold")).toBe(false);
    expect(isSegment(null)).toBe(false);
    expect(catalogOrder("equity_global")).toBe(0);
    expect(catalogOrder("nope")).toBe(SEGMENTS.length);
    expect(catalog("pl")[3]).toEqual({
      segment: "bonds",
      label: "Obligacje i stopy",
      group: "asset",
    });
  });

  // test_bare_symbol (parametrized)
  it.each([
    ["GDXJ", "gdxj"],
    ["GDXJ.L", "gdxj"],
    ["gdxj.us", "gdxj"],
    ["XETR:SXR8", "sxr8"],
    [" vwce.de ", "vwce"],
    [null, ""],
  ])("bare symbol %s", (symbol, expected) => {
    expect(bareSymbol(symbol)).toBe(expected.toUpperCase());
  });

  // test_auto_segment_table_with_suffixes
  it("auto segment table with suffixes", () => {
    expect(autoSegment(inst("GDXJ"))).toBe("gold");
    expect(autoSegment(inst("GDXJ.L"))).toBe("gold");
    expect(autoSegment(inst("URNM"))).toBe("power");
    expect(autoSegment(inst("SXR8.DE"))).toBe("equity_global");
    expect(autoSegment(inst("EIMI.L"))).toBe("equity_em");
    expect(autoSegment(inst("SMH"))).toBe("semis_ai");
    expect(autoSegment(inst("COPX"))).toBe("metals");
    expect(autoSegment(inst("XLE"))).toBe("energy");
    expect(autoSegment(inst("IPRP.L"))).toBe("real_estate");
    expect(autoSegment(inst("TLT"))).toBe("bonds");
    expect(autoSegment(inst("CDR", AssetClass.EQUITY))).toBeNull();
    // no display symbol: the price alias decides
    expect(autoSegment(inst(null, AssetClass.ETF, [["yahoo", "SIL"]]))).toBe("gold");
    expect(autoSegment(inst("XYZ", AssetClass.ETF, [["xtb", "GDX.US"]]))).toBeNull();
  });

  // test_auto_segment_by_asset_class_and_stablecoins
  it("auto segment by asset class and stablecoins", () => {
    expect(autoSegment(inst("EDO0336", AssetClass.TREASURY_BOND))).toBe("bonds");
    expect(autoSegment(inst("CORP", AssetClass.BOND))).toBe("bonds");
    expect(autoSegment(inst("BTC", AssetClass.CRYPTO))).toBe("crypto");
    expect(autoSegment(inst("ETH-USD", AssetClass.CRYPTO))).toBe("crypto");
    for (const coin of ["USDC", "usdt", "DAI", "EURC", "FDUSD", "PYUSD", "USDT-USD"]) {
      expect(autoSegment(inst(coin, AssetClass.CRYPTO)), coin).toBeNull();
    }
    expect(autoSegment(inst(null, AssetClass.CRYPTO))).toBe("crypto");
  });

  // test_precedence_set_over_auto_over_none
  it("precedence: set over auto over none", () => {
    const gold = inst("GDXJ");
    expect(segmentOf(gold, null)).toEqual(["gold", "auto"]);
    // unknown setter: the owner
    expect(segmentOf(gold, "metals")).toEqual(["metals", "owner"]);
    expect(segmentOf(gold, "metals", "agent")).toEqual(["metals", "agent"]);
    expect(segmentOf(gold, "metals", "owner")).toEqual(["metals", "owner"]);
    expect(segmentOf(inst("CDR", AssetClass.EQUITY), null)).toEqual([null, null]);
    expect(segmentOf(inst("CDR", AssetClass.EQUITY), "games_media", "agent")).toEqual([
      "games_media",
      "agent",
    ]);
    // a value dropped from the catalog is ignored
    expect(segmentOf(gold, "old_key")).toEqual(["gold", "auto"]);
  });

  // test_segment_note_validation
  it("segment note validation", () => {
    const ok = validateNote(raw(), NOW);
    expect(ok.segment).toBe("gold");
    expect(ok.theme).toBeNull();
    expect(ok.details).toBeNull();
    for (const kind of ["trend", "news"]) {
      expect(validateNote(raw({ kind }), NOW).kind).toBe(kind);
    }
    expect(problems({ segment: "Gold" })).toContain("segment: must be one of");
    expect(problems({ kind: "earnings" })).toContain(
      "a segment note is one of: macro, trend, news",
    );
    expect(problems({ kind: "community", details: { scale: "small" } })).toContain(
      "kind: a segment note",
    );
    // P9: a topic note may bear on its topic thesis (the service checks the thesis exists)
    expect(validateNote(raw({ thesis_relation: "supports" }), NOW).thesisField).toBe("thesis");
    expect(problems({ thesis_relation: "fulfills" })).toContain(
      "a topic note bears on its topic thesis",
    );
    expect(problems({ segment: "macro_risk", thesis_relation: "supports" })).toContain(
      "a macro note has no thesis",
    );
    expect(problems({ candidate: { symbol_or_isin: "GDXJ.US" } })).toContain(SEGMENT_ONLY);
    expect(problems({ theme: "Zloto" })).toContain("segment note has no theme");
    const long = "x".repeat(SEGMENT_SUMMARY_MAX + 1);
    expect(problems({ summary: long })).toContain("too long for a segment note (max 400");
    expect(validateNote(raw({ summary: "x".repeat(SEGMENT_SUMMARY_MAX) }), NOW).segment).toBe(
      "gold",
    );
    // an instrument note keeps the general limit
    expect(validateNote(raw({ segment: null, summary: long }), NOW).segment).toBeNull();
  });

  // test_scope_segments_and_counts
  it("scope segments and counts", () => {
    const scope = validateScope({ held: false, segments: ["gold", "gold", "crypto"] });
    expect(scope.segments).toEqual(["gold", "crypto"]);
    expect(scope.held).toBe(false);
    expect(() => validateScope({ segments: ["Złoto"] })).toThrow(/scope\.segments\[0\]/);
    expect(() => validateScope({ segments: "gold" })).toThrow(/scope\.segments/);
    expect(validateCounts({ segments_covered: 4, themes_covered: 1 })).toEqual({
      segments_covered: 4,
      themes_covered: 1,
    });
  });

  // test_signal_dedup_key_scopes
  it("signal dedup key scopes", () => {
    const week = "2026-W41";
    expect(researchDedupKey(week, { segment: "gold" })).toBe("research:2026-W41|s:gold");
    expect(researchDedupKey(week, { instrumentId: "3", segment: "gold" })).toBe(
      "research:2026-W41|i:3",
    );
    expect(researchDedupKey(week, { theme: "energia" })).toBe("research:2026-W41|t:energia");
  });
});

describe("topics labels and the power rename (test_p7_topics.py, the research.segments test)", () => {
  // test_the_owner_topics_labels_and_the_power_rename
  it("the owner topics, labels and the power rename", () => {
    const labels: Record<string, string> = {
      semis_ai: "AI: chipy i centra danych",
      software: "AI i oprogramowanie",
      robotics: "Robotyka",
      quantum: "Komputery kwantowe",
      power: "Energetyka: atom i OZE",
      energy: "Ropa i gaz",
      metals: "Metale i ziemie rzadkie",
      games_media: "Gry",
      financials: "Płatności i finanse",
      gold: "Złoto i górnicy",
    };
    expect(Object.fromEntries(Object.keys(labels).map((k) => [k, segmentLabel(k, "pl")]))).toEqual(
      labels,
    );
    expect(SEGMENT_KEYS).not.toContain("uranium");
    expect(LEGACY_KEYS).toEqual(new Map([["uranium", "power"]]));
    expect(new Set(["URA", "URNM", "URNU", "NUKZ"].map((s) => FUND_SEGMENTS.get(s)))).toEqual(
      new Set(["power"]),
    );
    const etf = inst("URA", AssetClass.ETF);
    expect(autoSegment(etf)).toBe("power");
    const stock = instrument({
      id: asInstrumentId("2"),
      name: "Example",
      currency: Currencies.USD,
      assetClass: AssetClass.EQUITY,
    });
    // an old stored value
    expect(segmentOf(stock, "uranium", "agent")).toEqual(["power", "agent"]);
    expect(segmentOf(stock, "dropped_key")).toEqual([null, null]);
  });
});
