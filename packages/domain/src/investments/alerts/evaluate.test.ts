/** Every alert kind fires, stays quiet or skips on invented series; a failing alert never throws. */
import { describe, expect, it } from "vitest";
import { addDays } from "../../dates.js";
import { D } from "../../decimal.js";
import { InstrumentStatus, type PriceBar, priceBar } from "../domain/index.js";
import type { RuleContext } from "../rules/index.js";
import * as f from "../rules/testing/fixtures.js";
import { evaluateAlert } from "./evaluate.js";
import type { AlertCheck, AlertDefinition, AlertKind, AlertScope } from "./types.js";

const SYN = f.instrument("SYN");

function check(
  kind: AlertKind,
  params: Record<string, unknown>,
  closes: readonly string[],
  options: {
    scope?: AlertScope;
    bars?: readonly PriceBar[];
    ctx?: RuleContext | null;
    instrument?: AlertDefinition["instrument"];
    maxAge?: number;
    lang?: "pl" | "en";
  } = {},
): AlertCheck {
  const inst = options.instrument === undefined ? SYN : options.instrument;
  const definition: AlertDefinition = {
    id: "a1",
    kind,
    scope: options.scope ?? "instrument",
    params,
    title: "Synthetic alert",
    severity: "action",
    polarity: "negative",
    instrument: inst,
  };
  return evaluateAlert(definition, {
    asOf: f.AS_OF,
    bars: new Map([[SYN.id, options.bars ?? f.bars(SYN, closes)]]),
    maxPriceAgeDays: options.maxAge ?? 5,
    ctx: options.ctx ?? null,
    lang: options.lang ?? "en",
  });
}

const type = (result: AlertCheck) => result.outcome.type;
const reason = (result: AlertCheck): string =>
  result.outcome.type === "skipped" ? result.outcome.reason : "";
const value = (result: AlertCheck) => result.value?.toString() ?? null;

describe("close and window kinds", () => {
  it("price levels are strict and the fired signal carries the alert identity", () => {
    const hit = check("price_above", { level: 100 }, ["90", "101"]);
    expect(type(hit)).toBe("fired");
    expect(value(hit)).toBe("101");
    if (hit.outcome.type !== "fired") throw new Error("not fired");
    expect(hit.outcome.candidate).toMatchObject({
      ruleId: "alert:a1",
      dedupKey: "alert:a1",
      kind: "alert:price_above",
      severity: "action",
      polarity: "negative",
      instrumentId: SYN.id,
      message: `Synthetic alert: SYN: close 101 PLN (${f.AS_OF}), above 100 PLN.`,
    });
    expect(hit.outcome.candidate.payload).toMatchObject({ level: "100", close: "101" });
    expect(type(check("price_above", { level: 101 }, ["101"]))).toBe("not_fired");
    expect(type(check("price_below", { level: 100 }, ["99"]))).toBe("fired");
    expect(type(check("price_below", { level: 100 }, ["100"]))).toBe("not_fired");
  });

  it("change_pct compares the window's first and last close, a move of exactly the threshold fires", () => {
    const up = ["100", "50", "110"];
    expect(type(check("change_pct", { window_days: 2, threshold: 0.1 }, up))).toBe("fired");
    expect(value(check("change_pct", { window_days: 2, threshold: 0.1 }, up))).toBe("0.1");
    expect(
      type(check("change_pct", { window_days: 2, threshold: 0.1, direction: "down" }, up)),
    ).toBe("not_fired");
    const down = ["100", "100", "89"];
    expect(
      type(check("change_pct", { window_days: 2, threshold: 0.1, direction: "down" }, down)),
    ).toBe("fired");
    expect(type(check("change_pct", { window_days: 2, threshold: 0.12 }, down))).toBe("not_fired");
  });

  it("drawdown_from_high measures from the window high, exactly the threshold fires", () => {
    const hit = check("drawdown_from_high", { window_days: 3, threshold: 0.2 }, [
      "100",
      "120",
      "96",
    ]);
    expect([type(hit), value(hit)]).toEqual(["fired", "0.2"]);
    // the 200 before the window does not count
    expect(
      type(
        check("drawdown_from_high", { window_days: 3, threshold: 0.2 }, [
          "200",
          "100",
          "120",
          "97",
        ]),
      ),
    ).toBe("not_fired");
  });

  it("new_high needs a close above every earlier close of the window, a tie is not new", () => {
    expect(type(check("new_high", { window_days: 3 }, ["100", "105", "106"]))).toBe("fired");
    expect(type(check("new_high", { window_days: 3 }, ["100", "106", "106"]))).toBe("not_fired");
  });

  it("sma_cross compares the last close with the window average (stored to 4 places)", () => {
    const closes = ["9", "10", "12"];
    const above = check("sma_cross", { window_days: 3, direction: "above" }, closes);
    expect(type(above)).toBe("fired");
    if (above.outcome.type !== "fired") throw new Error("not fired");
    expect(above.outcome.candidate.payload).toMatchObject({ sma: "10.3333" });
    expect(type(check("sma_cross", { window_days: 3, direction: "below" }, closes))).toBe(
      "not_fired",
    );
  });
});

