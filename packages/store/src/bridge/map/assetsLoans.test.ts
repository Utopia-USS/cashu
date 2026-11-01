// Loans and assets bridges (S31a spec 4.4; events.md 8.4): loans, depreciation curves, asset notes.
// Each rule maps a synthetic Python change to catalog events through the planner (parseEvent + DET
// self-check). Synthetic rows only.
import { describe, expect, it } from "vitest";
import { plan } from "../plan.js";
import { DET, idsOf, outboxRow, T0, T1, testPorts, vaultInput } from "../testing/rows.js";

const ACCOUNT_GID = "01JQ0000000000000000000030";
const LOAN_GID = DET("loans", [ACCOUNT_GID]);
const DEP_GID = DET("depreciations", [ACCOUNT_GID]);
const NOTE_GID = DET("asset_details", [ACCOUNT_GID]);

const ids = idsOf({
  "accounts|3": ACCOUNT_GID,
  "loans|1": LOAN_GID,
  "depreciations|1": DEP_GID,
  "asset_details|1": NOTE_GID,
});

type Row = Parameters<typeof outboxRow>[0];

function run(rows: Row[]) {
  return plan({
    rows: rows.map((p) => outboxRow(p)),
    vaults: [vaultInput(ids)],
    ports: testPorts(),
  });
}

function shipped(rows: Row[]) {
  const r = run(rows);
  if (!r.ok) throw new Error(`blocked: ${r.reason}`);
  const events = r.plan.batches.flatMap((b) => b.events);
  return { plan: r.plan, events, types: events.map((e) => e.t) };
}

const blocked = (rows: Row[]) => {
  const r = run(rows);
  return r.ok ? "ok" : r.reason;
};

const update = (
  table: string,
  post: Record<string, unknown>,
  fields: Record<string, unknown>,
  prev: Record<string, unknown>,
): Row => ({
  table,
  localId: "1",
  op: "update",
  fields,
  prev,
  post,
});

const loanPost = (o: Record<string, unknown> = {}) => ({
  id: 1,
  account_id: 3,
  principal: "300000.00",
  annual_rate: "7.25",
  term_months: 360,
  start_date: "2026-04-01",
  origination_date: null,
  created_at: T0,
  updated_at: T0,
  payment_iban: null,
  payment_text: null,
  ...o,
});

const depPost = (o: Record<string, unknown> = {}) => ({
  id: 1,
  account_id: 3,
  purchase_price: "80000.00",
  purchase_date: "2025-06-01",
  annual_rate: "15",
  floor: null,
  created_at: T0,
  ...o,
});

const notePost = (o: Record<string, unknown> = {}) => ({
  id: 1,
  account_id: 3,
  note: "syn note",
  created_at: T0,
  updated_at: T0,
  ...o,
});

describe("loans", () => {
  it("an insert without a Python gid is loan.termsSet on DET(account)", () => {
    const { events, plan: p } = shipped([
      { table: "loans", localId: "1", fields: loanPost(), post: loanPost() },
    ]);
    expect(events.map((e) => [e.t, e.g, e.d.account])).toEqual([
      ["loan.termsSet", LOAN_GID, ACCOUNT_GID],
    ]);
    expect(p.batches[0]?.gids).toEqual([{ table: "loans", localId: "1", gid: LOAN_GID }]);
  });

  it("new terms are the whole termsSet stamped with the derived updated_at", () => {
    const post = loanPost({ principal: "290000.00", updated_at: T1 });
    const { events } = shipped([
      update("loans", post, { principal: "290000.00" }, { principal: "300000.00" }),
    ]);
    expect(events.map((e) => [e.t, e.d.principal, e.d.termMonths])).toEqual([
      ["loan.termsSet", "290000.00", 360],
    ]);
    expect(events[0]?.d).toMatchObject({ stamps: { updated_at: "2026-03-02T11:30:00.250000Z" } });
  });

  it("payment matching set and cleared is loan.paymentMatchingSet, the whole value", () => {
    const set = shipped([
      update(
        "loans",
        loanPost({ payment_text: "rata kredytu" }),
        { payment_text: "rata kredytu" },
        { payment_text: null },
      ),
    ]);
    expect(set.events.map((e) => [e.t, e.d.account, e.d.paymentIban, e.d.paymentText])).toEqual([
      ["loan.paymentMatchingSet", ACCOUNT_GID, null, "rata kredytu"],
    ]);
    const cleared = shipped([
      update("loans", loanPost(), { payment_text: null }, { payment_text: "rata kredytu" }),
    ]);
    expect(cleared.events.map((e) => [e.t, e.g, e.d.paymentIban, e.d.paymentText])).toEqual([
      ["loan.paymentMatchingSet", LOAN_GID, null, null],
    ]);
  });

  it("blocks an account change and a delete", () => {
    expect(
      blocked([update("loans", loanPost({ account_id: 4 }), { account_id: 4 }, { account_id: 3 })]),
    ).toBe("immutable:loans:account_id");
    expect(blocked([{ table: "loans", localId: "1", op: "delete", fields: loanPost() }])).toBe(
      "no-delete-event:loans",
    );
  });
});

describe("depreciations", () => {
  it("insert and a curve edit are the whole depreciation.set", () => {
    const ins = shipped([
      { table: "depreciations", localId: "1", fields: depPost(), post: depPost() },
    ]);
    expect(ins.events.map((e) => [e.t, e.g])).toEqual([["depreciation.set", DEP_GID]]);
    const upd = shipped([
      update(
        "depreciations",
        depPost({ floor: "10000.00" }),
        { floor: "10000.00" },
        { floor: null },
      ),
    ]);
    expect(upd.events.map((e) => [e.t, e.d.purchasePrice, e.d.floor])).toEqual([
      ["depreciation.set", "80000.00", "10000.00"],
    ]);
  });

  it("blocks a created_at change and a delete", () => {
    expect(
      blocked([
        update(
          "depreciations",
          depPost({ created_at: T1 }),
          { created_at: T1 },
          { created_at: T0 },
        ),
      ]),
    ).toBe("immutable:depreciations:created_at");
    expect(
      blocked([{ table: "depreciations", localId: "1", op: "delete", fields: depPost() }]),
    ).toBe("no-delete-event:depreciations");
  });
});

describe("asset details", () => {
  it("insert and a note edit (incl. clearing it) are assetDetails.noteSet", () => {
    const ins = shipped([
      { table: "asset_details", localId: "1", fields: notePost(), post: notePost() },
    ]);
    expect(ins.events.map((e) => [e.t, e.g, e.d.note])).toEqual([
      ["assetDetails.noteSet", NOTE_GID, "syn note"],
    ]);
    const cleared = shipped([
      update(
        "asset_details",
        notePost({ note: null, updated_at: T1 }),
        { note: null },
        { note: "syn note" },
      ),
    ]);
    expect(cleared.events.map((e) => [e.t, e.d.note])).toEqual([["assetDetails.noteSet", null]]);
    expect(cleared.events[0]?.d).toMatchObject({
      stamps: { updated_at: "2026-03-02T11:30:00.250000Z" },
    });
  });

  it("blocks an account change and a delete", () => {
    expect(
      blocked([
        update("asset_details", notePost({ account_id: 4 }), { account_id: 4 }, { account_id: 3 }),
      ]),
    ).toBe("immutable:asset_details:account_id");
    expect(
      blocked([{ table: "asset_details", localId: "1", op: "delete", fields: notePost() }]),
    ).toBe("no-delete-event:asset_details");
  });
});
