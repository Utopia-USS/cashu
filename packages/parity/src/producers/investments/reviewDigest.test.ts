/** Complete actual Python view bytes over invented SQL only; no demo/lab dataset is read. */
import { readFileSync } from "node:fs";
import { addDays, D, investments as inv, parsePyJson, toCurrency } from "@cashu/domain";
import { investmentsViews } from "@cashu/store";
import { afterEach, describe, expect, it } from "vitest";
import { type PythonDb, withPythonDb } from "../../sources/pythonDb.ts";
import { type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import { dumps, type OutValue } from "../output.ts";
import { produceAccounts } from "./accounts.ts";
import { produceAllocationView } from "./allocationView.ts";
import { produceOverview } from "./overview.ts";
import { producePositionDetail } from "./positionDetail.ts";
import { producePositions } from "./positions.ts";
import { copiedSegmentMembers, produceReviewDigest } from "./reviewDigest.ts";
import { produceStrategyStatus } from "./strategyStatus.ts";
import { viewOutput } from "./viewOutput.ts";
import {
  copiedProjectionInput,
  copiedSourceGid,
  copiedWarningMessage,
  nativeViewSources,
} from "./viewSource.ts";
import { produceWatchlist } from "./watchlist.ts";

interface ContextVector {
  readonly profile: number;
  readonly lang: "en" | "pl";
  readonly calendar: Pick<inv.market.CalendarView, "stale" | "events">;
  readonly expected: unknown;
}
interface TopicVariant {
  readonly mode: "collision" | "missing";
  readonly lang: "pl" | "en";
  readonly topic_id: number;
  readonly sql_delta: string;
  readonly expected_bytes: string;
  readonly topic_key: string;
  readonly topic_dangling_refs: number;
  readonly check_dangling_refs: number;
}
interface MemberOrderVector {
  readonly mode: string;
  readonly end: string;
  readonly closes: Readonly<Record<string, string | null>>;
  readonly held: Readonly<Record<string, boolean>>;
  readonly raw: Readonly<Record<string, readonly (number | null)[]>>;
  readonly expected_order: readonly string[];
}
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/review-views.json", import.meta.url), "utf8"),
) as {
  readonly sql: string;
  readonly files: Readonly<Record<string, string>>;
  readonly expected_bytes: Readonly<Record<string, string>>;
  readonly contexts: readonly ContextVector[];
  readonly topic_variants: readonly TopicVariant[];
  readonly member_order_vectors: readonly MemberOrderVector[];
};
let ds: SyntheticDataset | undefined;
afterEach(() => ds?.dispose());
function run<T>(test: (db: PythonDb) => T, variant?: TopicVariant): T {
  ds = syntheticDataset(`${fixture.sql}\n${variant?.sql_delta ?? ""}`);
  for (const [path, text] of Object.entries(fixture.files)) ds.writeFile(path, text);
  return withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, test);
}
const providers: Readonly<Record<string, (db: PythonDb) => OutValue>> = {
  "investments.overview": produceOverview,
  "investments.positions": producePositions,
  "investments.position_detail": producePositionDetail,
  "investments.allocation_view": produceAllocationView,
  "investments.strategy_status": produceStrategyStatus,
  "investments.review_digest": (db) => produceReviewDigest(db, "en"),
  "investments.accounts": produceAccounts,
  "investments.watchlist": produceWatchlist,
};