describe("range breakout and volume spike", () => {
  const range = [...Array(10)].map((_, i) => (i % 2 === 0 ? "100" : "105"));

  it("a close out of a tight range breaks out in its direction; a wide range never does", () => {
    const params = { window_days: 10, max_range_pct: 0.08 };
    const hit = check("range_breakout", params, [...range, "106"]);
    expect(type(hit)).toBe("fired");
    if (hit.outcome.type !== "fired") throw new Error("not fired");
    expect(hit.outcome.candidate.payload).toMatchObject({
      range_low: "100",
      range_high: "105",
      direction: "any",
    });
    expect(type(check("range_breakout", { ...params, direction: "down" }, [...range, "106"]))).toBe(
      "not_fired",
    );
    expect(type(check("range_breakout", params, [...range, "104"]))).toBe("not_fired");
    const wide = [...range.slice(0, 9), "120"];
    expect(type(check("range_breakout", params, [...wide, "121"]))).toBe("not_fired");
  });

  const withVolumes = (volumes: readonly (number | null)[]): PriceBar[] =>
    volumes.map((volume, i) =>
      priceBar({
        instrumentId: SYN.id,
        date: addDays(f.AS_OF, -(volumes.length - 1 - i)),
        close: D("10"),
        volume,
        source: "test",
      }),
    );

  it("volume_spike compares the last volume with the average of the earlier sessions", () => {
    const params = { window_days: 5, multiple: 2.5 };
    const hit = check("volume_spike", params, [], {
      bars: withVolumes([100, 100, 100, 100, 100, 250]),
    });
    expect([type(hit), value(hit)]).toEqual(["fired", "2.5"]);
    expect(
      type(
        check("volume_spike", params, [], { bars: withVolumes([100, 100, 100, 100, 100, 200]) }),
      ),
    ).toBe("not_fired");
    expect(
      reason(
        check("volume_spike", params, [], { bars: withVolumes([100, null, 100, 100, 100, 300]) }),
      ),
    ).toContain("No volume in the window");
    expect(
      reason(check("volume_spike", params, [], { bars: withVolumes([0, 0, 0, 0, 0, 300]) })),
    ).toContain("Zero average volume");
  });
});

