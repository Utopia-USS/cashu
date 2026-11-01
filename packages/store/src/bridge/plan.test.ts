// The planner (S31a spec 4.1, 4.7, 5.2): one frame per vault per plan (TRANSITIONAL(S29c-B3)), a
// first transaction that alone does not fit blocks `needs-batch-append`, rows of a profile without a
// vault are acked unshipped, `through` covers exactly the planned transactions. Synthetic rows only.
import { describe, expect, it } from "vitest";
import { plan } from "./plan.js";
import { idsOf, outboxRow, T0, T1, testPorts, vaultInput } from "./testing/rows.js";

const GID = "01JQ0000000000000000000001";
const ids = idsOf({ "alerts|5": GID });

const post = (title: string) => ({
  id: 5,
  instrument_id: null,
  scope: "portfolio",
  kind: "drawdown_from_high",
  params: {},
  polarity: "negative",
  severity: "action",
  title,
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
});

const edit = (id: number, txn: string, title: string, profileId: number | null = 1) =>
  outboxRow({
    id,
    txn,
    profileId,
    table: "alerts",
    localId: "5",
    op: "update",
    gid: GID,
    fields: { title },
    prev: { title: "old" },
    post: post(title),
  });

describe("plan", () => {
  it("plans whole transactions while they fit one frame and stops before the next", () => {
    const rows = [edit(1, "a", "t1"), edit(2, "b", "t2"), edit(3, "c", "t3")];
    const r = plan({ rows, vaults: [vaultInput(ids)], ports: testPorts(), maxFrameEvents: 2 });
    expect(r.ok && r.plan.through).toBe(2);
    expect(r.ok && r.plan.batches[0]?.events.length).toBe(2);
  });

  it("blocks needs-batch-append when the first transaction alone does not fit (nothing planned)", () => {
    const rows = [edit(1, "a", "t1"), edit(2, "a", "t1b", 1)];
    const twoRows = [
      rows[0],
      { ...edit(2, "a", "x"), localId: "6", gid: "01JQ0000000000000000000002" },
    ];
    const r = plan({
      rows: twoRows.flatMap((x) => (x === undefined ? [] : [x])),
      vaults: [vaultInput(idsOf({ "alerts|5": GID, "alerts|6": "01JQ0000000000000000000002" }))],
      ports: testPorts(),
      maxFrameEvents: 1,
    });
    expect(r).toMatchObject({ ok: false, reason: "needs-batch-append" });
  });

  it("acks rows of a profile without a linked vault without shipping them", () => {
    const r = plan({
      rows: [edit(1, "a", "t1", 2)],
      vaults: [vaultInput(ids)],
      ports: testPorts(),
    });
    expect(r.ok && r.plan.counts.unlinked).toBe(1);
    expect(r.ok && r.plan.batches.length).toBe(0);
    expect(r.ok && r.plan.through).toBe(1);
  });

  it("validates every event before it is planned (a bad payload blocks invalid-event)", () => {
    const bad = { ...edit(1, "a", ""), post: post("") };
    const r = plan({ rows: [bad], vaults: [vaultInput(ids)], ports: testPorts() });
    expect(r).toMatchObject({ ok: false, reason: "invalid-event:alert.updated" });
  });
});
