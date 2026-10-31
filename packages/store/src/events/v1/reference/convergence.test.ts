// Convergence tests for every review blocker (B1-B3) and the order-sensitive majors (M1, M2, M5, M7):
// each scenario is delivered in many shuffled orders with re-delivered duplicates; every prefix keeps
// the invariants and every full delivery yields the same view, which has the expected shape.
import { describe, expect, it } from "vitest";
import { formatHlc } from "../hlc-format.js";
import { materialize, type RefEvent, type RefView } from "./fold.js";

const DEV = { a: "aaaaaaaaaaaaaaaa", b: "bbbbbbbbbbbbbbbb", p: "pppppppppppppppp" } as const;
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
  const eid = `01JC${String(seq).padStart(22, "0")}`;
  return {
    eid,
    hlc: formatHlc({ wall: 1_793_448_000_000 + wall, counter: 0, device: DEV[device] }),
    at: new Date(1_793_448_000_000 + wall).toISOString(),
    type,
    gid,
    data,
    ...(cause === undefined ? {} : { cause }),
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const r = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function invariants(v: RefView): void {
  const open = new Map<string, number>();
  for (const ep of Object.values(v.signals)) {
    if (ep.status === "active" || ep.status === "acknowledged") {
      open.set(ep.key, (open.get(ep.key) ?? 0) + 1);
    }
  }
  for (const [key, n] of open) expect(n, `open episodes for ${key}`).toBe(1);
}

/** Deliver `events` in `orders` shuffles (+ duplicates); check prefixes; return the common view. */
function converge(events: RefEvent[], orders = 40): RefView {
  const reference = materialize(events);
  invariants(reference);
  for (let k = 0; k < orders; k++) {
    const order = shuffled(events, k + 1);
    const withDupes = [...order, ...shuffled(order, k + 1000).slice(0, 3)];
    for (let i = 1; i <= withDupes.length; i++) invariants(materialize(withDupes.slice(0, i)));
    expect(materialize(withDupes)).toEqual(reference);
  }
  return reference;
}

// Synthetic gids (format irrelevant to the reference fold).
/** A synthetic Polish NRB with valid mod-97 check digits for a 24-digit BBAN. */
function nrb(bban24: string): string {
  const check = 98n - (BigInt(`${bban24}252100`) % 97n);
  return `${check.toString().padStart(2, "0")}${bban24}`;
}
const N1 = nrb("114000000000000000000001");
const N2 = nrb("114000000000000000000002");
const N3 = nrb("114000000000000000000003");

describe("B1 account identity", () => {
  it("CSV without IBAN and Open Banking by IBAN become one account once the IBAN is learned", () => {
    const csvAcc = "acc-csv";
    const obAcc = "acc-ob";
    const evs = [
      ev("a", 10, "account.opened", csvAcc, {
        name: "Konto z CSV",
        iban: null,
        externalId: "csv-noiban:123",
        keys: ["ext:mbank:csv-noiban:123"],
      }),
      ev("b", 11, "account.opened", obAcc, {
        name: "mBank eKonto",
        iban: `PL${N1}`,
        externalId: "eb:uid-1",
        keys: [`iban:${N1}`, "ext:mbank:eb:uid-1"],
      }),
      ev("a", 20, "txn.imported", "t-csv", { account: csvAcc, dedupHash: "h1", occurrence: 0 }),
      ev("b", 21, "txn.imported", "t-ob", { account: obAcc, dedupHash: "h1", occurrence: 0 }),
      ev("b", 22, "txn.imported", "t-ob2", { account: obAcc, dedupHash: "h2", occurrence: 0 }),
      ev("a", 30, "account.identified", csvAcc, { iban: N1, keys: [`iban:${N1}`] }),
      ev("a", 31, "txn.categorySet", "t-csv", { category: "groceries", source: "manual_txn" }),
      ev("b", 32, "txn.categorySet", "t-ob", { category: "other", source: "llm_full" }),
    ];
    const v = converge(evs);
    const rows = Object.values(v.accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.members.sort()).toEqual([csvAcc, obAcc]);
    expect(rows[0]?.gid).toBe(obAcc); // the root: the earlier holder of the IBAN key
    expect(rows[0]?.name).toBe("mBank eKonto"); // N4: the root's own opened name
    expect(rows[0]?.iban).toBe(`PL${N1}`);
    const txns = Object.values(v.transactions);
    expect(txns).toHaveLength(2); // cross-source duplicate collapsed, h2 kept
    expect(txns.find((t) => t.members.length === 2)?.claim).toBe("groceries"); // manual beats llm
  });

  it("an Enable Banking re-consent uid joins the account through its IBAN", () => {
    const evs = [
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
    ];
    const v = converge(evs);
    expect(Object.keys(v.accounts)).toEqual(["acc-1"]);
    expect(Object.keys(v.transactions)).toEqual(["acc-1|h9|0"]);
  });
});

describe("B2 signal episodes", () => {
  const K = "drawdown|i:inst-1";

  it("lease handover: a new leader that has not seen the open signal joins it", () => {
    const evs = [
      ev("a", 10, "signal.opened", "s1", { dedupKey: K, message: "old leader" }),
      ev("b", 20, "signal.opened", "s2", { dedupKey: K, message: "new leader" }),
      ev("p", 30, "decision.recorded", "d1", { signals: ["s2"] }),
    ];
    const v = converge(evs);
    expect(Object.keys(v.signals)).toEqual(["s1"]);
    expect(v.signals.s1?.status).toBe("acknowledged");
    expect(v.signals.s1?.aliases).toEqual(["s2"]);
  });

  it("split brain: concurrent opens at any hlc give one open episode; a close ends it", () => {
    const evs = [
      ev("b", 10, "signal.opened", "s2", { dedupKey: K, message: "b" }),
      ev("a", 10, "signal.opened", "s1", { dedupKey: K, message: "a" }),
      ev("a", 40, "signal.closed", "s1", { status: "resolved", reason: "condition cleared" }),
      ev("b", 50, "signal.opened", "s3", { dedupKey: K, message: "fired again" }),
    ];
    const v = converge(evs);
    const open = Object.values(v.signals).filter((e) => e.status === "active");
    expect(open.map((e) => e.gid)).toEqual(["s3"]);
    expect(Object.keys(v.signals).sort()).toEqual(["s1", "s3"]);
  });

  it("research signal opened off the lease, dismissed on the phone, restored", () => {
    const R = "research:2026-W44|i:inst-1";
    const evs = [
      ev("a", 10, "signal.opened", "r1", { dedupKey: R, message: "note" }),
      ev("p", 20, "signal.closed", "r1", { status: "resolved", reason: "note_dismissed" }),
      ev("p", 30, "signal.reopened", "r1", { reason: "note_restored" }),
    ];
    const v = converge(evs);
    expect(v.signals.r1?.status).toBe("active");
  });

  it("a reopen is a no-op while another episode of the key is open", () => {
    const evs = [
      ev("a", 10, "signal.opened", "s1", { dedupKey: K }),
      ev("a", 20, "signal.closed", "s1", { status: "expired", reason: "delete" }),
      ev("b", 30, "signal.opened", "s2", { dedupKey: K }),
      ev("a", 40, "signal.reopened", "s1", { reason: "alert_restored" }),
    ];
    const v = converge(evs);
    expect(v.signals.s1?.status).toBe("expired");
    expect(v.signals.s2?.status).toBe("active");
  });

  it("M7: a stale wake never erases a newer owner snooze", () => {
    const evs = [
      ev("a", 10, "signal.opened", "s1", { dedupKey: K }),
      ev("p", 15, "signal.snoozed", "s1", { until: "2026-11-01T00:00:00.000Z" }),
      ev("p", 90, "signal.snoozed", "s1", { until: "2026-11-30T00:00:00.000Z" }),
      ev("a", 95, "signal.woken", "s1", { until: "2026-11-01T00:00:00.000Z" }),
    ];
    const v = converge(evs);
    expect(v.signals.s1?.snoozedUntil).toBe("2026-11-30T00:00:00.000Z");
  });
});

describe("B3 instrument merge is a redirect in the fold", () => {
  const S = "inst-s";
  const T = "inst-t";
  const scenario = (phoneWall: number) => [
    ev("a", 5, "instrument.aliasAdded", "al-1", { instrument: T, namespace: "isin", value: "X1" }),
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
  ];

  it.each([3, 20])(
    "writes against the merged source from a device that missed the merge (phone at %i)",
    (wall) => {
      const v = converge(scenario(wall));
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

  it("concurrent opposite merges resolve to one canonical instrument", () => {
    const evs = [
      ev("a", 10, "instrument.merged", "A", { source: "A", target: "B", reason: "owner" }),
      ev("b", 10, "instrument.merged", "B", { source: "B", target: "A", reason: "owner" }),
      ev("a", 20, "watchlist.added", "w-a", { instrument: "A", source: "user" }),
      ev("b", 20, "watchlist.added", "w-b", { instrument: "B", source: "user" }),
    ];
    const v = converge(evs);
    expect(Object.keys(v.watchlist)).toHaveLength(1);
  });

  it("an alias collision folds the later claimer into the first holder", () => {
    const evs = [
      ev("a", 10, "instrument.aliasAdded", "al-a", {
        instrument: "I1",
        namespace: "yahoo",
        value: "T.WA",
      }),
      ev("b", 11, "instrument.aliasAdded", "al-b", {
        instrument: "I2",
        namespace: "yahoo",
        value: "T.WA",
      }),
      ev("b", 12, "watchlist.added", "w2", { instrument: "I2", source: "user" }),
    ];
    const v = converge(evs);
    expect(Object.keys(v.watchlist)).toEqual(["I1"]);
  });
});

describe("majors with order-sensitive rules", () => {
  it("M1: a connector binding can be removed and created again", () => {
    const evs = [
      ev("a", 10, "connectorBinding.set", "b1", { account: "acc", connectorId: "c", params: {} }),
      ev("a", 20, "connectorBinding.removed", "b1", {}),
      ev("a", 30, "connectorBinding.set", "b1", {
        account: "acc",
        connectorId: "c",
        params: { x: 1 },
      }),
    ];
    const v = converge(evs);
    expect(v.bindings["acc|c"]?.live).toBe(true);
  });

  it("M2: re-adding a removed watchlist entry restores it with the new adder", () => {
    const evs = [
      ev("a", 10, "watchlist.added", "w", { instrument: "I", note: "n", source: "user" }),
      ev("a", 20, "watchlist.removed", "w", {}),
      ev("b", 30, "watchlist.added", "w", { instrument: "I", source: "agent" }),
    ];
    const v = converge(evs);
    expect(v.watchlist.I).toMatchObject({ live: true, note: "n", source: "agent" });
  });

  it("M5: a losing approval rolls back its caused cursor and imports", () => {
    const approve = ev("a", 30, "proposal.approved", "p1", { result: {} });
    const evs = [
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
    ];
    const v = converge(evs);
    expect(v.proposals.p1).toBe("rejected");
    expect(v.bindings["acc|c"]?.cursor).toBe("c-1");
    expect(Object.keys(v.transactions)).toEqual([]);
  });
});

describe("v1.2: row addressing after merges (N1)", () => {
  it("removing a watchlist entry by its member gid after the instrument merged", () => {
    const evs = [
      ev("p", 5, "watchlist.added", "w-s", { instrument: "S", source: "user" }),
      ev("a", 10, "instrument.merged", "S", { source: "S", target: "T", reason: "owner" }),
      ev("a", 20, "watchlist.removed", "w-s", {}),
    ];
    const v = converge(evs);
    expect(v.watchlist.T).toMatchObject({ gid: "w-s", live: false });
  });

  it("removing a merged watchlist row removes every live member the view shows", () => {
    const evs = [
      ev("a", 5, "watchlist.added", "w-t", { instrument: "T", source: "user" }),
      ev("p", 6, "watchlist.added", "w-s", { instrument: "S", source: "agent" }),
      ev("a", 10, "instrument.merged", "S", { source: "S", target: "T", reason: "owner" }),
      // the view shows the anchor w-t with members [w-t, w-s]: one batch removes both
      ev("a", 20, "watchlist.removed", "w-t", {}),
      ev("a", 21, "watchlist.removed", "w-s", {}),
    ];
    const v = converge(evs);
    expect(v.watchlist.T).toMatchObject({ gid: "w-t", live: false });
  });

  it("a category set on a transaction after its account folded into another", () => {
    const evs = [
      ev("a", 10, "account.opened", "A", { name: "A", iban: null, keys: ["ext:mbank:k-a"] }),
      ev("b", 11, "account.opened", "B", { name: "B", iban: `PL${N2}`, keys: [`iban:${N2}`] }),
      ev("a", 12, "txn.imported", "t-a", { account: "A", dedupHash: "h", occurrence: 0 }),
      ev("a", 30, "account.identified", "A", { iban: N2, keys: [`iban:${N2}`] }),
      // the view shows the row under its anchor t-a (its only member): the owner addresses it
      ev("a", 40, "txn.categorySet", "t-a", { category: "fuel", source: "manual_txn" }),
    ];
    const v = converge(evs);
    expect(Object.keys(v.transactions)).toEqual(["B|h|0"]);
    expect(v.transactions["B|h|0"]).toMatchObject({ gid: "t-a", claim: "fuel" });
  });

  it("cash leg edits reach the leg through any member's leg gid", () => {
    const evs = [
      ev("a", 10, "account.opened", "A", { name: "A", iban: null, keys: ["ext:mbank:k-a"] }),
      ev("b", 11, "account.opened", "B", { name: "B", iban: `PL${N2}`, keys: [`iban:${N2}`] }),
      ev("a", 12, "txn.imported", "t-a", { account: "A", dedupHash: "h", occurrence: 0 }),
      ev("b", 13, "txn.imported", "t-b", { account: "B", dedupHash: "h", occurrence: 0 }),
      ev("b", 14, "txn.categorySet", "t-b", { category: "cash_withdrawal", source: "manual_txn" }),
      ev("b", 15, "txn.categorySet", "cashleg:t-b", {
        category: "cash_other",
        source: "manual_txn",
      }),
      ev("a", 30, "account.identified", "A", { iban: N2, keys: [`iban:${N2}`] }),
      ev("a", 40, "txn.categorySet", "cashleg:t-a", {
        category: "cash_food",
        source: "manual_txn",
      }),
    ];
    const v = converge(evs);
    const row = v.transactions["B|h|0"];
    expect(row?.members).toEqual(["t-a", "t-b"]);
    expect(row?.gid).toBe("t-a"); // anchor: the first applied member
    expect(row?.leg).toEqual({ gid: "cashleg:t-a", claim: "cash_food" });
  });
});

describe("v1.2: one IBAN per account, checksum required (N2)", () => {
  const base = [
    ev("b", 5, "account.opened", "Y", { name: "Real Y", iban: `PL${N1}`, keys: [`iban:${N1}`] }),
    ev("a", 6, "account.opened", "A", { name: "A", iban: null, keys: ["ext:mbank:k-a"] }),
  ];

  it.each([
    [20, 21],
    [21, 20],
  ])(
    "two concurrent IBANs for one account never fuse a third account (walls %i / %i)",
    (w3, w1) => {
      const evs = [
        ...base,
        ev("a", w3, "account.identified", "A", { iban: N3, keys: [`iban:${N3}`] }),
        ev("p", w1, "account.identified", "A", { iban: N1, keys: [`iban:${N1}`] }),
      ];
      const v = converge(evs);
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

  it("an IBAN that fails the mod-97 check is never claimed", () => {
    const masked = `${N1.slice(0, 25)}${N1.endsWith("1") ? "2" : "1"}`; // one digit off
    const evs = [
      ...base,
      ev("a", 20, "account.identified", "A", { iban: masked, keys: [`iban:${masked}`] }),
    ];
    const v = converge(evs);
    expect(Object.keys(v.accounts).sort()).toEqual(["A", "Y"]);
    expect(v.accounts.A?.iban).toBeNull();
  });
});

describe("v1.2: presence and names after merges (N3, N4)", () => {
  it("N3: removing the duplicate and then merging keeps the target watched", () => {
    const evs = [
      ev("a", 5, "watchlist.added", "w-t", { instrument: "T", source: "user" }),
      ev("a", 6, "watchlist.added", "w-s", { instrument: "S", source: "user" }),
      ev("a", 7, "watchlist.removed", "w-s", {}),
      ev("a", 10, "instrument.merged", "S", { source: "S", target: "T", reason: "owner" }),
    ];
    const v = converge(evs);
    expect(v.watchlist.T?.live).toBe(true);
  });

  it("N4: an explicit rename beats the root's opened name", () => {
    const evs = [
      ev("b", 5, "account.opened", "Y", {
        name: "mBank eKonto",
        iban: `PL${N1}`,
        keys: [`iban:${N1}`],
      }),
      ev("a", 6, "account.opened", "A", { name: "Z CSV", iban: null, keys: ["ext:mbank:k-a"] }),
      ev("a", 20, "account.identified", "A", { iban: N1, keys: [`iban:${N1}`] }),
      ev("p", 30, "account.renamed", "A", { name: "Konto domowe" }),
    ];
    const v = converge(evs);
    expect(v.accounts.Y?.name).toBe("Konto domowe");
  });
});
