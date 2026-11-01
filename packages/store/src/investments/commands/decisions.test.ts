// F9: one decision covering several signals of a position (the link table, the position decision's
// checks, the undo reverting every acknowledgement it caused, decisions listed under each signal, the
// per-signal decide / acknowledge writing one link). Translates the store-level parts of
// tests/investments/persistence/test_f9_be.py (HTTP 404 / 409 / 422 become refusal codes; response
// rendering belongs to the surfaces). Synthetic data only.
import { describe, expect, it } from "vitest";
import { decisionByGid, decisionSignalGids, decisions } from "../queries/journal.js";
import { signalByGid } from "../queries/signals.js";
import { acknowledgeSignal, decidePosition, decideSignal } from "./decisions.js";
import { recordDecision, undoDecision } from "./journal.js";
import { applyRaw, brokerage, raw, rawGid, stock, type Vault, vault } from "./testing/fixtures.js";

let next = 100;

function investor() {
  const v = vault();
  const xmpl = stock(v, "XMPL", "US0000000001");
  const abc = stock(v, "ABC", "PLABC0000016");
  const account = brokerage(v);
  applyRaw(v, [raw.watchAdded(v, xmpl), raw.watchAdded(v, abc)]); // both referenced by the vault
  const read = v.store.read.bind(v.store);
  /** `add_signal`: an open (or closed) signal about `instrument` (null = the whole portfolio). */
  const signal = (
    instrument: string | null,
    key: string,
    status: "active" | "resolved" = "active",
  ) => {
    const g = rawGid(++next);
    applyRaw(v, [raw.signalOpened(g, `test_${key}|${key}`, { instrument, severity: "action" })]);
    if (status === "resolved") {
      applyRaw(v, [
        { type: "signal.closed", gid: g, data: { status: "resolved", reason: "rule_cleared" } },
      ]);
    }
    return g;
  };
  return { v, xmpl, abc, account, read, signal };
}

const status = (v: Vault, g: string) => signalByGid(v.store.read.bind(v.store), g)?.status;
const decisionCount = (v: Vault) => decisions(v.store.read.bind(v.store)).length;
const links = (v: Vault) => {
  const read = v.store.read.bind(v.store);
  const all = decisions(read).map((d) => d.gid);
  return [...decisionSignalGids(read, all)].flatMap(([d, ss]) => ss.map((s) => [d, s]));
};

