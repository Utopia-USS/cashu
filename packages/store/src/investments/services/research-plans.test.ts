import { asProfileId, market } from "@cashu/domain/investments";
import { describe, expect, it, vi } from "vitest";
import { createProfile } from "../../core/commands.js";
import { setInstrumentPlan } from "../commands/instruments.js";
import { createThesis } from "../commands/journal.js";
import { researchScreenCommands } from "../desktop-research/commands.js";
import { openSignals } from "../queries/signals.js";
import { researchNoteCommand } from "../research/commands.js";
import { noteByGid } from "../research/queries.js";
import { eventInstant, noteRanks } from "../research/rows.js";
import { added, investor, TODAY } from "../research/testing/fixtures.js";
import { healthByInstrument } from "../research/views.js";
import { portfolioAt } from "../views/portfolio.js";
import { addResearchNoteWithPlans, type ResearchPlanInputs } from "./research-plans.js";
import { loadStrategy } from "./strategy.js";

async function fixture() {
  const h = investor();
  h.v.value(createProfile, {
    slug: "synthetic",
    name: "Synthetic research",
    modules: ["investments"],
  });
  h.v.value(createThesis, {
    instrument: h.abc,
    entryType: "trend",
    thesis: "Popyt utrzymuje się przez cykl.",
  });
  h.v.value(setInstrumentPlan, { instrument: h.abc, plan: "buy", reason: null, held: true });
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
    buildValued: vi.fn((read) => {
      const state = portfolioAt(read, {
        vault: asProfileId(h.v.store.vault),
        asOf: TODAY,
        strategy,
        lang: "en",
        prices: new market.InMemoryPriceCache(),
      });
      if (!state.ok) throw new Error(state.reason);
      return state.value.valued;
    }),
  };
  const note = {
    kind: "news",
    polarity: "negative",
    strength: 2,
    thesis_relation: "invalidates",
    thesis_field: "thesis",
    title: "Zakończono program współpracy operacyjnej",
    summary: "Spółka zakończyła program współpracy, który stanowił podstawę opisanej tezy.",
    sources: [
      {
        url: "https://example.com/synthetic-disclosure",
        publisher: "Synthetic filings",
        published_at: TODAY,
      },
    ],
  };
  return { ...h, inputs, note };
}

