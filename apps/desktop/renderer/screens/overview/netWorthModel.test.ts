import { type core, D } from "@cashu/domain";
import { setLanguageForTests } from "@cashu/i18n";
import { beforeEach, describe, expect, it } from "vitest";
import { type NetWorthUi, netWorthModel } from "./netWorthModel.js";
import type { Rich } from "./overviewModel.js";

beforeEach(() => setLanguageForTests("en"));

const noop = () => {};
const ui: NetWorthUi = {
  mode: "line",
  setMode: noop,
  scope: "total",
  setScope: noop,
  step: "monthly",
  setStep: noop,
  range: null,
  setRange: noop,
};
const MONEY: core.SeriesComponent = { key: "money", label: "Money", liability: false };
const PROPERTY: core.SeriesComponent = { key: "property", label: "Property", liability: false };
const CAR: core.SeriesComponent = { key: "vehicle", label: "Car", liability: false };

function view(
  points: [string, string][],
  opts: { components?: core.SeriesComponent[]; completeFrom?: string | null } = {},
): core.SeriesView {
  return {
    currency: "PLN",
    points: points.map(([date, value]) => ({
      date,
      value: D(value),
      components: { money: D(value) },
    })),
    components: opts.components ?? [MONEY],
    completeFrom: opts.completeFrom ?? null,
  };
}
// Formatted amounts carry no-break spaces; compare them as plain spaces.
const text = (r: Rich) =>
  r
    .map((run) => run.text)
    .join("")
    .replace(/\s/g, " ");

describe("netWorthModel: property variants", () => {
  it("no property, car or loan: no scope choice and no second footer fact", () => {
    const s = view([
      ["2025-11-30", "100000"],
      ["2026-11-09", "120000"],
    ]);
    const m = netWorthModel({ series: s, total: s, liquid: s, ui });
    expect(m.scope).toBeNull();
    expect(m.foot.map(text)).toEqual(["12 mo. +PLN 20,000 (+20.0%)"]);
  });

  it("names what the total holds beyond the accounts", () => {
    const total = view(
      [
        ["2025-11-30", "700000"],
        ["2026-11-09", "720000"],
      ],
      { components: [MONEY, PROPERTY, CAR] },
    );
    const liquid = view([
      ["2025-11-30", "100000"],
      ["2026-11-09", "120000"],
    ]);
    const m = netWorthModel({ series: total, total, liquid, ui });
    expect(m.scope?.options.map((o) => o.label)).toEqual([
      "Total: accounts, property, car",
      "Liquid (accounts only)",
    ]);
    expect(m.foot.map(text)[1]).toBe("accounts only +20.0%");
  });
});

describe("netWorthModel: a history that is not whole yet", () => {
  // Before 08-11 only an old account is known; the Open Banking accounts start there.
  const s = view(
    [
      ["2026-07-31", "28000"],
      ["2026-08-31", "140000"],
      ["2026-09-30", "145000"],
      ["2026-10-31", "150000"],
      ["2026-11-09", "152000"],
    ],
    { completeFrom: "2026-08-11" },
  );

  it("draws and measures from the first whole point, and says the history starts there", () => {
    const m = netWorthModel({ series: s, total: s, liquid: s, ui });
    expect(m.chart?.kind === "line" && m.chart.values).toEqual([140000, 145000, 150000, 152000]);
    const foot = m.foot.map(text);
    expect(foot[0]).toBe("12 mo. +PLN 12,000 (+8.6%)");
    expect(foot[1]).toMatch(/^history from Aug 11, 2026: before that some accounts have no data$/);
  });

  it("with fewer than two whole points there is no chart, only why", () => {
    const short = view(
      [
        ["2026-07-31", "28000"],
        ["2026-11-09", "152000"],
      ],
      { completeFrom: "2026-11-09" },
    );
    const m = netWorthModel({ series: short, total: short, liquid: short, ui });
    expect(m.chart).toBeNull();
    expect(m.foot).toEqual([]);
    expect(m.empty).toMatch(/^History too short: some accounts have data only from Nov 9, 2026\./);
  });
});