describe("weights and custom expressions", () => {
  const held = f.context({
    portfolioValue: f.portfolio([f.h(SYN, { value: "1000" })], { cash: "1000" }),
    allocations: [
      f.alloc("equity", { weight: 0.7, target: 0.6 }),
      f.alloc("gap", { weight: 0.1, target: 0.1, cashHistoryGap: true }),
    ],
  });

  it("an instrument weight above or below the threshold; not held counts as zero", () => {
    expect([
      type(check("weight_above", { threshold: 0.4 }, [], { ctx: held })),
      value(check("weight_above", { threshold: 0.4 }, [], { ctx: held })),
    ]).toEqual(["fired", "0.5"]);
    expect(type(check("weight_below", { threshold: 0.6 }, [], { ctx: held }))).toBe("fired");
    expect(type(check("weight_above", { threshold: 0.5 }, [], { ctx: held }))).toBe("not_fired");
    const other = check("weight_above", { threshold: 0.1 }, [], {
      ctx: held,
      instrument: f.instrument("OTHER"),
    });
    expect(type(other)).toBe("not_fired");
    if (other.outcome.type !== "not_fired") throw new Error("fired");
    expect(other.outcome.details).toMatchObject({ held: false, weight: 0 });
  });

  it("a bucket weight reads the allocation; a missing bucket or a cash history gap skips", () => {
    const bucket = (name: string) =>
      check("weight_above", { threshold: 0.65, bucket: name }, [], {
        scope: "bucket",
        ctx: held,
        instrument: null,
      });
    expect(type(bucket("equity"))).toBe("fired");
    expect(reason(bucket("bonds"))).toContain("(is it in the strategy?)");
    expect(reason(bucket("gap"))).toContain("Incomplete cash history");
  });

  it("a custom expression runs through the rule machinery under the alert's identity", () => {
    const hit = check("custom", { expression: "cash_weight > 40%" }, [], {
      scope: "portfolio",
      ctx: held,
      instrument: null,
    });
    expect(type(hit)).toBe("fired");
    if (hit.outcome.type !== "fired") throw new Error("not fired");
    expect(hit.outcome.candidate).toMatchObject({
      ruleId: "alert:a1",
      dedupKey: "alert:a1",
      kind: "alert:custom",
      polarity: "negative",
    });
    expect(hit.outcome.candidate.message.startsWith("Synthetic alert: ")).toBe(true);
    expect(
      type(
        check("custom", { expression: "cash_weight > 60%" }, [], {
          scope: "portfolio",
          ctx: held,
          instrument: null,
        }),
      ),
    ).toBe("not_fired");
  });

  it("portfolio kinds skip without a valued portfolio", () => {
    expect(reason(check("weight_above", { threshold: 0.4 }, []))).toBe(
      "The portfolio could not be valued",
    );
  });
});

describe("skips", () => {
  const above = { level: 1 };

  it("missing, stale, short, invalid or unpriceable data skips instead of resolving", () => {
    expect(reason(check("price_above", above, [], { instrument: null }))).toBe(
      "The alert has no instrument",
    );
    expect(reason(check("price_above", above, []))).toContain("No prices: SYN");
    const stale = f.bars(SYN, ["10"], addDays(f.AS_OF, -6));
    expect(type(check("price_above", above, [], { bars: stale }))).toBe("skipped");
    expect(type(check("price_above", above, [], { bars: stale, maxAge: 6 }))).toBe("fired");
    expect(type(check("new_high", { window_days: 3 }, ["10", "11"]))).toBe("skipped");
    expect(reason(check("new_high", { window_days: 3 }, ["10", "0", "11"]))).toContain(
      "Invalid prices in the window",
    );
    const delisted = { ...SYN, status: InstrumentStatus.DELISTED };
    expect(reason(check("price_above", above, ["10"], { instrument: delisted }))).toBe(
      "SYN: delisted, no current prices",
    );
  });

  it("bars after asOf are ignored", () => {
    const future = f.bars(SYN, ["10", "500"], addDays(f.AS_OF, 1));
    expect(value(check("price_above", { level: 100 }, [], { bars: future }))).toBe("10");
  });

  it("a broken stored alert becomes Skipped, never an exception", () => {
    const broken = check("price_above", { level: "not a number" }, ["10"]);
    expect(reason(broken).startsWith("Alert failed: ")).toBe(true);
    const badExpression = check("custom", { expression: "cash_weight >" }, [], {
      scope: "portfolio",
      ctx: f.context(),
      instrument: null,
    });
    expect(reason(badExpression).startsWith("Alert failed: ")).toBe(true);
  });
});