function mismatchPaths(actual: string, expected: string): string[] {
  const reader = (literal: string, integer: boolean) => ({ literal, integer });
  const paths: string[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (a === b) return;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
      paths.push(path);
      return;
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      walk(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
  };
  walk(parsePyJson(actual, reader), parsePyJson(expected, reader), "$");
  return paths;
}

describe("genuine native view fixture", () => {
  it.each(fixture.member_order_vectors)("uses exact raw member keys: $mode", (vector) =>
    run((db) => {
      const source = nativeViewSources(db)[0];
      if (source === undefined) throw new Error("synthetic source is absent");
      // Canonical order deliberately opposes Python textual local counter order.
      const ids = new Map([
        ["2", inv.asInstrumentId("00000000-0000-8000-8000-000000000002")],
        ["10", inv.asInstrumentId("00000000-0000-8000-8000-000000000010")],
      ]);
      const sources = new Map(
        [...ids].map(([localId, gid]) => [gid, { table: "inv_instruments", localId }]),
      );
      const boundary = { vault: { ...source.vault, sources } };
      const trends = inv.performance.segmentTrends(
        new Map(
          [...ids].map(([localId, id]) => [id, ["equity_global", vector.held[localId]!] as const]),
        ),
        new Map(
          [...ids].map(([localId, gid]) => {
            const close = vector.closes[localId];
            return [
              gid,
              close == null
                ? []
                : [
                    inv.priceBar({
                      instrumentId: gid,
                      date: addDays(vector.end, -7),
                      close: D("10"),
                      currency: toCurrency("PLN"),
                      source: "synthetic",
                    }),
                    inv.priceBar({
                      instrumentId: gid,
                      date: vector.end,
                      close: D(close),
                      currency: toCurrency("PLN"),
                      source: "synthetic",
                    }),
                  ],
            ];
          }),
        ),
        vector.end,
      );
      const raw = trends.get("equity_global");
      if (raw === undefined) throw new Error("synthetic trend is absent");
      const local = (gid: string) => sources.get(inv.asInstrumentId(gid))?.localId;
      for (const member of raw.instruments)
        expect(member.returns).toEqual(vector.raw[local(member.instrumentId)!]);
      const segment = {
        segment: "equity_global",
        member_instruments: raw.instruments.map((row) => ({
          instrument_id: String(row.instrumentId),
          label: null,
          held: row.held,
          return_1w: row.returns[0] === null ? null : inv.research.roundShare(row.returns[0]!),
          return_4w: null,
        })),
      };
      const metadata = { bySegment: trends, labels: new Map() };
      const before = structuredClone([...trends]);
      const beforeMembers = structuredClone(segment);
      const adapted = copiedSegmentMembers(segment, metadata, boundary);
      expect(adapted.member_instruments.map((row) => local(row.instrument_id))).toEqual(
        vector.expected_order,
      );
      expect([...trends]).toEqual(before);
      expect(segment).toEqual(beforeMembers);
      expect(adapted).not.toBe(segment);
      expect(adapted.member_instruments).not.toBe(segment.member_instruments);
      for (const row of adapted.member_instruments)
        expect(segment.member_instruments).not.toContain(row);
      if (vector.mode === "exact_tie" || vector.mode === "opposite_sign_tie")
        expect(raw.instruments.map((row) => local(row.instrumentId))).toEqual(["2", "10"]);
      if (vector.mode === "unequal_raw_same_rounded") {
        expect(segment.member_instruments[0]?.return_1w).toBe(
          segment.member_instruments[1]?.return_1w,
        );
        expect(raw.instruments.map((row) => local(row.instrumentId))).toEqual(["2", "10"]);
      }
      expect(() =>
        copiedSegmentMembers(
          { ...segment, member_instruments: segment.member_instruments.slice(1) },
          metadata,
          boundary,
        ),
      ).toThrow(/coverage/);
      expect(() =>
        copiedSegmentMembers(
          {
            ...segment,
            member_instruments: segment.member_instruments.map(
              () => segment.member_instruments[0]!,
            ),
          },
          metadata,
          boundary,
        ),
      ).toThrow(/coverage/);
      expect(() =>
        copiedSegmentMembers(segment, metadata, {
          vault: { ...boundary.vault, sources: new Map() },
        }),
      ).toThrow(/identity/);
      expect(() =>
        copiedSegmentMembers(segment, metadata, {
          vault: {
            ...boundary.vault,
            sources: new Map([...sources].map(([id, row]) => [id, { ...row, table: "accounts" }])),
          },
        }),
      ).toThrow(/table/);
    }),
  );
  it.each(fixture.topic_variants)(
    "preserves Python topic-thesis Canon behavior: $mode $lang",
    (variant) =>
      run((db) => {
        const source = nativeViewSources(db).find((row) => row.profile.id === 1);
        if (source === undefined) throw new Error("synthetic topic profile is absent");
        const result = investmentsViews.readReviewDigest(source.vault.store, {
          ...source.request,
          lang: variant.lang,
          macroCloses: source.macroCloses,
        });
        if (!result.ok) throw new Error("synthetic topic digest was refused");
        const segments = result.value.research.segments;
        if (!Array.isArray(segments)) throw new Error("synthetic segments are absent");
        const thesis = segments
          .map((segment) => segment.thesis)
          .find((row) => row?.segment === "equity_global");
        expect(thesis?.id).toBe(copiedSourceGid(source, "inv_topic_theses", variant.topic_id));
        if (variant.mode === "collision") {
          expect(thesis.id).not.toBe(copiedSourceGid(source, "inv_theses", variant.topic_id));
        }
        // The general guard still rejects this table mismatch without the declared producer adapter.
        expect(() =>
          viewOutput(
            { research: { segments: [{ thesis: { id: thesis.id } }] } },
            db,
            source.vault,
            {
              floatPaths: [],
              bareIdTable: "inv_signals",
            },
          ),
        ).toThrow(/reference table differs/);
        const before = db.keys.dangling;
        expect(db.keys.key("inv_theses", variant.topic_id)).toBe(variant.topic_key);
        expect(db.keys.dangling - before).toBe(variant.topic_dangling_refs);
        expect(variant.topic_dangling_refs).toBe(variant.mode === "missing" ? 1 : 0);
        const wire = dumps(produceReviewDigest(db, variant.lang));
        expect(wire).toBe(variant.expected_bytes);
        if (variant.lang === "pl") {
          const selected = db.investmentsViews.valuationDetails(1, 2);
          expect(selected?.pe).toBe(12);
          expect(selected?.forward_pe).toBe(12n);
          expect(db.investmentsViews.valuationDetails(2, 2)).toBeNull();
          const valuation = segments
            .map((segment) => segment.valuation)
            .find((row) => row?.note_id);
          expect(valuation?.note_id).toBe(copiedSourceGid(source, "research_notes", 2));
          expect(valuation?.note_id).not.toBe(copiedSourceGid(source, "research_notes", 3));
          expect(valuation?.basis).toBe("00000000-0000-8000-8000-000000000123");
          expect(wire).toContain('"pe":12.0');
          expect(wire).toContain('"forward_pe":12');
          expect(wire).not.toContain('"forward_pe":12.0');
        }
        // Positive full-check dangling metadata is compatibility evidence, not a valid-oracle claim.
        expect(variant.check_dangling_refs).toBeGreaterThanOrEqual(variant.topic_dangling_refs);
      }, variant),
  );
  for (const [name, produce] of Object.entries(providers))
    it(name, () =>
      run((db) => {
        const actual = dumps(produce(db)),
          expected = fixture.expected_bytes[name];
        if (expected === undefined) throw new Error("synthetic check oracle is absent");
        if (actual !== expected)
          console.warn(
            `synthetic view mismatch paths ${name}: ${JSON.stringify(mismatchPaths(actual, expected))}`,
          );
        expect(actual, name).toBe(expected);
      }),
    );
  it("keeps the copied raw-alert boundary separate from effective production facts", () =>
    run((db) => {
      const source = nativeViewSources(db).find((row) => row.profile.id === 1);
      if (source === undefined) throw new Error("synthetic profile is absent");
      const production = investmentsViews.portfolioViewInputs(
        source.vault.store.read.bind(source.vault.store),
        source.request,
      );
      if (!production.ok) throw new Error("synthetic input was refused");
      const copied = copiedProjectionInput(db, source);
      expect(production.value.facts.alerts[0]?.status).toBe("expired");
      expect(copied.facts.alerts[0]?.status).toBe("triggered");
      const holding = copied.state.valued.valued[0];
      if (holding === undefined) throw new Error("synthetic held position is absent");
      expect(source.marketData.data.series(holding.instrument.id)[0]?.source).toBe("synthetic_raw");
      expect(db.investmentsViews.newestRateDate()).toBe("2026-10-03");
      expect(nativeViewSources(db)).toHaveLength(2);
    }));
  it("matches the actual unlabelled deck and DATE wire rule in both explicit languages", () =>
    run((db) => {
      for (const vector of fixture.contexts) {
        const source = nativeViewSources(db).find((row) => row.profile.id === vector.profile);
        if (source === undefined) throw new Error("synthetic context profile is absent");
        const calendar: inv.market.CalendarView = {
          as_of: db.asOf,
          from: db.asOf,
          to: "2026-10-15",
          fetched_at: null,
          errors: [],
          ...vector.calendar,
        };
        const value = investmentsViews.readReviewContext(
          source.vault.store.read.bind(source.vault.store),
          {
            clock: investmentsViews.makeReviewClock(source.clock),
            lang: vector.lang,
            config: source.strategy.config,
            calendar,
          },
        );
        expect(JSON.parse(dumps(viewOutput(value, db, source.vault, { floatPaths: [] })))).toEqual(
          vector.expected,
        );
      }
    }));
  it("keeps the production research-run identity correct when legacy run/signal counters coincide", () =>
    run((db) => {
      const source = nativeViewSources(db).find((row) => row.profile.id === 1);
      if (source === undefined) throw new Error("synthetic profile is absent");
      const result = investmentsViews.readReviewDigest(source.vault.store, {
        ...source.request,
        macroCloses: source.macroCloses,
      });
      if (!result.ok) throw new Error("synthetic digest was refused");
      const run = result.value.research.run;
      if (typeof run !== "object" || run === null || !("id" in run))
        throw new Error("synthetic research run is absent");
      expect(run.id).toBe(copiedSourceGid(source, "research_runs", 1));
      expect(run.id).not.toBe(copiedSourceGid(source, "inv_signals", 1));
      expect(result.value.events.find((event) => event.type === "data_warning")?.run_id).toBe(
        copiedSourceGid(source, "inv_rule_runs", 2),
      );
      const market = result.value.research.market;
      if (
        market === null ||
        typeof market !== "object" ||
        !("stale" in market) ||
        !Array.isArray(market.stale)
      )
        throw new Error("synthetic native market digest is absent");
      expect(market.stale.every((gid) => typeof gid === "string")).toBe(true);
      expect(market.stale).toEqual([...market.stale].sort());
    }));
  it("renders only declared warning references and preserves unrelated authored GID text", () =>
    run((db) => {
      const source = nativeViewSources(db).find((row) => row.profile.id === 1);
      if (source === undefined) throw new Error("synthetic profile is absent");
      const authored = copiedSourceGid(source, "inv_instruments", 1);
      const warning = {
        ...inv.invalidTransaction({
          accountId: inv.asAccountId(copiedSourceGid(source, "accounts", 1)),
          txnId: inv.asTxnId(copiedSourceGid(source, "inv_transactions", 2)),
          date: "2026-10-01",
          reason: `Unrelated authored context ${authored}`,
        }),
        context: { untouched: authored },
      };
      const message = copiedWarningMessage(warning, source);
      expect(message).toBe(
        `Ignored transaction 2 on 2026-10-01 for lots: Unrelated authored context ${authored}`,
      );
      expect(warning.context.untouched).toBe(authored);
      expect(warning.txnId).toBe(copiedSourceGid(source, "inv_transactions", 2));
    }));
});
