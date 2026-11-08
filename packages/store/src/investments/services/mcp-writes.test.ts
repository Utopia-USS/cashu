/** Actual store mutation and derived-state proofs; synthetic profiles only. */
import { parseDateTime } from "@cashu/domain";
import { asInstrumentId, asProfileId, market } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { defineCommand, ok } from "../../command.js";
import { createProfile } from "../../core/commands.js";
import {
  createInstrument,
  setInstrumentPlan,
  setInstrumentStrength,
} from "../commands/instruments.js";
import { createThesis, updateThesis } from "../commands/journal.js";
import { addManualTransaction } from "../commands/manual.js";
import { applyPlanChecks } from "../commands/planSignals.js";
import { addToWatchlist } from "../commands/watchlist.js";
import { allInstruments, loadInstrument } from "../queries/instruments.js";
import { theses } from "../queries/journal.js";
import { openSignals } from "../queries/signals.js";
import { added, investor, TODAY } from "../research/testing/fixtures.js";
import { portfolioAt } from "../views/portfolio.js";
import {
  addStoredWatchWithPlans,
  addWatchWithPlans,
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
const strong = { strength: "strong", basis: "on_track" } as const;
const neutral = { strength: "neutral", basis: "no_progress" } as const;
const fulfilled = { strength: "weak", basis: "fulfilled" } as const;
describe("MCP local investment mutation composition", () => {
  it("keeps a new watched instrument and its prospective plan signal in one real batch", async () => {
    const h = await fixture();
    const planned = {
      name: "Synthetic pending listing",
      currency: "PLN",
      assetClass: "equity",
      symbol: "NEWP",
      mic: "XWAR",
      needsClassification: true,
      aliases: [{ namespace: "yahoo", value: "NEWP.WA", guessed: false }],
    };
    const base = h.v.run(addWatchWithPlans(h.inputs), {
      target: { planned, yahooSymbol: "NEWP.WA" },
      source: "user",
    });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(base.value.createdInstrument).toBe(true);
    expect(loadInstrument(h.read, base.value.instrument)?.id).toBe(base.value.instrument);

    const prospective = defineCommand({
      id: "test.pendingPlanSignal",
      input: addToWatchlist.input,
      run(ctx, input) {
        const saved = addToWatchlist.run(ctx, input);
        if (!saved.ok) return saved;
        const id = asInstrumentId(saved.value.instrument);
        const derived = applyPlanChecks(ctx, {
          facts: [
            {
              instrumentId: id,
              label: "Synthetic pending thesis",
              symbol: "NEWQ",
              plan: "buy",
              health: "invalidated",
              hasExitPlan: true,
              unrealized: null,
              held: false,
            },
          ],
          now: parseDateTime(ctx.now()),
          run: null,
          config: h.inputs.config,
          lang: "en",
          only: id,
          pendingCanonical: new Set([id]),
        });
        return derived.ok ? ok(saved.value) : derived;
      },
    });
    const out = h.v.run(prospective, {
      target: {
        planned: {
          ...planned,
          symbol: "NEWQ",
          aliases: [{ namespace: "yahoo", value: "NEWQ.WA", guessed: false }],
        },
        yahooSymbol: "NEWQ.WA",
      },
      source: "user",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.events.map((event) => event.type)).toContain("signal.opened");
    expect(
      openSignals(h.read).some(
        (signal) =>
          signal.instrument === out.value.instrument && signal.ruleId === "plan:plan_vs_thesis",
      ),
    ).toBe(true);
  });
  it("refuses incomplete or duplicate coverage before any recommendation changes", async () => {
    const h = await fixture(),
      before = allInstruments(h.read).map((i) => [i.id, i.plan]);
    const out = h.v.run(recommendWithPlans(), {
      today: TODAY,
      scope: "held",
      updates: [{ instrument: h.abc, ...strong, plan: "buy", reason: "Changed source facts" }],
    });
    expect(out).toEqual({ ok: false, reason: "incomplete_coverage" });
    expect(allInstruments(h.read).map((i) => [i.id, i.plan])).toEqual(before);
    expect(
      h.v.run(recommendWithPlans(), {
        today: TODAY,
        scope: null,
        updates: [
          { instrument: h.abc, ...strong, plan: "buy", reason: "First" },
          { instrument: h.abc, ...strong, plan: "hold", reason: "Second" },
        ],
      }),
    ).toEqual({ ok: false, reason: "duplicate_instrument" });
    expect(allInstruments(h.read).map((i) => [i.id, i.plan])).toEqual(before);
  });
  it("refuses held-only plans off a held position and instruments the vault does not reference", async () => {
    const h = await fixture();
    const run = (instrument: string, plan: string) =>
      h.v.run(recommendWithPlans(), {
        today: TODAY,
        scope: null,
        updates: [{ instrument, ...neutral, plan, reason: "Synthetic view" }],
      });
    const unreferenced = h.v.value(createInstrument, {
      name: "Unreferenced",
      currency: "USD",
      assetClass: "equity",
    }).gid;
    expect(run(unreferenced, "hold")).toEqual({ ok: false, reason: "no_instrument" });
    const watched = h.v.value(createInstrument, {
      name: "Watched",
      currency: "EUR",
      assetClass: "etf",
    }).gid;
    h.v.value(addToWatchlist, { target: { stored: watched } });
    for (const plan of ["reduce", "exit_asap"])
      expect(run(watched, plan)).toEqual({ ok: false, reason: "needs_held" });
    expect(run(watched, "buy").ok).toBe(true);
    h.v.value(addManualTransaction, {
      account: h.account,
      instrument: h.abc,
      type: "sell",
      tradeDate: "2026-02-20",
      quantity: "100",
      price: "60",
    });
    expect(run(h.abc, "reduce")).toEqual({ ok: false, reason: "needs_held" });
    expect(run(h.abc, "hold").ok).toBe(true);
    expect(loadInstrument(h.read, h.abc)?.plan).toBe("hold");
  });

  it("coverage counts the strength: a stored plan alone is missing, a stored strength covers", async () => {
    const h = await fixture();
    h.v.value(setInstrumentPlan, { instrument: h.xmpl, plan: "hold", held: true });
    const batch = {
      today: TODAY,
      scope: "held" as const,
      updates: [
        { instrument: h.abc, ...strong, plan: "buy" as const, reason: "Current view" },
        { instrument: h.wrld, ...neutral, reason: "Current view" },
      ],
    };
    expect(h.v.run(recommendWithPlans(), batch)).toEqual({
      ok: false,
      reason: "incomplete_coverage",
    });
    h.v.value(setInstrumentStrength, {
      instrument: h.xmpl,
      strength: "neutral",
      basis: "no_progress",
      reason: "Earlier view",
    });
    const out = h.v.run(recommendWithPlans(), batch);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toMatchObject({ expected: 3, updated: 2 });
    expect(out.value.saved.map((row) => [row.strength, row.basis, row.plan])).toEqual([
      ["strong", "on_track", "buy"],
      ["neutral", "no_progress", null],
    ]);
    // wrld had no plan: a strength-only row clears nothing and writes no planSet
    expect(out.events.map((e) => e.type)).toEqual([
      "instrumentOverride.strengthSet",
      "instrumentOverride.planSet",
      "instrumentOverride.strengthSet",
    ]);
    expect(out.events[0]?.data).toMatchObject({
      strength: "strong",
      basis: "on_track",
      reason: "Current view",
    });
    const abc = loadInstrument(h.read, h.abc);
    expect([abc?.positionStrength, abc?.strengthBasis, abc?.strengthReason]).toEqual([
      "strong",
      "on_track",
      "Current view",
    ]);
    expect(abc?.strengthAt).not.toBeNull();
    expect(abc?.planReason).toBe("Current view");
    // omitted rows keep their stored opinion
    expect(loadInstrument(h.read, h.xmpl)?.plan).toBe("hold");
    expect(loadInstrument(h.read, h.xmpl)?.positionStrength).toBe("neutral");
  });
  it("a strength-only row clears an older recommendation of the instrument", async () => {
    const h = await fixture();
    h.v.value(setInstrumentPlan, { instrument: h.abc, plan: "buy", held: true, reason: "Old" });
    const out = h.v.run(recommendWithPlans(), {
      today: TODAY,
      scope: null,
      updates: [{ instrument: h.abc, strength: "weak", basis: "undermined", reason: "New view" }],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(
      out.events.map((e) => [e.type, "plan" in e.data ? e.data.plan : e.data.strength]),
    ).toEqual([
      ["instrumentOverride.strengthSet", "weak"],
      ["instrumentOverride.planSet", null],
    ]);
    const abc = loadInstrument(h.read, h.abc);
    expect([abc?.plan, abc?.planReason, abc?.positionStrength]).toEqual([null, null, "weak"]);
  });
  it("refuses strength rows that contradict the basis, the recommendation or the thesis", async () => {
    const h = await fixture();
    const before = allInstruments(h.read).map((i) => [i.id, i.plan, i.positionStrength]);
    const run = (row: Record<string, unknown>, instrument = h.abc) =>
      h.v.run(recommendWithPlans(), {
        today: TODAY,
        scope: null,
        updates: [{ instrument, reason: "Synthetic view", ...row }],
      });
    expect(run({ strength: "strong", basis: "fulfilled" })).toEqual({
      ok: false,
      reason: "strength_vs_basis",
    });
    expect(run({ strength: "weak", basis: "on_track" })).toEqual({
      ok: false,
      reason: "strength_vs_basis",
    });
    expect(run({ strength: "weak", basis: "undermined", plan: "buy" })).toEqual({
      ok: false,
      reason: "plan_vs_strength",
    });
    expect(run({ strength: "strong", basis: "on_track", plan: "exit_asap" })).toEqual({
      ok: false,
      reason: "plan_vs_strength",
    });
    expect(run({ basis: "on_track" })).toEqual({ ok: false, reason: "invalid_input" });
    expect(run({ strength: "strong" })).toEqual({ ok: false, reason: "invalid_input" });
    expect(run({ strength: "strong", basis: "on_track", reason: "  " })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    h.v.value(createThesis, { instrument: h.abc, entryType: "trend", thesis: "Proposition" });
    h.v.env.advance(1000);
    added(
      h.v,
      92,
      { thesis_relation: "invalidates", thesis_field: "thesis", strength: 3 },
      { instrument: "ABC" },
    );
    expect(run({ strength: "neutral", basis: "undermined" })).toEqual({
      ok: false,
      reason: "strength_vs_thesis",
    });
    expect(allInstruments(h.read).map((i) => [i.id, i.plan, i.positionStrength])).toEqual(before);
    expect(run({ strength: "weak", basis: "undermined", plan: "hold" }).ok).toBe(true);
    // the owner rewrites the thesis: research from before the edit no longer floors the strength
    h.v.env.advance(1000);
    const id = theses(h.read, h.abc)[0]?.gid as string;
    h.v.value(updateThesis, { id, values: { thesis: "Rewritten proposition" } });
    expect(run({ strength: "neutral", basis: "no_progress" }).ok).toBe(true);
    expect(loadInstrument(h.read, h.abc)?.positionStrength).toBe("neutral");
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
        updates: [{ instrument: h.abc, ...strong, plan: "buy", reason: "Updated facts" }],
      });
      expect(out.ok).toBe(true);
      if (out.ok)
        expect(out.events.map((e) => e.type)).toEqual([
          "instrumentOverride.strengthSet",
          "instrumentOverride.planSet",
        ]);
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
      updates: [{ instrument: h.abc, ...fulfilled, plan: "hold", reason: "Retained view" }],
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
    expect(loadInstrument(h.read, h.abc)?.plan).toBe("hold");
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
      updates: [{ instrument: id, ...strong, plan: "buy", reason: "Watch view" }],
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
