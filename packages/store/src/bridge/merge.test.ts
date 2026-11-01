// Per-transaction merge (S31a spec 4.2): every row of the merge table and the two S25 research
// sequences. Synthetic rows only.
import { describe, expect, it } from "vitest";
import { mergeTxn } from "./merge.js";
import { completeTxns } from "./outbox.js";
import { outboxRow } from "./testing/rows.js";

const sig = (p: Omit<Parameters<typeof outboxRow>[0], "table">) =>
  outboxRow({ ...p, table: "inv_signals" });

describe("mergeTxn", () => {
  it("insert + updates -> one insert with the last post and its synced columns", () => {
    const rows = [
      sig({
        localId: "1",
        op: "insert",
        fields: { status: "active", message: "a" },
        post: { status: "active", message: "a", acknowledged_at: null },
      }),
      sig({
        localId: "1",
        op: "update",
        fields: { message: "b" },
        prev: { message: "a" },
        post: { status: "active", message: "b", acknowledged_at: null },
      }),
    ];
    const [m] = mergeTxn(rows);
    expect(m?.op).toBe("insert");
    expect(m?.fields).toEqual({ status: "active", message: "b" });
    expect(m?.post).toEqual({ status: "active", message: "b", acknowledged_at: null });
    expect(m?.ids.length).toBe(2);
  });

  it("update + update -> union, earliest prev, back-to-start columns dropped", () => {
    const rows = [
      sig({
        localId: "1",
        op: "update",
        fields: { message: "b", severity: "action" },
        prev: { message: "a", severity: "info" },
      }),
      sig({
        localId: "1",
        op: "update",
        fields: { message: "c", severity: "info" },
        prev: { message: "b", severity: "action" },
      }),
    ];
    const [m] = mergeTxn(rows);
    expect(m?.op).toBe("update");
    expect(m?.fields).toEqual({ message: "c" });
    expect(m?.prev).toEqual({ message: "a" });
  });

  it("an update undone inside the transaction leaves nothing", () => {
    const rows = [
      sig({ localId: "1", op: "update", fields: { message: "b" }, prev: { message: "a" } }),
      sig({ localId: "1", op: "update", fields: { message: "a" }, prev: { message: "b" } }),
    ];
    expect(mergeTxn(rows)).toEqual([]);
  });

  it("updates + delete -> delete with the last state; insert ... delete -> nothing", () => {
    const upd = sig({
      localId: "1",
      op: "update",
      fields: { message: "b" },
      prev: { message: "a" },
    });
    const del = sig({ localId: "1", op: "delete", fields: { message: "b", status: "active" } });
    const [m] = mergeTxn([upd, del]);
    expect(m?.op).toBe("delete");
    expect(m?.fields).toEqual({ message: "b", status: "active" });
    const ins = sig({ localId: "2", op: "insert", fields: { message: "x" } });
    const del2 = sig({ localId: "2", op: "delete", fields: { message: "x" } });
    expect(mergeTxn([ins, del2])).toEqual([]);
  });

  it("keeps explicit ops as barriers at their position and first-row order", () => {
    const rows = [
      outboxRow({
        table: "alerts",
        localId: "5",
        op: "update",
        fields: { title: "x" },
        prev: { title: "w" },
      }),
      outboxRow({ table: "inv_decisions", localId: "9", op: "undo" }),
      outboxRow({
        table: "alerts",
        localId: "5",
        op: "update",
        fields: { note: "n" },
        prev: { note: null },
      }),
      outboxRow({ table: "inv_decisions", localId: "9", op: "undo" }),
    ];
    const merged = mergeTxn(rows);
    expect(merged.map((m) => [m.table, m.op])).toEqual([
      ["alerts", "update"],
      ["inv_decisions", "undo"],
      ["inv_decisions", "undo"],
    ]);
    expect(merged[0]?.fields).toEqual({ title: "x", note: "n" });
  });

  it("a row after a delete of the same key (reused rowid) is a new logical row", () => {
    const del = sig({ localId: "3", op: "delete", fields: { message: "old" } });
    const ins = sig({ localId: "3", op: "insert", fields: { message: "new" } });
    expect(mergeTxn([del, ins]).map((m) => m.op)).toEqual(["delete", "insert"]);
  });

  it("S25 research refresh + rule id rewrite -> one update", () => {
    const rows = [
      sig({
        localId: "7",
        op: "update",
        fields: { last_seen_at: "2026-03-02 00:00:00.000000", message: "m2" },
        prev: { last_seen_at: "2026-03-01 00:00:00.000000", message: "m1" },
      }),
      sig({
        localId: "7",
        op: "update",
        fields: { rule_id: "research:new" },
        prev: { rule_id: "research:old" },
      }),
    ];
    const merged = mergeTxn(rows);
    expect(merged.length).toBe(1);
    expect(Object.keys(merged[0]?.fields ?? {}).sort()).toEqual([
      "last_seen_at",
      "message",
      "rule_id",
    ]);
  });

  it("S25 research close + payload -> one update carrying status and payload", () => {
    const rows = [
      sig({
        localId: "8",
        op: "update",
        fields: { status: "resolved", closed_at: "2026-03-02 00:00:00.000000" },
        prev: { status: "active", closed_at: null },
      }),
      sig({
        localId: "8",
        op: "update",
        fields: { payload: { closed_reason: "note_dismissed" } },
        prev: { payload: {} },
      }),
    ];
    const [m] = mergeTxn(rows);
    expect(m?.fields).toEqual({
      status: "resolved",
      closed_at: "2026-03-02 00:00:00.000000",
      payload: { closed_reason: "note_dismissed" },
    });
    expect(m?.prev).toEqual({ status: "active", closed_at: null, payload: {} });
  });
});

describe("completeTxns", () => {
  it("drops a cut page's last transaction, keeps a full page whole", () => {
    const rows = [
      outboxRow({ table: "alerts", localId: "1", txn: "a" }),
      outboxRow({ table: "alerts", localId: "2", txn: "b" }),
      outboxRow({ table: "alerts", localId: "3", txn: "b" }),
    ];
    expect(completeTxns(rows, true).map((r) => r.txn)).toEqual(["a"]);
    expect(completeTxns(rows, false).length).toBe(3);
  });
});
