// Alert and signal bridges (S31a spec 4.4 table, P-C reactivate, S25-python-emits): each rule maps a
// synthetic Python change to the catalog events, validated by the planner. Synthetic rows only.
import { describe, expect, it } from "vitest";
import { ackEntries, plan } from "../plan.js";
import { idsOf, outboxRow, T0, T1, testPorts, vaultInput } from "../testing/rows.js";

const ALERT_GID = "01JQ0000000000000000000001";
const SIGNAL_GID = "01JQ0000000000000000000002";
const RUN_GID = "01JQ0000000000000000000003";

const ids = idsOf({
  "alerts|5": ALERT_GID,
  "inv_signals|7": SIGNAL_GID,
  "inv_rule_runs|2": RUN_GID,
});

const alertPost = (o: Record<string, unknown> = {}) => ({
  id: 5,
  instrument_id: null,
  scope: "portfolio",
  kind: "drawdown_from_high",
  params: { pct: 10 },
  polarity: "negative",
  severity: "action",
  title: "syn alert",
  note: null,
  source: "user",
  created_by: "app",
  status: "active",
  cooldown_days: null,
  expires_at: null,
  snoozed_until: null,
  last_triggered_at: null,
  last_checked_at: null,
  last_value: null,
  created_at: T0,
  updated_at: T1,
  deleted_at: null,
  tag: null,
  ...o,
});

const signalPost = (o: Record<string, unknown> = {}) => ({
  id: 7,
  rule_id: "drawdown",
  kind: "drawdown",
  dedup_key: "drawdown",
  severity: "info",
  status: "active",
  message: "m",
  instrument_id: null,
  account_id: null,
  payload: { pct: 5 },
  first_seen_at: T0,
  last_seen_at: T1,
  created_run_id: 2,
  last_run_id: 2,
  closed_at: null,
  polarity: "negative",
  snoozed_until: null,
  acknowledged_at: null,
  ...o,
});

function shipped(rows: Parameters<typeof outboxRow>[0][], leader = true) {
  const r = plan({
    rows: rows.map((p) => outboxRow(p)),
    vaults: [vaultInput(ids)],
    ports: testPorts(leader),
  });
  if (!r.ok) throw new Error(`blocked: ${r.reason}`);
  const events = r.plan.batches.flatMap((b) => b.events);
  return { plan: r.plan, events, types: events.map((e) => e.t) };
}

