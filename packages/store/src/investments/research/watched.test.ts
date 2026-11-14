// A watched, never held instrument carries theses like a held position (created, listed newest
// first, updated) only within its vault; research treats it as watched. Synthetic data only.
import { describe, expect, it } from "vitest";
import { createThesis, updateThesis } from "../commands/journal.js";
import { otherVault, stock, vault } from "../commands/testing/fixtures.js";
import { theses } from "../queries/journal.js";
import { eventInstant } from "./rows.js";
import { refusal, watch, yahoo } from "./testing/fixtures.js";
import { researchSummary } from "./views.js";

function watched() {
  const v = vault();
  const vwce = stock(v, "VWCE", "IE00BK5BQT80", {
    name: "Vanguard FTSE All-World",
    currency: "EUR",
    assetClass: "etf",
    mic: "XETR",
    aliases: [yahoo("VWCE.DE")],
  });
  watch(v, vwce, "Korekta po wynikach, wysoka dywidenda");
  return { v, vwce, read: v.store.read.bind(v.store) };
}

describe("theses of a watched instrument", () => {
  it("watched instrument theses create list update", () => {
    const { v, vwce, read } = watched();
    expect(theses(read, vwce)).toEqual([]);
    const first = v.value(createThesis, {
      instrument: vwce,
      entryType: "sentiment_correction",
      thesis: "Pierwsza",
    }).thesis;
    v.env.advance(1000);
    const second = v.value(createThesis, {
      instrument: vwce,
      entryType: "trend",
      thesis: "Wejscie",
      invalidation: "Uniewaznienie",
      exitPlan: "Plan wyjscia",
      sizePlan: "Wielkosc",
    }).thesis;
    const listed = theses(read, vwce);
    expect(listed.map((t) => t.gid)).toEqual([second, first]); // newest first
    const latest = listed[0];
    expect([latest?.thesis, latest?.invalidation, latest?.exitPlan, latest?.sizePlan]).toEqual([
      "Wejscie",
      "Uniewaznienie",
      "Plan wyjscia",
      "Wielkosc",
    ]);
    v.value(updateThesis, { id: second, values: { exitPlan: "Nowy plan" } });
    const updated = theses(read, vwce)[0];
    expect(updated?.exitPlan).toBe("Nowy plan");
    expect(updated?.thesis).toBe("Wejscie");
    // research sees the watched instrument with its thesis (the asset panel's research block)
    const now = eventInstant(new Date(v.env.clock.now()).toISOString());
    const row = researchSummary(read, { now, lang: "pl", weights: new Map() }).instruments.find(
      (r) => r.instrument_id === vwce,
    );
    expect(row?.watched).toBe(true);
    expect(row?.held).toBe(false);
    expect(row?.has_thesis).toBe(true);
    expect(row?.entry_type).toBe("trend");
  });

  it("watched theses and note stay in the profile", () => {
    const { v, vwce, read } = watched();
    v.value(createThesis, { instrument: vwce, entryType: "trend", thesis: "A" });
    const other = otherVault();
    expect(theses(other.store.read.bind(other.store), vwce)).toEqual([]);
    expect(
      refusal(other.run(createThesis, { instrument: vwce, entryType: "trend", thesis: "B" })),
    ).toBe("no_instrument");
    expect(theses(read, vwce).map((t) => t.thesis)).toEqual(["A"]);
  });
});
