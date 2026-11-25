import { asProfileId, market } from "@cashu/domain/investments";
import { expect, it } from "vitest";
import { createProfile, setModules } from "../../core/commands.js";
import { setInstrumentPlan } from "../commands/instruments.js";
import { stock, vault } from "../commands/testing/fixtures.js";
import { addToWatchlist } from "../commands/watchlist.js";
import { loadInstrument } from "../queries/instruments.js";
import { theses } from "../queries/journal.js";
import { openSignals } from "../queries/signals.js";
import { added, investor, TODAY } from "../research/testing/fixtures.js";
import { loadStrategy } from "../services/strategy.js";
import { portfolioAt } from "../views/portfolio.js";
import { classifyUiInstrument, uiThesisCommands } from "./commands.js";

function fixture() {
  const v = vault();
  v.value(createProfile, { slug: "synthetic", name: "Synthetic" });
  v.value(setModules, { moduleIds: ["investments"] });
  return v;
}

it.each(["historical", "earlier-clock", "equal-clock"] as const)(
  "uses actual postfold latest thesis for prospective plan checks (%s)",
  async (mode) => {
    const h = investor();
    const v = h.v;
    try {
      v.value(createProfile, { slug: "synthetic", name: "Synthetic" });
      v.value(setModules, { moduleIds: ["investments"] });
      const strategy = await loadStrategy(v.store, {
        read: async (name) =>
          name === "strategy.yaml" ? "version: 1\nbase_currency: PLN\n" : null,
        write: async () => {},
        exists: async () => true,
      });
      const base = uiThesisCommands();
      const older = v.value(base.create, {
        instrument: h.abc,
        entryType: "trend",
        thesis: "Older",
        exitPlan: "Old exit",
      });
      v.env.advance(1000);
      const latest = v.value(base.create, {
        instrument: h.abc,
        entryType: "trend",
        thesis: "Current",
        exitPlan: "Current exit",
      });
      v.value(setInstrumentPlan, { instrument: h.abc, plan: "buy", held: true });
      added(
        v,
        91,
        { thesis_relation: "fulfills", thesis_field: "thesis", strength: 2 },
        { instrument: "ABC" },
      );
      const commands = uiThesisCommands({
        vault: v.store.vault,
        config: strategy.config,
        lang: "en",
        isHolder: (vault) => vault === v.store.vault,
        buildValued(read) {
          const result = portfolioAt(read, {
            vault: asProfileId(v.store.vault),
            asOf: TODAY,
            strategy,
            lang: "en",
            prices: new market.InMemoryPriceCache(),
          });
          if (!result.ok) throw new Error(result.reason);
          return result.value.valued;
        },
      });
      let expected = latest.thesis;
      if (mode === "historical")
        v.value(commands.update, { id: older.thesis, values: { exitPlan: "" }, reviewed: true });
      else {
        if (mode === "earlier-clock") v.env.advance(-1000);
        const created = v.value(commands.create, {
          instrument: h.abc,
          entryType: "trend",
          thesis: "Distinct new thesis",
        });
        if (mode === "equal-clock") expected = created.thesis;
      }
      expect(theses(h.read, h.abc)[0]?.gid).toBe(expected);
      expect(
        openSignals(h.read).filter(
          (signal) => signal.instrument === h.abc && signal.ruleId === "plan:plan_no_exit",
        ).length,
      ).toBe(mode === "equal-clock" ? 1 : 0);
    } finally {
      v.store.close();
    }
  },
);

it("preserves classification key presence and atomically refuses after a valid segment effect", () => {
  const v = fixture();
  try {
    const instrument = stock(v, "AAA", "PL0000000AAA", { needsClassification: true });
    v.value(addToWatchlist, { target: { stored: instrument } });
    const other = stock(v, "BBB", "PL0000000BBB", {
      aliases: [{ namespace: "yahoo", value: "OWNED" }],
    });
    expect(other).not.toBe(instrument);
    expect(v.run(classifyUiInstrument, { instrument, patch: { segment: null } }).ok).toBe(true);
    expect(loadInstrument(v.store.read.bind(v.store), instrument)?.needsClassification).toBe(true);
    expect(v.run(classifyUiInstrument, { instrument, patch: { tags: null } }).ok).toBe(true);
    expect(loadInstrument(v.store.read.bind(v.store), instrument)?.needsClassification).toBe(false);
    const before = loadInstrument(v.store.read.bind(v.store), instrument);
    const result = v.run(classifyUiInstrument, {
      instrument,
      patch: { segment: "energy", aliases: [{ namespace: " YAHOO ", value: "OWNED" }] },
    });
    expect(result.ok).toBe(false);
    expect(loadInstrument(v.store.read.bind(v.store), instrument)).toEqual(before);
    expect(v.run(classifyUiInstrument, { instrument, patch: {} }).ok).toBe(true);
  } finally {
    v.store.close();
  }
});
