// Decision journal and theses commands with their queries (Python `store/journal.py` semantics:
// record_decision, undo_decision with its 15-minute window, decision_signal_ids, theses create /
// update / delete with the derived change stamps). Synthetic data only.
import { describe, expect, it } from "vitest";
import {
  decisionByGid,
  decisionSignalGids,
  decisions,
  theses,
  thesisByGid,
} from "../queries/journal.js";
import { signalByGid } from "../queries/signals.js";
import {
  createThesis,
  deleteThesis,
  recordDecision,
  UNDO_WINDOW_MS,
  undoDecision,
  updateThesis,
} from "./journal.js";
import { applyRaw, brokerage, raw, rawGid, stock, vault } from "./testing/fixtures.js";

function withSignals() {
  const v = vault();
  const a = stock(v, "AAA", "PL0000000AAA");
  const b = stock(v, "BBB", "PL0000000BBB");
  const account = brokerage(v);
  const [s1, s2, s3] = [rawGid(1), rawGid(2), rawGid(3)];
  applyRaw(v, [
    raw.signalOpened(s1, `rule1|i:${a}`, { instrument: a, account }),
    raw.signalOpened(s2, `rule2|i:${a}`, { instrument: a, account }),
    raw.signalOpened(s3, `rule1|i:${b}`, { instrument: b }),
  ]);
  return { v, a, b, account, s1, s2, s3, read: v.store.read.bind(v.store) };
}

describe("recordDecision", () => {
  it("links the signals of one instrument once and acknowledges them (derived)", () => {
    const { v, a, account, s1, s2, read } = withSignals();
    const out = v.value(recordDecision, {
      action: "held",
      signals: [s1, s2, s1],
      quantity: "1.5",
      currency: "pln",
      reason: "  trzymam  ",
    });
    expect(out.signals).toEqual([s1, s2]);
    const d = decisionByGid(read, out.decision);
    expect(d).toMatchObject({
      signal: s1,
      instrument: a,
      account, // both signals share it
      action: "held",
      quantity: "1.5",
      currency: "PLN",
      reason: "trzymam",
    });
    expect(signalByGid(read, s1)?.status).toBe("acknowledged");
    expect(decisionSignalGids(read, [out.decision]).get(out.decision)).toEqual([s1, s2]);
    expect(decisions(read, { signal: s2 }).map((x) => x.gid)).toEqual([out.decision]);
    expect(decisions(read, { instrument: a }).map((x) => x.gid)).toEqual([out.decision]);
  });

  it("refuses mixed or other instruments, negative numbers and unknown signals", () => {
    const { v, b, s1, s3 } = withSignals();
    expect(v.run(recordDecision, { action: "held", signals: [s1, s3] })).toEqual({
      ok: false,
      reason: "mixed_instruments",
    });
    expect(v.run(recordDecision, { action: "held", signals: [s1], instrument: b })).toEqual({
      ok: false,
      reason: "other_instrument",
    });
    expect(v.run(recordDecision, { action: "sold", quantity: "-1" })).toEqual({
      ok: false,
      reason: "negative_quantity",
    });
    expect(v.run(recordDecision, { action: "sold", price: "-1" })).toEqual({
      ok: false,
      reason: "negative_price",
    });
    expect(v.run(recordDecision, { action: "held", signals: [rawGid(99)] })).toEqual({
      ok: false,
      reason: "no_signal",
    });
    expect(v.run(recordDecision, { action: "maybe" })).toMatchObject({ reason: "invalid_input" });
  });

  it("a decision without signals keeps its own instrument and account", () => {
    const { v, b, account, read } = withSignals();
    const out = v.value(recordDecision, { action: "bought", instrument: b, account });
    expect(decisionByGid(read, out.decision)).toMatchObject({
      signal: null,
      instrument: b,
      account,
    });
    expect(decisionSignalGids(read, [out.decision]).get(out.decision)).toEqual([]);
  });
});

