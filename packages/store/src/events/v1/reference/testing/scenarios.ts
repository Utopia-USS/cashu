// The convergence scenarios of the event catalog (events.md 6.7): every review blocker (B1-B3), the
// order-sensitive majors (M1, M2, M5, M7), the v1.2 rules (N1-N4), invalid-gid parking (G, 7.10),
// CREATE-once (C, 6.2) and account rows after an open (A). One list, two drivers: the reference fold
// (reference/convergence.test.ts) and the store's acceptance (src/convergence.test.ts), so the
// expectations cannot drift. Payloads are complete (zod-valid) so both folds see the same data.
// Synthetic names stand for gids; `syntheticDet` gives them DET semantics. Test code only: imports
// nothing from the store.
import { expect } from "vitest";
import { shuffled } from "../../../../testing/random.js";
import { detPartsOf } from "../../det-parts.js";
import { formatHlc } from "../../hlc-format.js";
import type { RefDet, RefEvent, RefView } from "../fold.js";

export interface Scenario {
  /** The group (describe title) the scenario belongs to. */
  readonly group: string;
  /** The test title. */
  readonly name: string;
  /** Complete payloads (zod-valid), in declaration order. */
  readonly events: readonly RefEvent[];
  /** Assertions on the folded view (reference view, or the store's projection of it). */
  readonly check: (view: RefView) => void;
}

// --------------------------------------------------------------------------------------------- //
// Event builder

/** Required payload fields the scenarios leave out (values irrelevant to the rules). */
const DEFAULTS: Record<string, Record<string, unknown>> = {
  "account.opened": {
    bank: "mbank",
    externalId: null,
    iban: null,
    currency: "PLN",
    type: "checking",
    name: "Konto",
    keys: [],
  },
  "txn.imported": {
    batch: null,
    bookingDate: "2026-01-15",
    valueDate: null,
    amount: "-1.00",
    currency: "PLN",
    counterpartyName: null,
    counterpartyIban: null,
    description: null,
    reference: null,
    bankTransactionId: null,
    source: "csv",
    raw: {},
  },
  "valuation.set": { currency: "PLN", note: null },
  "instrument.aliasAdded": { guessed: false },
  "signal.opened": {
    ruleId: "rule",
    kind: "test",
    severity: "info",
    polarity: "neutral",
    message: "",
    instrument: null,
    account: null,
    payload: {},
    run: null,
  },
  "decision.recorded": {
    instrument: null,
    account: null,
    action: "held",
    quantity: null,
    price: null,
    currency: null,
    reason: null,
  },
  "proposal.created": { summary: "", reason: null, payload: {}, source: "mcp" },
  "connectorBinding.set": { autoCommit: false },
  "profile.created": { slug: "dom", name: "Dom", baseCurrency: "PLN", mcpPrivacy: "strict" },
  "balance.recorded": { source: "csv", currency: "PLN" },
  "txn.cashExpenseAdded": {
    bookingDate: "2026-10-20",
    amount: "-12.50",
    currency: "PLN",
    title: "Kawa",
    category: "food",
  },
};

/** A scenario event with the payload fields the zod schemas require filled in. */
export function complete(e: RefEvent): RefEvent {
  return { ...e, data: { ...(DEFAULTS[e.type] ?? {}), ...e.data } };
}

const DEV = {
  a: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  b: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  p: "ffffffffffffffffffffffffffffffff",
} as const;
const BASE_WALL = 1_793_448_000_000; // 2026-10-31T12:00:00.000Z
let seq = 0;