describe("research note and immediate plan checks", () => {
  it("prospective creation ranks and health match the append despite a backdated clock", async () => {
    const h = await fixture();
    const observed = "2026-10-31T08:00:00Z";
    const first = added(h.v, 81, { observed_at: observed }, { instrument: "ABC" }).note;
    const stored = noteByGid(h.read, first);
    if (!stored) throw new Error("missing stored synthetic note");
    const at = eventInstant(new Date(h.v.env.clock.now()).toISOString());
    h.v.env.advance(-1);
    let beforeRanks: Map<string, number> | undefined;
    let beforeHealth: ReturnType<typeof healthByInstrument> | undefined;
    const out = h.v.run(
      researchNoteCommand((ctx, row) => {
        expect(row.createdAt).toBeLessThan(stored.createdAt);
        expect(row.observedAt).toBe(stored.observedAt);
        expect(() => noteRanks(ctx.read, [stored, row])).toThrow("prospective overlay");
        const pending = new Map([[row.gid, row]]);
        beforeRanks = noteRanks(ctx.read, [row, stored], pending);
        beforeHealth = healthByInstrument(ctx.read, [h.abc], at, pending);
      }),
      { note: { ...h.note, observed_at: observed }, instrument: "ABC" },
    );
    if (!out.ok) throw new Error(out.reason);
    const persisted = noteByGid(h.read, out.value.note);
    if (!persisted) throw new Error("missing appended synthetic note");
    expect([...(beforeRanks ?? [])]).toEqual([
      [first, 1],
      [persisted.gid, 2],
    ]);
    expect(noteRanks(h.read, [persisted, stored])).toEqual(beforeRanks);
    expect(healthByInstrument(h.read, [h.abc], at)).toEqual(beforeHealth);
  });

  it("uses prospective note health and emits research+plan signals in the one note append", async () => {
    const h = await fixture();
    const before = healthByInstrument(
      h.read,
      [h.abc],
      eventInstant(new Date(h.v.env.clock.now()).toISOString()),
    ).get(h.abc);
    expect(before?.health.state).not.toBe("invalidated");
    const out = h.v.run(addResearchNoteWithPlans(h.inputs), { note: h.note, instrument: "ABC" });
    if (!out.ok) throw new Error(out.reason);
    expect(out.events.some((e) => e.type === "note.added")).toBe(true);
    const signals = openSignals(h.read);
    expect(signals.some((signal) => signal.ruleId.startsWith("research:"))).toBe(true);
    expect(
      signals.some(
        (signal) => signal.ruleId === "plan:plan_vs_thesis" && signal.instrument === h.abc,
      ),
    ).toBe(true);
    expect(
      healthByInstrument(
        h.read,
        [h.abc],
        eventInstant(new Date(h.v.env.clock.now()).toISOString()),
      ).get(h.abc)?.health.state,
    ).toBe("invalidated");
    expect(out.value.row.gid).toBe(out.value.note);
    expect(noteByGid(h.read, out.value.note)?.instrument).toBe(h.abc);
  });

  it.each(["absent", "lost_after_build"])(
    "preserves base note without unauthorized derived effects: %s",
    async (mode) => {
      const h = await fixture();
      let holder = true;
      const inputs =
        mode === "absent"
          ? undefined
          : {
              ...h.inputs,
              isHolder: () => holder,
              buildValued: (
                read: Parameters<ResearchPlanInputs["buildValued"]>[0],
                now: Parameters<ResearchPlanInputs["buildValued"]>[1],
              ) => {
                const valued = h.inputs.buildValued(read, now);
                holder = false;
                return valued;
              },
            };
      const out = h.v.run(addResearchNoteWithPlans(inputs), { note: h.note, instrument: "ABC" });
      expect(out.ok).toBe(true);
      expect(
        openSignals(h.read).filter((signal) => signal.ruleId === "plan:plan_vs_thesis"),
      ).toHaveLength(0);
      if (out.ok) expect(noteByGid(h.read, out.value.note)).toBeDefined();
    },
  );

  it("does not evaluate instrument plan checks for a segment note", async () => {
    const h = await fixture();
    const out = h.v.run(addResearchNoteWithPlans(h.inputs), {
      note: { ...h.note, segment: "energy", thesis_relation: "none", thesis_field: undefined },
      instrument: null,
    });
    expect(out.ok).toBe(true);
    expect(h.inputs.buildValued).not.toHaveBeenCalled();
  });

  it("rechecks the actual prospective dismissal and restoration in the owner append", async () => {
    const h = await fixture();
    try {
      const added = h.v.value(addResearchNoteWithPlans(h.inputs), {
        note: h.note,
        instrument: "ABC",
      });
      const commands = researchScreenCommands(h.inputs);
      const before = (h.inputs.buildValued as ReturnType<typeof vi.fn>).mock.calls.length;
      const dismissed = h.v.run(commands.dismissNote, { note: added.note, lang: "en" });
      expect(dismissed.ok).toBe(true);
      expect(noteByGid(h.read, added.note)?.dismissedAt).not.toBeNull();
      expect((h.inputs.buildValued as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        before,
      );
      const after = (h.inputs.buildValued as ReturnType<typeof vi.fn>).mock.calls.length;
      const restored = h.v.run(commands.restoreNote, { note: added.note, lang: "en" });
      expect(restored.ok).toBe(true);
      expect(noteByGid(h.read, added.note)?.dismissedAt).toBeNull();
      expect((h.inputs.buildValued as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        after,
      );
    } finally {
      h.v.store.close();
    }
  });
});
