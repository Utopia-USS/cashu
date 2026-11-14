// F9: one decision covering several signals of a position (the link table, the position decision's
// checks, the undo reverting every acknowledgement it caused, decisions listed under each signal, the
// per-signal decide / acknowledge writing one link). Synthetic data only.
import { describe, expect, it } from "vitest";
import { decisionByGid, decisionSignalGids, decisions } from "../queries/journal.js";
import { signalByGid } from "../queries/signals.js";
import { acknowledgeSignal, decidePosition, decideSignal } from "./decisions.js";
import { undoDecision } from "./journal.js";
import { applyRaw, brokerage, raw, rawGid, stock, type Vault, vault } from "./testing/fixtures.js";

let next = 100;

function investor() {
  const v = vault();
  const xmpl = stock(v, "XMPL", "US0000000001");
  const abc = stock(v, "ABC", "PLABC0000016");
  const account = brokerage(v);
  applyRaw(v, [raw.watchAdded(v, xmpl), raw.watchAdded(v, abc)]); // both referenced by the vault
  const read = v.store.read.bind(v.store);
  /** An open (or closed) signal about `instrument` (null = the whole portfolio). */
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

describe("position decisions", () => {
  it("one position decision over two signals acknowledges both with one row", () => {
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

  it("undo reverts every linked acknowledgement", () => {
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

  it("undo leaves a signal another decision covers acknowledged", () => {
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

  it("an earlier acknowledgement survives until its last decision is undone", () => {
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

  it("a signal of another instrument refuses and writes nothing", () => {
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

  it("a portfolio-level signal refuses", () => {
    const { v, xmpl, signal } = investor();
    const portfolio = signal(null, "p");
    const out = v.run(decidePosition, { instrument: xmpl, action: "held", signals: [portfolio] });
    expect(out).toEqual({ ok: false, reason: "other_instrument" });
    expect([decisionCount(v), status(v, portfolio)]).toEqual([0, "active"]);
  });

  it("a closed signal refuses", () => {
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

  it("an unknown or foreign instrument, signal or account and bad input refuse", () => {
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

  it("a position decision without signals", () => {
    const { v, xmpl, read } = investor();
    const out = v.value(decidePosition, { instrument: xmpl, action: "ignored", reason: "x" });
    expect(out.signals).toEqual([]);
    expect(decisionByGid(read, out.decision)).toMatchObject({ signal: null, instrument: xmpl });
    expect(links(v)).toEqual([]);
    expect(v.value(undoDecision, { decision: out.decision }).signals).toEqual([]);
  });

  it("per-signal decide and acknowledge write one link", () => {
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

  it("a signal lists every decision covering it", () => {
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