describe("position decisions (test_f9_be.py)", () => {
  it("test_position_decision_over_two_signals_acknowledges_both_with_one_row", () => {
    const { v, xmpl, read, signal } = investor();
    const [s1, s2] = [signal(xmpl, "a"), signal(xmpl, "b")];
    const out = v.value(decidePosition, {
      instrument: xmpl,
      action: "bought",
      quantity: "5",
      price: "12.5",
      reason: "dokupuję",
      signals: [s1, s2, s1],
    });
    const d = decisionByGid(read, out.decision);
    expect(d).toMatchObject({
      signal: s1,
      instrument: xmpl,
      action: "bought",
      quantity: "5",
      price: "12.5",
    });
    expect(decisionSignalGids(read, [out.decision]).get(out.decision)).toEqual([s1, s2]);
    for (const g of [s1, s2]) {
      expect(signalByGid(read, g)?.status).toBe("acknowledged");
      expect(signalByGid(read, g)?.acknowledgedAt).toBe(d?.createdAt);
      expect(decisions(read, { signal: g }).map((x) => x.gid)).toEqual([out.decision]);
    }
    expect(decisionCount(v)).toBe(1);
    expect(links(v)).toEqual([
      [out.decision, s1],
      [out.decision, s2],
    ]);
  });

  it("test_signal_dict_lists_the_shared_decision_under_both_signals", () => {
    const { v, xmpl, read, signal } = investor();
    const [s1, s2, other] = [signal(xmpl, "a"), signal(xmpl, "b"), signal(xmpl, "c")];
    const did = v.value(decidePosition, {
      instrument: xmpl,
      action: "held",
      signals: [s1, s2],
    }).decision;
    expect(decisions(read, { signal: s1 }).map((d) => d.gid)).toEqual([did]);
    expect(decisions(read, { signal: s2 }).map((d) => d.gid)).toEqual([did]);
    expect(decisions(read, { signal: other })).toEqual([]);
    expect(status(v, other)).toBe("active");
    expect(decisionSignalGids(read, [did]).get(did)).toEqual([s1, s2]);
    expect(decisions(read, { instrument: xmpl }).map((d) => d.gid)).toEqual([did]);
  });

  it("test_undo_reverts_every_linked_acknowledgement", () => {
    const { v, xmpl, read, signal } = investor();
    const [s1, s2] = [signal(xmpl, "a"), signal(xmpl, "b")];
    const did = v.value(decidePosition, {
      instrument: xmpl,
      action: "held",
      signals: [s1, s2],
    }).decision;
    expect(v.value(undoDecision, { decision: did }).signals).toEqual([s1, s2]);
    for (const g of [s1, s2]) {
      expect(signalByGid(read, g)).toMatchObject({ status: "active", acknowledgedAt: null });
    }
    expect(decisionCount(v)).toBe(0);
    expect(links(v)).toEqual([]);
  });

  it("test_undo_leaves_a_signal_another_decision_covers_acknowledged", () => {
    const { v, xmpl, read, signal } = investor();
    const [s1, s2] = [signal(xmpl, "a"), signal(xmpl, "b")];
    const did = v.value(decidePosition, {
      instrument: xmpl,
      action: "held",
      signals: [s1, s2],
    }).decision;
    v.env.advance(1000);
    const later = v.value(decideSignal, { signal: s2, action: "other" }).decision;
    v.value(undoDecision, { decision: did });
    expect([status(v, s1), status(v, s2)]).toEqual(["active", "acknowledged"]);
    expect(decisions(read, { signal: s2 }).map((d) => d.gid)).toEqual([later]);
  });

  it("test_an_earlier_acknowledgement_survives_until_its_last_decision_is_undone", () => {
    const { v, xmpl, read, signal } = investor();
    const [s1, s2] = [signal(xmpl, "a"), signal(xmpl, "b")];
    const ack = v.value(acknowledgeSignal, { signal: s2 }).decision;
    const ackedAt = signalByGid(read, s2)?.acknowledgedAt;
    v.env.advance(1000);
    const position = v.value(decidePosition, {
      instrument: xmpl,
      action: "held",
      signals: [s1, s2],
    });
    expect(signalByGid(read, s2)?.acknowledgedAt).toBe(ackedAt);
    v.value(undoDecision, { decision: ack }); // the ack's own entry
    expect(status(v, s2)).toBe("acknowledged"); // the position decision still covers it
    v.value(undoDecision, { decision: position.decision });
    expect(status(v, s1)).toBe("active");
    expect(signalByGid(read, s2)).toMatchObject({ status: "active", acknowledgedAt: null });
  });

  it("test_undoing_two_position_decisions_oldest_first_leaves_the_signals_active", () => {
    const { v, xmpl, read, signal } = investor();
    const [s1, s2] = [signal(xmpl, "a"), signal(xmpl, "b")];
    const post = { instrument: xmpl, action: "held", signals: [s1, s2] };
    const first = v.value(decidePosition, post).decision;
    v.env.advance(1000);
    const second = v.value(decidePosition, post).decision;
    v.value(undoDecision, { decision: first });
    expect([status(v, s1), status(v, s2)]).toEqual(["acknowledged", "acknowledged"]);
    for (const g of [s1, s2])
      expect(decisions(read, { signal: g }).map((d) => d.gid)).toEqual([second]);
    v.value(undoDecision, { decision: second });
    expect([status(v, s1), status(v, s2)]).toEqual(["active", "active"]);
    expect(links(v)).toEqual([]);
  });

  it("test_a_signal_of_another_instrument_is_422_and_writes_nothing", () => {
    const { v, xmpl, abc, signal } = investor();
    const [mine, foreign] = [signal(xmpl, "a"), signal(abc, "b")];
    const out = v.run(decidePosition, {
      instrument: xmpl,
      action: "held",
      signals: [mine, foreign],
    });
    expect(out).toEqual({ ok: false, reason: "other_instrument" });
    expect([decisionCount(v), links(v), status(v, mine)]).toEqual([0, [], "active"]);
  });

  it("test_a_portfolio_level_signal_is_422", () => {
    const { v, xmpl, signal } = investor();
    const portfolio = signal(null, "p");
    const out = v.run(decidePosition, { instrument: xmpl, action: "held", signals: [portfolio] });
    expect(out).toEqual({ ok: false, reason: "other_instrument" });
    expect([decisionCount(v), status(v, portfolio)]).toEqual([0, "active"]);
  });

  it("test_a_closed_signal_is_409", () => {
    const { v, xmpl, signal } = investor();
    const [open, closed] = [signal(xmpl, "a"), signal(xmpl, "b", "resolved")];
    const out = v.run(decidePosition, {
      instrument: xmpl,
      action: "held",
      signals: [open, closed],
    });
    expect(out).toEqual({ ok: false, reason: "signal_closed" });
    expect([decisionCount(v), status(v, open)]).toEqual([0, "active"]);
  });

  it("test_unknown_instrument_signal_or_account_is_404_and_bad_input_422", () => {
    const { v, xmpl, signal } = investor();
    const sid = signal(xmpl, "a");
    const other = vault({ seed: 7 });
    const otherXmpl = stock(other, "XMPL", "US0000000001");
    const theirs = rawGid(++next);
    applyRaw(other, [raw.signalOpened(theirs, "test_z|z", { instrument: otherXmpl })]);
    const post = (body: Record<string, unknown>) =>
      v.run(decidePosition, { action: "held", ...body });
    const unknown = rawGid(999);
    expect(post({ instrument: unknown })).toEqual({ ok: false, reason: "no_instrument" });
    expect(post({ instrument: xmpl, signals: [unknown] })).toEqual({
      ok: false,
      reason: "no_signal",
    });
    expect(post({ instrument: xmpl, signals: [theirs] })).toEqual({
      ok: false,
      reason: "no_signal",
    });
    expect(post({ instrument: xmpl, account: unknown })).toEqual({
      ok: false,
      reason: "no_account",
    });
    expect(post({ instrument: xmpl, action: "nope", signals: [sid] })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(post({ instrument: xmpl, action: "sold", quantity: "-1" })).toMatchObject({ ok: false });
    expect([decisionCount(v), status(v, sid)]).toEqual([0, "active"]);
  });

  it("test_a_position_decision_without_signals", () => {
    const { v, xmpl, read } = investor();
    const out = v.value(decidePosition, { instrument: xmpl, action: "ignored", reason: "x" });
    expect(out.signals).toEqual([]);
    expect(decisionByGid(read, out.decision)).toMatchObject({ signal: null, instrument: xmpl });
    expect(links(v)).toEqual([]);
    expect(v.value(undoDecision, { decision: out.decision }).signals).toEqual([]);
  });

  it("test_legacy_per_signal_endpoints_write_one_link", () => {
    const { v, xmpl, signal } = investor();
    const [s1, s2] = [signal(xmpl, "a"), signal(xmpl, "b")];
    const d1 = v.value(decideSignal, { signal: s1, action: "held" });
    const d2 = v.value(acknowledgeSignal, { signal: s2 });
    expect([d1.signals, d2.signals]).toEqual([[s1], [s2]]);
    expect(status(v, s1)).toBe("acknowledged");
    expect(links(v).sort()).toEqual(
      [
        [d1.decision, s1],
        [d2.decision, s2],
      ].sort(),
    );
    expect(v.value(undoDecision, { decision: d1.decision }).signals).toEqual([s1]);
    expect(status(v, s1)).toBe("active");
  });

  it("test_record_decision_refuses_signals_of_different_instruments", () => {
    const { v, xmpl, abc, read, signal } = investor();
    const [a, b] = [signal(xmpl, "a"), signal(abc, "b")];
    expect(v.run(recordDecision, { action: "held", signals: [a, b] })).toEqual({
      ok: false,
      reason: "mixed_instruments",
    });
    expect(v.run(recordDecision, { action: "held", signals: [a], instrument: abc })).toEqual({
      ok: false,
      reason: "other_instrument",
    });
    const row = v.value(recordDecision, { action: "held", signals: [a] });
    expect(decisionByGid(read, row.decision)).toMatchObject({ signal: a, instrument: xmpl });
    expect(decisionSignalGids(read, [row.decision]).get(row.decision)).toEqual([a]);
  });

  it("test_post_and_reads_list_signal_ids_in_the_same_order", () => {
    const { v, xmpl, read, signal } = investor();
    const [a, b, c] = [signal(xmpl, "a"), signal(xmpl, "b"), signal(xmpl, "c")];
    const posted = v.value(decidePosition, {
      instrument: xmpl,
      action: "held",
      signals: [a, c, b],
    });
    expect(decisionByGid(read, posted.decision)?.signal).toBe(a);
    expect(decisionSignalGids(read, [posted.decision]).get(posted.decision)).toEqual([a, b, c]);
    for (const g of [a, b, c]) {
      expect(decisions(read, { signal: g }).map((d) => d.gid)).toEqual([posted.decision]);
    }
  });

  it("test_per_signal_responses_list_every_covering_decision", () => {
    const { v, xmpl, read, signal } = investor();
    const [s1, s2] = [signal(xmpl, "a"), signal(xmpl, "b")];
    const shared = v.value(decidePosition, {
      instrument: xmpl,
      action: "held",
      signals: [s1, s2],
    }).decision;
    v.env.advance(1000);
    const decided = v.value(decideSignal, { signal: s2, action: "other" }).decision;
    expect(decisions(read, { signal: s2 }).map((d) => d.gid)).toEqual([decided, shared]);
    v.env.advance(1000);
    const acked = v.value(acknowledgeSignal, { signal: s1 }).decision;
    expect(decisions(read, { signal: s1 }).map((d) => d.gid)).toEqual([acked, shared]);
  });

  it("a closed signal cannot be acknowledged and the per-signal decision checks the account", () => {
    const { v, xmpl, account, signal } = investor();
    const closed = signal(xmpl, "b", "resolved");
    expect(v.run(acknowledgeSignal, { signal: closed })).toEqual({
      ok: false,
      reason: "signal_closed",
    });
    const open = signal(xmpl, "a");
    expect(v.run(decideSignal, { signal: open, action: "held", account: rawGid(998) })).toEqual({
      ok: false,
      reason: "no_account",
    });
    expect(v.value(decideSignal, { signal: open, action: "held", account }).signals).toEqual([
      open,
    ]);
  });
});
