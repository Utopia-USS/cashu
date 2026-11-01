// Exact real-Python metric vectors on shared synthetic builders, including combined refusal paths.
import { expect, it } from "vitest";
import type { UiLang } from "../../../core/i18n.js";
import { D, Decimal } from "../../../decimal.js";
import { loadVectors } from "../../../testing/vectors.js";
import { ASSET_CLASSES, parseAssetClass } from "../../domain/enums.js";
import type { Instrument } from "../../domain/instrument.js";
import { asAccountId, toCurrency } from "../../domain/values.js";
import { DEFAULT_DATA_QUALITY } from "../kind.js";
import { positionsByInstrument } from "../positions.js";
import {
  AS_OF,
  alloc,
  bars,
  context,
  day,
  h,
  instrument,
  PLN,
  portfolio,
} from "../testing/fixtures.js";
import { METRICS } from "./catalog.js";
import { Unknown, type Value } from "./evaluator.js";
import { MetricEnv } from "./metrics.js";

interface SyntheticFixture {
  readonly holdings: readonly {
    readonly symbol: string;
    readonly asset?: string;
    readonly currency?: string;
    readonly tags?: readonly string[];
    readonly mic?: string | null;
    readonly value?: string | null;
    readonly cost?: string | null;
    readonly stale?: boolean;
    readonly manual?: boolean;
    readonly atCost?: boolean;
    readonly account?: string;
  }[];
  readonly cash?: string;
  readonly deposits?: readonly string[];
  readonly contribution?: string | null;
  readonly missingFx?: readonly string[];
  readonly cashGap?: string;
  readonly weights?: readonly ("nan" | null)[];
  readonly allocations?: readonly {
    readonly id: string;
    readonly weight: number;
    readonly target: number;
    readonly total?: number;
    readonly gap?: boolean;
  }[];
  readonly unclassified?: readonly number[];
  readonly series?: readonly {
    readonly symbol: string;
    readonly closes: readonly string[];
    readonly last?: string;
  }[];
  readonly data?: { readonly maxUnclassifiedWeight?: number };
}
type Query = [string, (number | string)[], string | null, string | null];
type Row = [string, UiLang, SyntheticFixture, Query[], unknown[]];

function build(input: SyntheticFixture, lang: UiLang) {
  const instruments = new Map<string, Instrument>();
  const specs = input.holdings.map((row) => {
    const inst = instrument(row.symbol, {
      assetClass: parseAssetClass(row.asset ?? "equity"),
      currency: toCurrency(row.currency ?? "PLN"),
      tags: row.tags ?? [],
      mic: row.mic === undefined ? "XWAR" : row.mic,
    });
    instruments.set(row.symbol, inst);
    return h(inst, row);
  });
  let value = portfolio(specs, {
    cash: input.cash ?? "0",
    deposits: (input.deposits ?? []).map(day),
    missingFxCurrencies: new Set((input.missingFx ?? []).map(toCurrency)),
    snapshotWarnings:
      input.cashGap === undefined
        ? []
        : [
            {
              kind: "cash_history_gap",
              accountId: asAccountId("account-a"),
              currency: PLN,
              amount: D(input.cashGap),
              asOf: AS_OF,
            },
          ],
  });
  if (input.weights !== undefined)
    value = {
      ...value,
      valued: value.valued.map((holding, index) =>
        input.weights?.[index] === "nan" ? { ...holding, weight: Number.NaN } : holding,
      ),
    };
  const series = new Map(
    (input.series ?? []).flatMap((row) => {
      const inst = instruments.get(row.symbol);
      return inst === undefined
        ? []
        : [[inst, bars(inst, row.closes, row.last === undefined ? AS_OF : day(row.last))] as const];
    }),
  );
  return context({
    portfolioValue: value,
    lang,
    series,
    allocations: (input.allocations ?? []).map((a) =>
      alloc(a.id, {
        weight: a.weight,
        target: a.target,
        total: a.total ?? 100000,
        cashHistoryGap: a.gap ?? false,
      }),
    ),
    unclassified: (input.unclassified ?? []).map((index) => {
      const holding = value.valued[index];
      if (holding === undefined) throw new Error("invalid synthetic holding index");
      return holding;
    }),
    data: { ...DEFAULT_DATA_QUALITY, ...input.data },
    contributions:
      input.contribution == null
        ? null
        : { monthlyAmount: D(input.contribution), dayOfMonth: null },
  });
}

function encode(value: Value): unknown {
  if (value instanceof Decimal) return ["decimal", value.toString()];
  if (value instanceof Unknown) return ["unknown", value.reasons];
  return [typeof value, value];
}

const rows = loadVectors("inv-rules-metrics").rows as readonly Row[];
it.each(rows)(
  "matches exact Python metric values and full reasons: %s / %s",
  (_name, lang, input, queries, expected) => {
    const ctx = build(input, lang);
    const positions = positionsByInstrument(ctx, {
      assetClasses: new Set(ASSET_CLASSES),
      tags: [],
      instrumentIds: new Set(),
    });
    const actual = queries.map(([name, args, symbol, bucket]) => {
      const selected = symbol === null ? null : positions.find((p) => p.label === symbol);
      if (selected === undefined) throw new Error("missing synthetic metric position");
      const env = new MetricEnv(ctx, {
        position: selected,
        bucketId: bucket,
        allocation: bucket === null ? null : ctx.allocations.find((a) => a.bucketId === bucket),
      });
      return encode(env.resolve({ name, args, column: 1 }));
    });
    expect(actual).toEqual(expected);
  },
);

it("covers every actual metric resolver in both languages", () => {
  for (const lang of ["pl", "en"] as const) {
    const covered = new Set(
      rows.filter((row) => row[1] === lang).flatMap((row) => row[3].map(([name]) => name)),
    );
    expect([...covered].sort()).toEqual([...METRICS.keys()].sort());
  }
});