function ev(
  device: keyof typeof DEV,
  wall: number,
  type: string,
  gid: string,
  data: Record<string, unknown>,
  cause?: string,
): RefEvent {
  seq += 1;
  return complete({
    eid: `01JC${String(seq).padStart(22, "0")}`,
    hlc: formatHlc({ wall: BASE_WALL + wall, counter: 0, device: DEV[device] }),
    at: new Date(BASE_WALL + wall).toISOString(),
    type,
    gid,
    data,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** A synthetic Polish NRB with valid mod-97 check digits for a 24-digit BBAN. */
function nrb(bban24: string): string {
  const check = 98n - (BigInt(`${bban24}252100`) % 97n);
  return `${check.toString().padStart(2, "0")}${bban24}`;
}
/** The cash pool account `cash:PLN` (gid.md 4.3); scenario name `pool:PLN`. */
const POOL_PLN = {
  bank: "manual",
  name: "Gotówka",
  externalId: "cash:PLN",
  type: "cash",
  keys: ["ext:manual:cash:PLN"],
};
const N1 = nrb("114000000000000000000001");
const N2 = nrb("114000000000000000000002");
const N3 = nrb("114000000000000000000003");

// --------------------------------------------------------------------------------------------- //
// Synthetic DET and delivery

/**
 * DET over synthetic names (events.md 7.10): the first declared event of a row key defines that
 * key's gid, so a second gid for one key, or a second key for one gid, is invalid. Injective per row
 * key and independent of delivery order (it depends on the scenario only, like a vault salt).
 */
export function syntheticDet(events: readonly RefEvent[]): RefDet {
  const key = (table: string, parts: readonly string[]) => [table, ...parts].join("\u001f");
  const byParts = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const e of events) {
    const p = detPartsOf(e.type, e.data);
    if (p === undefined) continue;
    const k = key(p.table, p.parts);
    if (byParts.has(k) || nameOf.has(e.gid)) continue;
    byParts.set(k, e.gid);
    nameOf.set(e.gid, k);
  }
  return (table, parts) => byParts.get(key(table, parts)) ?? `det:${key(table, parts)}`;
}

/** Delivery k of a scenario: shuffled order (seed k + 1) plus 3 re-delivered duplicates. */
export function delivery<T>(items: readonly T[], k: number): T[] {
  const order = shuffled(items, k + 1);
  return [...order, ...shuffled(order, k + 1000).slice(0, 3)];
}

export const ORDERS = 40;

// --------------------------------------------------------------------------------------------- //
// Scenarios

const out: Scenario[] = [];
const scenario = (group: string, name: string, events: RefEvent[], check: Scenario["check"]) =>
  out.push({ group, name, events, check });

const B1 = "B1 account identity";
scenario(
  B1,
  "CSV without IBAN and Open Banking by IBAN become one account once the IBAN is learned",
  [
    ev("a", 10, "account.opened", "acc-csv", {
      name: "Konto z CSV",
      iban: null,
      externalId: "csv-noiban:123",
      keys: ["ext:mbank:csv-noiban:123"],
    }),
    ev("b", 11, "account.opened", "acc-ob", {
      name: "mBank eKonto",
      iban: `PL${N1}`,
      externalId: "eb:uid-1",
      keys: [`iban:${N1}`, "ext:mbank:eb:uid-1"],
    }),
    ev("a", 20, "txn.imported", "t-csv", { account: "acc-csv", dedupHash: "h1", occurrence: 0 }),
    ev("b", 21, "txn.imported", "t-ob", { account: "acc-ob", dedupHash: "h1", occurrence: 0 }),
    ev("b", 22, "txn.imported", "t-ob2", { account: "acc-ob", dedupHash: "h2", occurrence: 0 }),
    ev("a", 30, "account.identified", "acc-csv", { iban: N1, keys: [`iban:${N1}`] }),
    ev("a", 31, "txn.categorySet", "t-csv", { category: "groceries", source: "manual_txn" }),
    ev("b", 32, "txn.categorySet", "t-ob", { category: "other", source: "llm_full" }),
  ],
  (v) => {
    const rows = Object.values(v.accounts);
    expect(rows).toHaveLength(1);
    expect([...(rows[0]?.members ?? [])].sort()).toEqual(["acc-csv", "acc-ob"]);
    expect(rows[0]?.gid).toBe("acc-ob"); // the root: the earlier holder of the IBAN key
    expect(rows[0]?.name).toBe("mBank eKonto"); // N4: the root's own opened name
    expect(rows[0]?.iban).toBe(`PL${N1}`);
    const txns = Object.values(v.transactions);
    expect(txns).toHaveLength(2); // cross-source duplicate collapsed, h2 kept
    expect(txns.find((t) => t.members.length === 2)?.claim).toBe("groceries"); // manual beats llm
  },
);
scenario(
  B1,
  "an Enable Banking re-consent uid joins the account through its IBAN",
  [
    ev("b", 10, "account.opened", "acc-1", {
      name: "Konto",
      iban: `PL${N1}`,
      externalId: "eb:uid-1",
      keys: [`iban:${N1}`, "ext:mbank:eb:uid-1"],
    }),
    ev("b", 50, "account.opened", "acc-2", {
      name: "Konto",
      iban: `PL${N1}`,
      externalId: "eb:uid-2",
      keys: [`iban:${N1}`, "ext:mbank:eb:uid-2"],
    }),
    ev("b", 60, "txn.imported", "t2", { account: "acc-2", dedupHash: "h9", occurrence: 0 }),
  ],
  (v) => {
    expect(Object.keys(v.accounts)).toEqual(["acc-1"]);
    expect(Object.keys(v.transactions)).toEqual(["acc-1|h9|0"]);
  },
);

const B2 = "B2 signal episodes";
const K = "drawdown|i:inst-1";
scenario(
  B2,
  "lease handover: a new leader that has not seen the open signal joins it",
  [
    ev("a", 10, "signal.opened", "s1", { dedupKey: K, message: "old leader" }),
    ev("b", 20, "signal.opened", "s2", { dedupKey: K, message: "new leader" }),
    ev("p", 30, "decision.recorded", "d1", { signals: ["s2"] }),
  ],
  (v) => {
    expect(Object.keys(v.signals)).toEqual(["s1"]);
    expect(v.signals.s1?.status).toBe("acknowledged");
    expect(v.signals.s1?.aliases).toEqual(["s2"]);
  },
);
scenario(
  B2,
  "split brain: concurrent opens at any hlc give one open episode; a close ends it",
  [
    ev("b", 10, "signal.opened", "s2", { dedupKey: K, message: "b" }),
    ev("a", 10, "signal.opened", "s1", { dedupKey: K, message: "a" }),
    ev("a", 40, "signal.closed", "s1", { status: "resolved", reason: "condition cleared" }),
    ev("b", 50, "signal.opened", "s3", { dedupKey: K, message: "fired again" }),
  ],
  (v) => {
    const open = Object.values(v.signals).filter((e) => e.status === "active");
    expect(open.map((e) => e.gid)).toEqual(["s3"]);
    expect(Object.keys(v.signals).sort()).toEqual(["s1", "s3"]);
  },
);
scenario(
  B2,
  "research signal opened off the lease, dismissed on the phone, restored",
  [
    ev("a", 10, "signal.opened", "r1", { dedupKey: "research:2026-W44|i:inst-1", message: "note" }),
    ev("p", 20, "signal.closed", "r1", { status: "resolved", reason: "note_dismissed" }),
    ev("p", 30, "signal.reopened", "r1", { reason: "note_restored" }),
  ],
  (v) => expect(v.signals.r1?.status).toBe("active"),
);
scenario(
  B2,
  "a reopen is a no-op while another episode of the key is open",
  [
    ev("a", 10, "signal.opened", "s1", { dedupKey: K }),
    ev("a", 20, "signal.closed", "s1", { status: "expired", reason: "delete" }),
    ev("b", 30, "signal.opened", "s2", { dedupKey: K }),
    ev("a", 40, "signal.reopened", "s1", { reason: "alert_restored" }),
  ],
  (v) => {
    expect(v.signals.s1?.status).toBe("expired");
    expect(v.signals.s2?.status).toBe("active");
  },
);
scenario(
  B2,
  "M7: a stale wake never erases a newer owner snooze",
  [
    ev("a", 10, "signal.opened", "s1", { dedupKey: K }),
    ev("p", 15, "signal.snoozed", "s1", { until: "2026-11-01T00:00:00.000Z" }),
    ev("p", 90, "signal.snoozed", "s1", { until: "2026-11-30T00:00:00.000Z" }),
    ev("a", 95, "signal.woken", "s1", { until: "2026-11-01T00:00:00.000Z" }),
  ],
  (v) => expect(v.signals.s1?.snoozedUntil).toBe("2026-11-30T00:00:00.000Z"),
);
scenario(
  B2,
  "decision undo returns the episode to active unless another decision links it",
  [
    ev("a", 10, "signal.opened", "s1", { dedupKey: K }),
    ev("p", 20, "decision.recorded", "d1", { signals: ["s1"] }),
    ev("p", 21, "decision.recorded", "d2", { signals: ["s1"] }),
    ev("p", 30, "decision.undone", "d1", {}),
  ],
  (v) => expect(v.signals.s1).toMatchObject({ status: "acknowledged", decisions: ["d2"] }),
);

const B3 = "B3 instrument merge is a redirect in the fold";
const S = "inst-s";
const T = "inst-t";
for (const phoneWall of [3, 20]) {
  scenario(
    B3,
    `writes against the merged source from a device that missed the merge (phone at ${phoneWall})`,
    [
      ev("a", 5, "instrument.aliasAdded", "al-1", {
        instrument: T,
        namespace: "isin",
        value: "X1",
      }),
      ev("a", 6, "watchlist.added", "w-t", { instrument: T, note: "target note", source: "user" }),
      ev("a", 7, "valuation.set", "v-t", { instrument: T, asOf: "2026-10-01", unitValue: "10" }),
      ev("a", 8, "instrumentOverride.segmentSet", "o-t", {
        instrument: T,
        segment: "gold",
        by: "owner",
      }),
      ev("a", 10, "instrument.merged", S, { source: S, target: T, reason: "owner" }),
      ev("p", phoneWall, "watchlist.added", "w-s", { instrument: S, tags: ["x"], source: "agent" }),
      ev("p", phoneWall + 1, "valuation.set", "v-s", {
        instrument: S,
        asOf: "2026-10-01",
        unitValue: "12",
      }),
      ev("p", phoneWall + 2, "instrumentOverride.segmentSet", "o-s", {
        instrument: S,
        segment: "energy",
        by: "agent",
      }),
      ev("p", phoneWall + 3, "signal.opened", "sig-s", { dedupKey: `rule|i:${S}` }),
      ev("a", 11, "signal.opened", "sig-t", { dedupKey: `rule|i:${T}` }),
    ],
    (v) => {
      expect(Object.keys(v.watchlist)).toEqual([T]);
      expect(v.watchlist[T]?.live).toBe(true);
      expect(v.watchlist[T]?.note).toBe("target note");
      expect(Object.keys(v.valuations)).toEqual([`${T}|2026-10-01`]);
      expect(Object.keys(v.overrides)).toEqual([T]);
      expect(v.overrides[T]?.segment).toBe("gold"); // the agent never overrides the owner's segment
      const open = Object.values(v.signals).filter((e) => e.status === "active");
      expect(open).toHaveLength(1);
      expect(open[0]?.key).toBe(`rule|i:${T}`);
    },
  );
}
scenario(
  B3,
  "concurrent opposite merges resolve to one canonical instrument",
  [
    ev("a", 10, "instrument.merged", "A", { source: "A", target: "B", reason: "owner" }),
    ev("b", 10, "instrument.merged", "B", { source: "B", target: "A", reason: "owner" }),
    ev("a", 20, "watchlist.added", "w-a", { instrument: "A", source: "user" }),
    ev("b", 20, "watchlist.added", "w-b", { instrument: "B", source: "user" }),
  ],
  (v) => expect(Object.keys(v.watchlist)).toHaveLength(1),
);
scenario(
  B3,
  "an alias collision folds the later claimer into the first holder",
  [
    ev("a", 10, "instrument.aliasAdded", "al-a", {
      instrument: "I1",
      namespace: "yahoo",
      value: "T.WA",
    }),
    ev("b", 11, "instrument.aliasAdded", "al-a", {
      instrument: "I2",
      namespace: "yahoo",
      value: "T.WA",
    }),
    ev("b", 12, "watchlist.added", "w2", { instrument: "I2", source: "user" }),
  ],
  (v) => expect(Object.keys(v.watchlist)).toEqual(["I1"]),
);

const M = "majors with order-sensitive rules";
scenario(
  M,
  "M1: a connector binding can be removed and created again",
  [
    ev("a", 10, "connectorBinding.set", "b1", { account: "acc", connectorId: "c", params: {} }),
    ev("a", 20, "connectorBinding.removed", "b1", {}),
    ev("a", 30, "connectorBinding.set", "b1", {
      account: "acc",
      connectorId: "c",
      params: { x: 1 },
    }),
  ],
  (v) => expect(v.bindings["acc|c"]?.live).toBe(true),
);
scenario(
  M,
  "M2: re-adding a removed watchlist entry restores it with the new adder",
  [
    ev("a", 10, "watchlist.added", "w", { instrument: "I", note: "n", source: "user" }),
    ev("a", 20, "watchlist.removed", "w", {}),
    ev("b", 30, "watchlist.added", "w", { instrument: "I", source: "agent" }),
  ],
  (v) => expect(v.watchlist.I).toMatchObject({ live: true, note: "n", source: "agent" }),
);
{
  const approve = ev("a", 30, "proposal.approved", "p1", { result: {} });
  scenario(
    M,
    "M5: a losing approval rolls back its caused cursor and imports",
    [
      ev("a", 5, "connectorBinding.set", "b1", { account: "acc", connectorId: "c", params: {} }),
      ev("a", 6, "connectorBinding.cursorAdvanced", "b1", { cursor: "c-1" }),
      ev("a", 10, "proposal.created", "p1", { kind: "budget_import" }),
      ev("p", 20, "proposal.rejected", "p1", { note: null }),
      approve,
      ev(
        "a",
        31,
        "txn.imported",
        "t1",
        { account: "acc", dedupHash: "h", occurrence: 0 },
        approve.eid,
      ),
      ev("a", 32, "connectorBinding.cursorAdvanced", "b1", { cursor: "c-2" }, approve.eid),
    ],
    (v) => {
      expect(v.proposals.p1).toBe("rejected");
      expect(v.bindings["acc|c"]?.cursor).toBe("c-1");
      expect(Object.keys(v.transactions)).toEqual([]);
    },
  );
}

const RN1 = "v1.2: row addressing after merges (N1)";
scenario(
  RN1,
  "removing a watchlist entry by its member gid after the instrument merged",
  [
    ev("p", 5, "watchlist.added", "w-s", { instrument: "S", source: "user" }),
    ev("a", 10, "instrument.merged", "S", { source: "S", target: "T", reason: "owner" }),
    ev("a", 20, "watchlist.removed", "w-s", {}),
  ],
  (v) => expect(v.watchlist.T).toMatchObject({ gid: "w-s", live: false }),
);
scenario(
  RN1,
  "removing a merged watchlist row removes every live member the view shows",
  [
    ev("a", 5, "watchlist.added", "w-t", { instrument: "T", source: "user" }),
    ev("p", 6, "watchlist.added", "w-s", { instrument: "S", source: "agent" }),
    ev("a", 10, "instrument.merged", "S", { source: "S", target: "T", reason: "owner" }),
    // the view shows the anchor w-t with members [w-t, w-s]: one batch removes both
    ev("a", 20, "watchlist.removed", "w-t", {}),
    ev("a", 21, "watchlist.removed", "w-s", {}),
  ],
  (v) => expect(v.watchlist.T).toMatchObject({ gid: "w-t", live: false }),
);
scenario(
  RN1,
  "a category set on a transaction after its account folded into another",
  [
    ev("a", 10, "account.opened", "A", { name: "A", iban: null, keys: ["ext:mbank:k-a"] }),
    ev("b", 11, "account.opened", "B", { name: "B", iban: `PL${N2}`, keys: [`iban:${N2}`] }),
    ev("a", 12, "txn.imported", "t-a", { account: "A", dedupHash: "h", occurrence: 0 }),
    ev("a", 30, "account.identified", "A", { iban: N2, keys: [`iban:${N2}`] }),
    // the view shows the row under its anchor t-a (its only member): the owner addresses it
    ev("a", 40, "txn.categorySet", "t-a", { category: "fuel", source: "manual_txn" }),
  ],
  (v) => {
    expect(Object.keys(v.transactions)).toEqual(["B|h|0"]);
    expect(v.transactions["B|h|0"]).toMatchObject({ gid: "t-a", claim: "fuel" });
  },
);
scenario(
  RN1,
  "cash leg edits reach the leg through any member's leg gid",
  [
    ev("a", 10, "account.opened", "A", { name: "A", iban: null, keys: ["ext:mbank:k-a"] }),
    ev("b", 11, "account.opened", "B", { name: "B", iban: `PL${N2}`, keys: [`iban:${N2}`] }),
    ev("a", 12, "txn.imported", "t-a", { account: "A", dedupHash: "h", occurrence: 0 }),
    ev("b", 13, "txn.imported", "t-b", { account: "B", dedupHash: "h", occurrence: 0 }),
    ev("b", 14, "txn.categorySet", "t-b", { category: "cash_withdrawal", source: "manual_txn" }),
    ev("b", 14, "account.opened", "pool:PLN", POOL_PLN),
    ev("b", 15, "txn.categorySet", "cashleg:t-b", { category: "cash_other", source: "manual_txn" }),
    ev("a", 30, "account.identified", "A", { iban: N2, keys: [`iban:${N2}`] }),
    ev("a", 40, "txn.categorySet", "cashleg:t-a", { category: "cash_food", source: "manual_txn" }),
  ],
  (v) => {
    const row = v.transactions["B|h|0"];
    expect(row?.members).toEqual(["t-a", "t-b"]);
    expect(row?.gid).toBe("t-a"); // anchor: the first applied member
    expect(row?.leg).toEqual({ gid: "cashleg:t-a", claim: "cash_food" });
  },
);

const RN2 = "v1.2: one IBAN per account, checksum required (N2)";
const n2Base = () => [
  ev("b", 5, "account.opened", "Y", { name: "Real Y", iban: `PL${N1}`, keys: [`iban:${N1}`] }),
  ev("a", 6, "account.opened", "A", { name: "A", iban: null, keys: ["ext:mbank:k-a"] }),
];
for (const [w3, w1] of [
  [20, 21],
  [21, 20],
] as const) {
  scenario(
    RN2,
    `two concurrent IBANs for one account never fuse a third account (walls ${w3} / ${w1})`,
    [
      ...n2Base(),
      ev("a", w3, "account.identified", "A", { iban: N3, keys: [`iban:${N3}`] }),
      ev("p", w1, "account.identified", "A", { iban: N1, keys: [`iban:${N1}`] }),
    ],
    (v) => {
      for (const row of Object.values(v.accounts)) {
        expect(row.iban === null || [N1, N3, `PL${N1}`].includes(row.iban)).toBe(true);
      }
      expect(v.accountConflicts).toHaveLength(1);
      expect(v.accounts.Y?.name).toBe("Real Y");
      if (w3 < w1) {
        expect(Object.keys(v.accounts).sort()).toEqual(["A", "Y"]); // A took N3 first: no fusion
        expect(v.accounts.A?.iban).toBe(N3);
      } else {
        expect(Object.keys(v.accounts)).toEqual(["Y"]); // A joined Y by N1; N3 refused
      }
    },
  );
}
/** `n` with its last digit changed: fails the mod-97 check (a masked or mistyped number). */
const offByOne = (n: string) => `${n.slice(0, -1)}${n.endsWith("1") ? "2" : "1"}`;
{
  const masked = offByOne(N1);
  scenario(
    RN2,
    "an IBAN that fails the mod-97 check is never claimed, but its raw text is kept",
    [
      ...n2Base(),
      ev("a", 20, "account.identified", "A", { iban: masked, keys: [`iban:${masked}`] }),
    ],
    (v) => {
      expect(Object.keys(v.accounts).sort()).toEqual(["A", "Y"]);
      expect(v.accounts.A).toMatchObject({ iban: masked, ibanKey: null });
      expect(v.accountConflicts).toEqual([]);
    },
  );
}
for (const [wBad, wGood] of [
  [20, 21],
  [21, 20],
] as const) {
  // A shows a raw invalid number until a valid one is claimed; the valid one wins in any order.
  scenario(
    RN2,
    `a valid IBAN wins identity and display over an invalid raw one (walls ${wBad} / ${wGood})`,
    [
      ...n2Base(),
      ev("a", wBad, "account.identified", "A", {
        iban: offByOne(N3),
        keys: [`iban:${offByOne(N3)}`],
      }),
      ev("p", wGood, "account.identified", "A", { iban: `PL${N3}`, keys: [`iban:${N3}`] }),
    ],
    (v) => {
      expect(Object.keys(v.accounts).sort()).toEqual(["A", "Y"]);
      expect(v.accounts.A).toMatchObject({ iban: `PL${N3}`, ibanKey: N3 });
      expect(v.accounts.Y).toMatchObject({ iban: `PL${N1}`, ibanKey: N1 });
      expect(v.accountConflicts).toEqual([]);
    },
  );
  // Two devices learn different invalid numbers: the first in fold order is shown, none is a key.
  scenario(
    RN2,
    `two invalid raw IBANs: the first in fold order is shown, never a key (walls ${wBad} / ${wGood})`,
    [
      ...n2Base(),
      ev("a", wBad, "account.identified", "A", { iban: offByOne(N2), keys: ["ext:mbank:k-a2"] }),
      ev("p", wGood, "account.identified", "A", { iban: offByOne(N3), keys: ["ext:mbank:k-a3"] }),
    ],
    (v) => {
      expect(v.accounts.A).toMatchObject({
        iban: wBad < wGood ? offByOne(N2) : offByOne(N3),
        ibanKey: null,
      });
      expect(v.accountConflicts).toEqual([]);
    },
  );
}
scenario(
  RN2,
  "one invalid IBAN on two accounts never merges them",
  [
    ev("a", 5, "account.opened", "A", {
      name: "A",
      iban: offByOne(N1),
      externalId: "k-a",
      keys: [`iban:${offByOne(N1)}`, "ext:mbank:k-a"],
    }),
    ev("b", 5, "account.opened", "B", {
      name: "B",
      iban: offByOne(N1),
      externalId: "k-b",
      keys: [`iban:${offByOne(N1)}`, "ext:mbank:k-b"],
    }),
  ],
  (v) => {
    expect(Object.keys(v.accounts).sort()).toEqual(["A", "B"]);
    for (const row of Object.values(v.accounts)) {
      expect(row).toMatchObject({ iban: offByOne(N1), ibanKey: null, members: [row.gid] });
    }
  },
);

const RN34 = "v1.2: presence and names after merges (N3, N4)";
scenario(
  RN34,
  "N3: removing the duplicate and then merging keeps the target watched",
  [
    ev("a", 5, "watchlist.added", "w-t", { instrument: "T", source: "user" }),
    ev("a", 6, "watchlist.added", "w-s", { instrument: "S", source: "user" }),
    ev("a", 7, "watchlist.removed", "w-s", {}),
    ev("a", 10, "instrument.merged", "S", { source: "S", target: "T", reason: "owner" }),
  ],
  (v) => expect(v.watchlist.T?.live).toBe(true),
);
scenario(
  RN34,
  "N4: an explicit rename beats the root's opened name",
  [
    ev("b", 5, "account.opened", "Y", {
      name: "mBank eKonto",
      iban: `PL${N1}`,
      keys: [`iban:${N1}`],
    }),
    ev("a", 6, "account.opened", "A", { name: "Z CSV", iban: null, keys: ["ext:mbank:k-a"] }),
    ev("a", 20, "account.identified", "A", { iban: N1, keys: [`iban:${N1}`] }),
    ev("p", 30, "account.renamed", "A", { name: "Konto domowe" }),
  ],
  (v) => expect(v.accounts.Y?.name).toBe("Konto domowe"),
);

const G = "v1.2: invalid deterministic gids are parked (events.md 7.10)";
const openA = () => ev("a", 1, "account.opened", "A", { name: "A", keys: ["ext:mbank:k-a"] });
scenario(
  G,
  "G1 invalid-gid: a txn gid that does not match its payload",
  [
    openA(),
    ev("a", 10, "txn.imported", "t1", { account: "A", dedupHash: "h1", occurrence: 0 }),
    ev("b", 11, "txn.imported", "t1", { account: "A", dedupHash: "h2", occurrence: 0 }),
  ],
  (v) => {
    expect(Object.keys(v.transactions)).toEqual(["A|h1|0"]);
    expect(v.transactions["A|h1|0"]?.members).toEqual(["t1"]);
  },
);
scenario(
  G,
  "G2 invalid-gid: two gids for one row key",
  [
    openA(),
    ev("a", 10, "txn.imported", "t1", { account: "A", dedupHash: "h1", occurrence: 0 }),
    ev("b", 5, "txn.imported", "t2", { account: "A", dedupHash: "h1", occurrence: 0 }),
  ],
  (v) => {
    expect(Object.keys(v.transactions)).toEqual(["A|h1|0"]);
    expect(v.transactions["A|h1|0"]).toMatchObject({ gid: "t1", members: ["t1"] });
  },
);
{
  // b1 is bound to (A, c0) by its first declared set; the set of (A, c) under b1 is invalid, so
  // it is never applied and never a valid cause.
  const approve = ev("a", 20, "proposal.approved", "p1", { result: {} });
  const invalidSet = ev(
    "a",
    21,
    "connectorBinding.set",
    "b1",
    { account: "A", connectorId: "c", params: { x: 1 } },
    approve.eid,
  );
  scenario(
    G,
    "G3 a caused event of an invalid-gid event is suppressed",
    [
      ev("a", 5, "connectorBinding.set", "b1", { account: "A", connectorId: "c0", params: {} }),
      ev("a", 10, "proposal.created", "p1", { kind: "budget_import" }),
      approve,
      invalidSet,
      ev("a", 22, "connectorBinding.cursorAdvanced", "b1", { cursor: "c-9" }, invalidSet.eid),
    ],
    (v) => {
      expect(v.proposals.p1).toBe("approved");
      expect(v.bindings["A|c"]).toBeUndefined();
      expect(v.bindings["A|c0"]).toEqual({ live: true, params: {}, cursor: null });
    },
  );
}
scenario(
  G,
  "G4 invalid watchlist add",
  [
    ev("a", 10, "watchlist.added", "w1", { instrument: "I1", source: "user" }),
    ev("b", 11, "watchlist.added", "w1", { instrument: "I2", source: "agent" }),
  ],
  (v) => {
    expect(Object.keys(v.watchlist)).toEqual(["I1"]);
    expect(v.watchlist.I1).toMatchObject({ gid: "w1", live: true, source: "user" });
  },
);

const C = "v1.2: a ULID is created once (events.md 6.2 CREATE)";
scenario(
  C,
  "C1 a signal ULID opened twice",
  [
    ev("a", 10, "signal.opened", "S", { dedupKey: K, message: "m1" }),
    ev("a", 20, "signal.closed", "S", { status: "resolved", reason: "x" }),
    ev("b", 30, "signal.opened", "S", { dedupKey: K, message: "m2" }),
  ],
  (v) => {
    expect(Object.keys(v.signals)).toEqual(["S"]);
    expect(v.signals.S).toMatchObject({ status: "resolved", message: "m1", aliases: [] });
  },
);
scenario(
  C,
  "C2 a proposal created twice",
  [
    ev("a", 10, "proposal.created", "P", { kind: "budget_import" }),
    ev("a", 20, "proposal.approved", "P", { result: {} }),
    ev("b", 30, "proposal.created", "P", { kind: "budget_import" }),
  ],
  (v) => expect(v.proposals).toEqual({ P: "approved" }),
);

const A = "v1.2: an account row exists once an open is applied";
scenario(
  A,
  "A1 an identified-only account has no row",
  [
    ev("a", 10, "account.identified", "A", { keys: ["ext:mbank:k1"] }),
    ev("a", 20, "txn.imported", "t", { account: "A", dedupHash: "h1", occurrence: 0 }),
  ],
  (v) => {
    expect(v.accounts).toEqual({});
    expect(Object.keys(v.transactions)).toEqual(["A|h1|0"]);
  },
);
scenario(
  A,
  "A2 the row appears with the first open of any member",
  [
    ev("a", 10, "account.identified", "A", { keys: ["ext:mbank:k1"] }),
    ev("b", 20, "account.opened", "B", { name: "N", keys: ["ext:mbank:k1"] }),
  ],
  (v) => {
    expect(Object.keys(v.accounts)).toEqual(["A"]);
    expect(v.accounts.A).toMatchObject({ gid: "A", name: "N", members: ["A", "B"] });
  },
);

const P = "S24: profile, modules, balances (events.md 8.2)";
scenario(
  P,
  "P1 the first applied create writes the profile; a rename before it is overwritten, later edits win",
  [
    ev("a", 5, "profile.renamed", "vault", { name: "Early" }),
    ev("a", 10, "profile.created", "vault", { name: "Dom" }),
    ev("b", 11, "profile.created", "vault", { name: "Second", baseCurrency: "EUR" }),
    ev("a", 20, "profile.settingsChanged", "vault", { mcpPrivacy: "amounts" }),
    ev("b", 30, "profile.renamed", "vault", { name: "Dom i praca" }),
  ],
  (v) =>
    expect(v.profile).toEqual({ name: "Dom i praca", baseCurrency: "PLN", mcpPrivacy: "amounts" }),
);
scenario(
  P,
  "P2 no row before a create",
  [ev("a", 5, "profile.renamed", "vault", { name: "Early" })],
  (v) => expect(v.profile).toBeNull(),
);
scenario(
  P,
  "M1 the enabled register: enabled_at moves only when an enable flips it; no row before an enable",
  [
    ev("a", 10, "module.enabled", "m-budget", { moduleId: "budget" }),
    ev("b", 12, "module.enabled", "m-budget", { moduleId: "budget" }),
    ev("a", 20, "module.disabled", "m-loans", { moduleId: "loans" }),
    ev("a", 30, "module.enabled", "m-assets", { moduleId: "assets" }),
    ev("a", 40, "module.disabled", "m-assets", { moduleId: "assets" }),
    ev("b", 50, "module.enabled", "m-assets", { moduleId: "assets" }),
    ev("p", 60, "module.enabled", "m-invest", { moduleId: "investments" }),
    ev("a", 61, "module.disabled", "m-invest", { moduleId: "investments" }),
  ],
  (v) => {
    const at = (ms: number) => new Date(1_793_448_000_000 + ms).toISOString();
    expect(v.modules).toEqual({
      assets: { enabled: true, enabledAt: at(50) },
      budget: { enabled: true, enabledAt: at(10) },
      investments: { enabled: false, enabledAt: at(60) },
    });
  },
);
scenario(
  P,
  "BAL1 balances of merged accounts collapse per (date, source): amount LWW, currency first",
  [
    ev("a", 1, "account.opened", "A", { name: "A", keys: ["ext:mbank:k1"] }),
    ev("b", 2, "account.opened", "B", { name: "B", keys: ["ext:mbank:k2"] }),
    ev("a", 10, "balance.recorded", "bal-a", {
      account: "A",
      date: "2026-10-30",
      amount: "100.00",
    }),
    ev("b", 11, "balance.recorded", "bal-b", {
      account: "B",
      date: "2026-10-30",
      amount: "120.50",
      currency: "EUR",
    }),
    ev("b", 12, "balance.recorded", "bal-b2", {
      account: "B",
      date: "2026-10-30",
      source: "open_banking",
      amount: "7",
    }),
    ev("a", 30, "account.identified", "A", { keys: ["ext:mbank:k2"] }),
  ],
  (v) => {
    expect(Object.keys(v.balances).sort()).toEqual([
      "B|2026-10-30|csv",
      "B|2026-10-30|open_banking",
    ]);
    expect(v.balances["B|2026-10-30|csv"]).toMatchObject({
      gid: "bal-a",
      amount: "120.50",
      currency: "PLN",
    });
  },
);

const K24 = "S24: account key parking (D-24.7, gid.md 4.3)";
{
  const manual = (gid: string, wall: number, name: string) =>
    ev("a", wall, "account.opened", gid, {
      bank: "manual",
      name,
      externalId: "manual:Dom",
      type: "property",
      keys: [],
    });
  scenario(
    K24,
    "PK1 A removed, B opened with its name key, B removed, A restored: A holds the key",
    [
      manual("A", 10, "Dom"),
      ev("a", 20, "account.removed", "A", {}),
      manual("B", 30, "Dom"),
      ev("a", 40, "account.removed", "B", {}),
      ev("a", 50, "account.restored", "A", {}),
    ],
    (v) => {
      expect(v.accounts.A?.externalId).toBe("manual:Dom");
      expect(v.accounts.B?.externalId).toBe("manual:Dom~B");
    },
  );
  scenario(
    K24,
    "PK2 two removed accounts: the latest opened keeps the key; two live both show it (m12)",
    [
      manual("A", 10, "Dom"),
      manual("B", 30, "Dom"),
      ev("a", 40, "account.removed", "B", {}),
      ev("a", 41, "account.removed", "A", {}),
      manual("C", 50, "Dom"),
      manual("D", 51, "Dom"),
    ],
    (v) => {
      expect(v.accounts.A?.externalId).toBe("manual:Dom~A");
      expect(v.accounts.B?.externalId).toBe("manual:Dom~B");
      expect(v.accounts.C?.externalId).toBe("manual:Dom");
      expect(v.accounts.D?.externalId).toBe("manual:Dom");
    },
  );
  scenario(
    K24,
    "PK3 a single removed account keeps its key",
    [manual("A", 10, "Dom"), ev("a", 20, "account.removed", "A", {})],
    (v) => expect(v.accounts.A?.externalId).toBe("manual:Dom"),
  );
}

const CASH = "S24: cash expenses (TOMB) and cash legs (events.md 8.3, D-24.3)";
{
  const bank = () => ev("a", 1, "account.opened", "A", { name: "A", keys: ["ext:mbank:k-a"] });
  const pool = (wall: number) => ev("b", wall, "account.opened", "pool:PLN", POOL_PLN);
  const withdrawal = () =>
    ev("a", 10, "txn.imported", "t", { account: "A", dedupHash: "h", occurrence: 0 });
  const markCash = (wall: number) =>
    ev("a", wall, "txn.categorySet", "t", { category: "cash_withdrawal", source: "manual_txn" });
  scenario(
    CASH,
    "L1 the leg appears only once the cash pool account is open, whatever arrives first",
    [bank(), withdrawal(), markCash(20), pool(30)],
    (v) => expect(v.transactions["A|h|0"]?.leg).toEqual({ gid: "cashleg:t", claim: null }),
  );
  scenario(
    CASH,
    "L2 no pool account: no leg; an llm cash_withdrawal claim or a clear: no leg",
    [
      bank(),
      withdrawal(),
      ev("a", 11, "txn.imported", "t2", { account: "A", dedupHash: "h2", occurrence: 0 }),
      markCash(20),
      ev("a", 21, "txn.categorySet", "t2", { category: "cash_withdrawal", source: "llm_full" }),
      pool(30),
      ev("a", 40, "txn.categoryCleared", "t", {}),
    ],
    (v) => {
      expect(v.transactions["A|h|0"]?.leg).toBeNull();
      expect(v.transactions["A|h2|0"]?.leg).toBeNull();
    },
  );
  scenario(
    CASH,
    "L3 a withdrawal on a cash account mirrors nothing; a leg claim persists while the leg is absent",
    [
      ev("a", 1, "account.opened", "C", { name: "C", type: "cash", keys: ["ext:manual:k-c"] }),
      ev("a", 10, "txn.imported", "tc", { account: "C", dedupHash: "h", occurrence: 0 }),
      ev("a", 20, "txn.categorySet", "tc", { category: "cash_withdrawal", source: "manual_txn" }),
      bank(),
      withdrawal(),
      ev("a", 25, "txn.categorySet", "cashleg:t", { category: "cash_food", source: "manual_txn" }),
      pool(30),
      markCash(40),
    ],
    (v) => {
      expect(v.transactions["C|h|0"]?.leg).toBeNull();
      expect(v.transactions["A|h|0"]?.leg).toEqual({ gid: "cashleg:t", claim: "cash_food" });
    },
  );
  scenario(
    CASH,
    "E1 a cash expense: claims after its delete and a second add of its gid are no-ops",
    [
      pool(1),
      ev("a", 10, "txn.cashExpenseAdded", "x1", { account: "pool:PLN" }),
      ev("a", 11, "txn.cashExpenseAdded", "x2", { account: "pool:PLN", category: "transport" }),
      ev("a", 20, "txn.categorySet", "x2", { category: "fuel", source: "manual_txn" }),
      ev("b", 21, "txn.categorySet", "x2", { category: "other", source: "llm_full" }),
      ev("a", 30, "txn.deleted", "x1", {}),
      ev("a", 31, "txn.categorySet", "x1", { category: "fuel", source: "manual_txn" }),
      ev("b", 40, "txn.cashExpenseAdded", "x1", { account: "pool:PLN", title: "Again" }),
    ],
    (v) => expect(v.cashExpenses).toEqual({ x2: { claim: "fuel", claimBy: "manual_txn" } }),
  );
  scenario(
    CASH,
    "E2 a delete addressed to an import row or sorting before the add is a no-op",
    [
      pool(1),
      bank(),
      withdrawal(),
      ev("a", 5, "txn.deleted", "x1", {}),
      ev("a", 10, "txn.cashExpenseAdded", "x1", { account: "pool:PLN" }),
      ev("a", 30, "txn.deleted", "t", {}),
    ],
    (v) => {
      expect(Object.keys(v.cashExpenses)).toEqual(["x1"]);
      expect(Object.keys(v.transactions)).toEqual(["A|h|0"]);
    },
  );
}

const LA = "S24: loans and asset notes (events.md 8.4, m7, D-24.9)";
{
  const loanAcc = (gid: string, wall: number, key: string) =>
    ev("a", wall, "account.opened", gid, { name: gid, type: "mortgage", keys: [key] });
  const terms = (gid: string, wall: number, account: string, principal: string) =>
    ev("a", wall, "loan.termsSet", gid, {
      account,
      principal,
      annualRate: "6.5",
      termMonths: 360,
      startDate: "2026-01-10",
      originationDate: null,
    });
  scenario(
    LA,
    "LN1 payment matching before terms: no row until terms, then both; terms LWW",
    [
      loanAcc("A", 1, "ext:mbank:loan-1"),
      ev("b", 10, "loan.paymentMatchingSet", "loan-a", {
        account: "A",
        paymentIban: "PL61109010140000071219812874",
        paymentText: null,
      }),
      terms("loan-a", 20, "A", "300000.00"),
      terms("loan-a", 30, "A", "290000.00"),
    ],
    (v) =>
      expect(v.loans).toEqual({
        A: {
          gid: "loan-a",
          principal: "290000.00",
          paymentIban: "PL61109010140000071219812874",
          paymentText: null,
        },
      }),
  );
  scenario(
    LA,
    "LN2 matching only: no loan row",
    [
      loanAcc("A", 1, "ext:mbank:loan-1"),
      ev("b", 10, "loan.paymentMatchingSet", "loan-a", {
        account: "A",
        paymentIban: null,
        paymentText: "RATA",
      }),
    ],
    (v) => expect(v.loans).toEqual({}),
  );
  scenario(
    LA,
    "LN3 two accounts' loans collapse when the accounts merge (LWW over the merged stream)",
    [
      loanAcc("A", 1, "ext:mbank:loan-1"),
      loanAcc("B", 2, "ext:mbank:loan-2"),
      terms("loan-a", 10, "A", "100.00"),
      terms("loan-b", 20, "B", "200.00"),
      ev("a", 30, "account.identified", "B", { keys: ["ext:mbank:loan-1"] }),
    ],
    (v) =>
      expect(v.loans).toEqual({
        A: { gid: "loan-a", principal: "200.00", paymentIban: null, paymentText: null },
      }),
  );
  scenario(
    LA,
    "N1 a null note creates no row; once a row exists a null note keeps it",
    [
      ev("a", 1, "account.opened", "H", {
        bank: "manual",
        name: "Dom",
        type: "property",
        keys: [],
      }),
      ev("a", 2, "account.opened", "K", {
        bank: "manual",
        name: "Auto",
        type: "vehicle",
        keys: [],
      }),
      ev("a", 10, "assetDetails.noteSet", "note-h", { account: "H", note: null }),
      ev("a", 20, "assetDetails.noteSet", "note-k", { account: "K", note: "garaż" }),
      ev("b", 30, "assetDetails.noteSet", "note-k", { account: "K", note: null }),
    ],
    (v) => expect(v.notes).toEqual({ K: { gid: "note-k", note: null } }),
  );
}

/** Every scenario, in a fixed order. */
export const SCENARIOS: readonly Scenario[] = out;