describe("alerts", () => {
  it("a title edit is alert.updated with the changed field only, stamped from post", () => {
    const { events, types } = shipped([
      {
        table: "alerts",
        localId: "5",
        op: "update",
        gid: ALERT_GID,
        fields: { title: "new" },
        prev: { title: "syn alert" },
        post: alertPost({ title: "new" }),
      },
    ]);
    expect(types).toEqual(["alert.updated"]);
    expect(events[0]?.d).toMatchObject({
      title: "new",
      stamps: { updated_at: "2026-03-02T11:30:00.250000Z" },
    });
    expect(Object.keys(events[0]?.d ?? {}).sort()).toEqual(["stamps", "title"]);
  });

  it("mute / snooze / unmute are owner statusSet events", () => {
    const mute = shipped([
      {
        table: "alerts",
        localId: "5",
        op: "update",
        gid: ALERT_GID,
        fields: { status: "muted" },
        prev: { status: "active" },
        post: alertPost({ status: "muted" }),
      },
    ]);
    expect(mute.events.map((e) => [e.t, e.d.status, e.d.snoozedUntil])).toEqual([
      ["alert.statusSet", "muted", null],
    ]);
    const unmute = shipped([
      {
        table: "alerts",
        localId: "5",
        op: "update",
        gid: ALERT_GID,
        fields: { status: "active" },
        prev: { status: "muted" },
        post: alertPost(),
      },
    ]);
    expect(unmute.events.map((e) => [e.t, e.d.status])).toEqual([["alert.statusSet", "active"]]);
  });

  it("restore with triggered -> active is restored{rearm}; delete is alert.deleted", () => {
    const restore = shipped([
      {
        table: "alerts",
        localId: "5",
        op: "update",
        gid: ALERT_GID,
        fields: { deleted_at: null, status: "active" },
        prev: { deleted_at: T0, status: "triggered" },
        post: alertPost(),
      },
    ]);
    expect(restore.events.map((e) => [e.t, e.d.rearm])).toEqual([["alert.restored", true]]);
    const del = shipped([
      {
        table: "alerts",
        localId: "5",
        op: "update",
        gid: ALERT_GID,
        fields: { deleted_at: T1 },
        prev: { deleted_at: null },
        post: alertPost({ deleted_at: T1 }),
      },
    ]);
    expect(del.types).toEqual(["alert.deleted"]);
  });

  it("runtime changes are alert.evaluated, dropped on a non-leader (acked, no clocks)", () => {
    const row = {
      table: "alerts",
      localId: "5",
      op: "update" as const,
      gid: ALERT_GID,
      fields: { last_checked_at: T1, status: "triggered" },
      prev: { last_checked_at: null, status: "active" },
      post: alertPost({ last_checked_at: T1, status: "triggered" }),
    };
    expect(shipped([row]).events.map((e) => [e.t, e.d.triggered])).toEqual([
      ["alert.evaluated", true],
    ]);
    const follower = shipped([row], false);
    expect(follower.types).toEqual([]);
    expect(follower.plan.counts.notLeader).toBe(1);
  });

  it("refuses a change of a column the catalog cannot update", () => {
    const r = plan({
      rows: [
        outboxRow({
          table: "alerts",
          localId: "5",
          op: "update",
          gid: ALERT_GID,
          fields: { kind: "new_high" },
          prev: { kind: "drawdown_from_high" },
          post: alertPost({ kind: "new_high" }),
        }),
      ],
      vaults: [vaultInput(ids)],
      ports: testPorts(),
    });
    expect(r).toMatchObject({ ok: false, reason: "immutable:alerts:kind" });
  });
});

describe("signals", () => {
  it("escalating an acknowledged signal reactivates it (P-C prev status)", () => {
    const { events } = shipped([
      {
        table: "inv_signals",
        localId: "7",
        op: "update",
        gid: SIGNAL_GID,
        fields: { severity: "action", message: "m2" },
        prev: { severity: "info", message: "m", status: "acknowledged" },
        post: signalPost({ severity: "action", message: "m2" }),
      },
    ]);
    expect(events.map((e) => [e.t, e.d.reactivate, e.d.severity, e.d.run])).toEqual([
      ["signal.escalated", true, "action", RUN_GID],
    ]);
  });

  it("a refresh carries only the changed optional fields and the last run", () => {
    const { events } = shipped([
      {
        table: "inv_signals",
        localId: "7",
        op: "update",
        gid: SIGNAL_GID,
        fields: { message: "m2", last_seen_at: T1 },
        prev: { message: "m", last_seen_at: T0 },
        post: signalPost({ message: "m2" }),
      },
    ]);
    expect(events[0]?.t).toBe("signal.refreshed");
    expect(Object.keys(events[0]?.d ?? {}).sort()).toEqual(["message", "run", "seenAt", "stamps"]);
  });

  it("an owner close carries the reason and the payload keys it set", () => {
    const { events } = shipped([
      {
        table: "inv_signals",
        localId: "7",
        op: "update",
        gid: SIGNAL_GID,
        fields: { status: "expired", closed_at: T1, payload: { pct: 5, closed_by: "mute" } },
        prev: { status: "active", closed_at: null, payload: { pct: 5 } },
        post: signalPost({
          status: "expired",
          closed_at: T1,
          payload: { pct: 5, closed_by: "mute" },
        }),
      },
    ]);
    expect(events.map((e) => [e.t, e.d.status, e.d.reason, e.d.payloadSet])).toEqual([
      ["signal.closed", "expired", "mute", { closed_by: "mute" }],
    ]);
  });

  it("a reopen lists the payload keys it removed", () => {
    const { events } = shipped([
      {
        table: "inv_signals",
        localId: "7",
        op: "update",
        gid: SIGNAL_GID,
        fields: { status: "active", closed_at: null, payload: { pct: 5 } },
        prev: { status: "expired", closed_at: T1, payload: { pct: 5, closed_by: "mute" } },
        post: signalPost(),
      },
    ]);
    expect(events.map((e) => [e.t, e.d.reason, e.d.payloadUnset])).toEqual([
      ["signal.reopened", "alert_restored", ["closed_by"]],
    ]);
  });

  it("a snooze is signal.snoozed; clearing an expired snooze is signal.woken", () => {
    const until = "2026-03-05 00:00:00.000000";
    const snooze = shipped([
      {
        table: "inv_signals",
        localId: "7",
        op: "update",
        gid: SIGNAL_GID,
        fields: { snoozed_until: until },
        prev: { snoozed_until: null },
        post: signalPost({ snoozed_until: until }),
      },
    ]);
    expect(snooze.events.map((e) => [e.t, e.d.until])).toEqual([
      ["signal.snoozed", "2026-03-05T00:00:00.000000Z"],
    ]);
    const woken = shipped([
      {
        table: "inv_signals",
        localId: "7",
        op: "update",
        gid: SIGNAL_GID,
        ts: "2026-03-06 00:00:00.000000",
        fields: { snoozed_until: null },
        prev: { snoozed_until: until },
        post: signalPost(),
      },
    ]);
    expect(woken.types).toEqual(["signal.woken"]);
  });

  it("the ack plan stamps each changed column with its carrying event", () => {
    const { plan: p, events } = shipped([
      {
        table: "alerts",
        localId: "5",
        op: "update",
        gid: ALERT_GID,
        fields: { title: "new", status: "muted" },
        prev: { title: "syn alert", status: "active" },
        post: alertPost({ title: "new", status: "muted" }),
      },
    ]);
    const hlcs = new Map(events.map((e, i) => [e.i, `00000000${i}-0000-${"a".repeat(32)}`]));
    const [entry] = ackEntries(p, hlcs);
    expect(entry).toEqual({
      profile_id: 1,
      table: "alerts",
      local_id: "5",
      clocks: {
        title: [hlcs.get(events[0]?.i ?? ""), events[0]?.i],
        status: [hlcs.get(events[1]?.i ?? ""), events[1]?.i],
      },
    });
    expect(p.through).toBeGreaterThan(0);
  });
});