describe("undoDecision", () => {
  it("undoes within the window; the episode is active again unless another decision links it", () => {
    const { v, s1, read } = withSignals();
    const first = v.value(recordDecision, { action: "held", signals: [s1] });
    v.env.advance(1000);
    const second = v.value(recordDecision, { action: "ignored", signals: [s1] });
    expect(v.value(undoDecision, { decision: second.decision })).toEqual({ signals: [s1] });
    expect(decisionByGid(read, second.decision)).toBeUndefined();
    expect(signalByGid(read, s1)?.status).toBe("acknowledged"); // the first still links it
    v.value(undoDecision, { decision: first.decision });
    expect(signalByGid(read, s1)?.status).toBe("active");
  });

  it("refuses after UNDO_WINDOW and an unknown decision", () => {
    const { v, s1 } = withSignals();
    const d = v.value(recordDecision, { action: "held", signals: [s1] });
    v.env.advance(UNDO_WINDOW_MS + 1);
    expect(v.run(undoDecision, { decision: d.decision })).toEqual({
      ok: false,
      reason: "undo_expired",
    });
    expect(v.run(undoDecision, { decision: rawGid(50) })).toEqual({
      ok: false,
      reason: "no_decision",
    });
  });
});

describe("theses", () => {
  it("creates cleaned values; updates move the change stamps by value; delete removes it", () => {
    const { v, a, read } = withSignals();
    const { thesis } = v.value(createThesis, {
      instrument: a,
      entryType: "trend",
      thesis: "  Rosnie  ",
      invalidation: "   ",
      exitPlan: "Sprzedam po 100",
    });
    const t0 = thesisByGid(read, thesis);
    expect(t0).toMatchObject({
      instrument: a,
      thesis: "Rosnie",
      invalidation: null,
      exitPlan: "Sprzedam po 100",
      coreChangedAt: "2026-10-31 12:00:00.000000",
      exitPlanChangedAt: "2026-10-31 12:00:00.000000",
      reviewedAt: null,
    });
    v.env.advance(60_000);
    v.value(updateThesis, { id: thesis, values: { sizePlan: "5%" } });
    expect(thesisByGid(read, thesis)).toMatchObject({
      sizePlan: "5%",
      coreChangedAt: "2026-10-31 12:00:00.000000", // size plan edits never move it (P2)
      updatedAt: "2026-10-31 12:01:00.000000",
    });
    v.env.advance(60_000);
    v.value(updateThesis, {
      id: thesis,
      values: { thesis: "Rosnie", exitPlan: "" },
      reviewed: true,
    });
    expect(thesisByGid(read, thesis)).toMatchObject({
      coreChangedAt: "2026-10-31 12:00:00.000000", // same value: no change
      exitPlan: null,
      exitPlanChangedAt: null,
      reviewedAt: "2026-10-31 12:02:00.000000",
    });
    expect(theses(read, a).map((t) => t.gid)).toEqual([thesis]);
    v.value(deleteThesis, { id: thesis });
    expect(thesisByGid(read, thesis)).toBeUndefined();
    expect(v.run(updateThesis, { id: thesis, values: { thesis: "x" } })).toEqual({
      ok: false,
      reason: "no_thesis",
    });
  });

  it("validates entry type, thesis text and the instrument", () => {
    const { v, a } = withSignals();
    expect(v.run(createThesis, { instrument: a, entryType: "hunch", thesis: "x" })).toEqual({
      ok: false,
      reason: "invalid_entry_type",
    });
    expect(v.run(createThesis, { instrument: a, entryType: "trend", thesis: " " })).toEqual({
      ok: false,
      reason: "thesis_required",
    });
    expect(
      v.run(createThesis, { instrument: rawGid(70), entryType: "trend", thesis: "x" }),
    ).toEqual({
      ok: false,
      reason: "no_instrument",
    });
    const { thesis } = v.value(createThesis, { instrument: a, entryType: "trend", thesis: "x" });
    expect(v.run(updateThesis, { id: thesis, values: { thesis: "" } })).toEqual({
      ok: false,
      reason: "thesis_required",
    });
    expect(v.run(updateThesis, { id: thesis, values: {} })).toMatchObject({ ok: true, events: [] });
  });
});
