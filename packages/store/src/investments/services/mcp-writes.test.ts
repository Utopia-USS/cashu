/** Actual store mutation and derived-state proofs; synthetic profiles only. */
import { asProfileId, market } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { createProfile } from "../../core/commands.js";
import { createInstrument, setInstrumentPlan } from "../commands/instruments.js";
import { createThesis } from "../commands/journal.js";
import { addToWatchlist } from "../commands/watchlist.js";
import { allInstruments, loadInstrument } from "../queries/instruments.js";
import { theses } from "../queries/journal.js";
import { openSignals } from "../queries/signals.js";
import { added, investor, TODAY } from "../research/testing/fixtures.js";
import { portfolioAt } from "../views/portfolio.js";
import {
  addStoredWatchWithPlans,
  recommendWithPlans,
  removeWatchWithPlans,
  upsertThesisWithPlans,
} from "./mcp-writes.js";
import type { ResearchPlanInputs } from "./research-plans.js";
import { loadStrategy } from "./strategy.js";

async function fixture() {
  const h = investor();
  h.v.value(createProfile, {
    slug: "synthetic",
    name: "Synthetic owner",
    modules: ["investments"],
  });
  const strategy = await loadStrategy(h.v.store, {
    read: async (name) => (name === "strategy.yaml" ? "version: 1\nbase_currency: PLN\n" : null),
    write: async () => {},
    exists: async () => true,
  });
  const inputs: ResearchPlanInputs = {
    vault: h.v.store.vault,
    config: strategy.config,
    lang: "en",
    isHolder: () => true,
    buildValued(read) {
      const state = portfolioAt(read, {
        vault: asProfileId(h.v.store.vault),
        asOf: TODAY,
        strategy,
        lang: "en",
        prices: new market.InMemoryPriceCache(),
      });
      if (!state.ok) throw new Error(state.reason);
      return state.value.valued;
    },
  };
  return { ...h, inputs };
}
describe("MCP local investment mutation composition", () => {
  it("refuses incomplete or duplicate coverage before any recommendation changes", async () => {
    const h = await fixture(),
      before = allInstruments(h.read).map((i) => [i.id, i.plan]);
    const out = h.v.run(recommendWithPlans(), {
      today: TODAY,
      scope: "held",
      updates: [{ instrument: h.abc, plan: "buy", reason: "Changed source facts" }],
    });
    expect(out).toEqual({ ok: false, reason: "incomplete_coverage" });
    expect(allInstruments(h.read).map((i) => [i.id, i.plan])).toEqual(before);
    expect(
      h.v.run(recommendWithPlans(), {
        today: TODAY,
        scope: null,
        updates: [
          { instrument: h.abc, plan: "buy", reason: "First" },
          { instrument: h.abc, plan: "hold", reason: "Second" },
        ],
      }),
    ).toEqual({ ok: false, reason: "duplicate_instrument" });
    expect(allInstruments(h.read).map((i) => [i.id, i.plan])).toEqual(before);
  });
  it("covers held instruments in one append and preserves omitted existing recommendations", async () => {
    const h = await fixture();
    h.v.value(setInstrumentPlan, { instrument: h.xmpl, plan: "hold", held: true });
    const out = h.v.run(recommendWithPlans(), {
      today: TODAY,
      scope: "held",
      updates: [
        { instrument: h.abc, plan: "buy", reason: "Current view" },
        { instrument: h.wrld, plan: "hold", reason: "Current view" },
      ],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toMatchObject({ expected: 3, updated: 2 });
    expect(out.events.map((e) => e.type)).toEqual([
      "instrumentOverride.planSet",
      "instrumentOverride.planSet",
    ]);
    expect(loadInstrument(h.read, h.xmpl)?.plan).toBe("hold");
  });
  it.each(["absent", "false", "throw", "lost", "compute"])(
    "keeps any-device base recommendation when optional derived pass is %s",
    async (mode) => {
      const h = await fixture();
      h.v.env.holder = false;
      let holder = true;
      const inputs =
        mode === "absent"
          ? undefined
          : {
              ...h.inputs,
              isHolder() {
                if (mode === "throw") throw new Error("synthetic authority unavailable");
                return mode !== "false" && holder;
              },
              buildValued(
                read: Parameters<ResearchPlanInputs["buildValued"]>[0],
                now: Parameters<ResearchPlanInputs["buildValued"]>[1],
              ) {
                if (mode === "compute") throw new Error("synthetic cache unavailable");
                const valued = h.inputs.buildValued(read, now);
                if (mode === "lost") holder = false;
                return valued;
              },
            };
      const out = h.v.run(recommendWithPlans(inputs), {
        today: TODAY,
        scope: null,
        updates: [{ instrument: h.abc, plan: "buy", reason: "Updated facts" }],
      });
      expect(out.ok).toBe(true);
      if (out.ok)
        expect(out.events.every((e) => e.type === "instrumentOverride.planSet")).toBe(true);
      expect(loadInstrument(h.read, h.abc)?.plan).toBe("buy");
    },
  );
  it("a prospective thesis update changes actual plan signals in the same append", async () => {
    const h = await fixture();
    h.v.value(createThesis, {
      instrument: h.abc,
      entryType: "trend",
      thesis: "Original proposition",
    });
    h.v.value(setInstrumentPlan, { instrument: h.abc, plan: "buy", held: true });
    added(
      h.v,
      91,
      { thesis_relation: "fulfills", thesis_field: "thesis", strength: 2 },
      { instrument: "ABC" },
    );
    const first = h.v.run(recommendWithPlans(h.inputs), {
      today: TODAY,
      scope: null,
      updates: [{ instrument: h.abc, plan: "buy", reason: "Retained view" }],
    });
    expect(first.ok).toBe(true);
    expect(
      openSignals(h.read).some((s) => s.instrument === h.abc && s.ruleId === "plan:plan_no_exit"),
    ).toBe(true);
    h.v.env.advance(1000);
    const out = h.v.run(upsertThesisWithPlans(h.inputs), {
      instrument: h.abc,
      values: {
        entryType: "trend",
        thesis: "Revised proposition after the disclosure",
        exitPlan: "Review at the next disclosure",
      },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.events.some((e) => e.type === "thesis.updated")).toBe(true);
    expect(out.events.some((e) => e.type === "signal.closed")).toBe(true);
    expect(
      openSignals(h.read).filter((s) => s.instrument === h.abc && s.ruleId === "plan:plan_no_exit"),
    ).toHaveLength(0);
    expect(theses(h.read, h.abc)[0]?.exitPlan).toBe("Review at the next disclosure");
    expect(theses(h.read, h.abc)[0]).toEqual(out.value.row);
    expect(loadInstrument(h.read, h.abc)?.plan).toBe("buy");
  });
  it("prospective watch removal resolves plan signals, local restore preserves absent note", async () => {
    const h = await fixture(),
      id = h.v.value(createInstrument, {
        symbol: "LOCAL",
        name: "Synthetic local",
        currency: "PLN",
        assetClass: "equity",
      }).gid;
    const first = h.v.value(addToWatchlist, { target: { stored: id }, note: "Retained note" });
    const noThesis = h.v.run(recommendWithPlans(h.inputs), {
      today: TODAY,
      scope: null,
      updates: [{ instrument: id, plan: "buy", reason: "Watch view" }],
    });
    expect(noThesis.ok).toBe(true);
    const removed = h.v.run(removeWatchWithPlans(h.inputs), { item: first.item });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.events[0]?.type).toBe("watchlist.removed");
    expect(
      openSignals(h.read).filter((s) => s.instrument === id && s.ruleId.startsWith("plan:")),
    ).toHaveLength(0);
    const restored = h.v.run(addStoredWatchWithPlans({ ...h.inputs, isHolder: () => false }), {
      instrument: id,
    });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value).toMatchObject({ restored: true, note: "Retained note" });
      expect(restored.events.map((e) => e.type)).toEqual(["watchlist.added"]);
    }
  });
});