describe("alert tags (Alembic 0027, S31c)", () => {
  it("a tagged insert ships the tag in alert.created; an untagged one leaves it out", () => {
    const insert = (tag: string | null) =>
      shipped([
        {
          table: "alerts",
          localId: "5",
          op: "insert",
          gid: ALERT_GID,
          fields: alertPost({ tag }),
          post: alertPost({ tag }),
        },
      ]).events.find((e) => e.t === "alert.created")?.d;
    expect(insert("wydarzenie")).toMatchObject({ tag: "wydarzenie" });
    expect(insert(null)).not.toHaveProperty("tag");
  });

  it("a tag set, change and clear is alert.updated with the tag only (null clears)", () => {
    const update = (prev: string | null, next: string | null) =>
      shipped([
        {
          table: "alerts",
          localId: "5",
          op: "update",
          gid: ALERT_GID,
          fields: { tag: next },
          prev: { tag: prev },
          post: alertPost({ tag: next }),
        },
      ]).events;
    for (const [prev, next] of [
      [null, "cena"],
      ["cena", "rsi"],
      ["rsi", null],
    ] as const) {
      const events = update(prev, next);
      expect(events.map((e) => e.t)).toEqual(["alert.updated"]);
      const { stamps: _stamps, ...patch } = events[0]?.d ?? {};
      expect(patch).toEqual({ tag: next });
    }
  });

  it("a tag edited together with the title travels in one patch", () => {
    const { events } = shipped([
      {
        table: "alerts",
        localId: "5",
        op: "update",
        gid: ALERT_GID,
        fields: { title: "nowy", tag: "cena" },
        prev: { title: "syn alert", tag: null },
        post: alertPost({ title: "nowy", tag: "cena" }),
      },
    ]);
    expect(events.map((e) => e.t)).toEqual(["alert.updated"]);
    expect(events[0]?.d).toMatchObject({ title: "nowy", tag: "cena" });
  });
});
