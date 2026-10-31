// Acceptance: the production store agrees with the executable reference fold
// (`events/v1/reference/fold.ts`) on every scenario of `reference/convergence.test.ts`, and converges
// itself: every shuffled delivery (single events and random batches, with re-delivered duplicates)
// gives the same view hash, and a rebuild from the log gives that hash too.
//
// The scenarios are copied from reference/convergence.test.ts (same events, same expectations) with
// the payload fields the zod schemas require filled in (`complete`), so the reference and the store
// fold exactly the same data. Synthetic names stand for gids; `toEnvelope` maps them to valid gids
// and `project` maps the store's view back to the reference's shape.
// Follow-up for the lead: extract the scenarios into a shared module next to the reference.
import { describe, expect, it } from "vitest";
import { formatHlc } from "./events/v1/hlc-format.js";
import { materialize, type RefEvent, type RefView } from "./events/v1/reference/fold.js";
import type { Store } from "./materialize.js";
import { viewHash } from "./snapshot.js";
import { complete, Names, normalize, project, toEnvelopes } from "./testing/reference-bridge.js";
import { chunked, openTestStore, shuffled } from "./testing/store.js";

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
  return complete({
    eid,
    hlc: formatHlc({ wall: 1_793_448_000_000 + wall, counter: 0, device: DEV[device] }),
    at: new Date(1_793_448_000_000 + wall).toISOString(),
    type,
    gid,
    data,
    ...(cause === undefined ? {} : { cause }),
  });
}

// --------------------------------------------------------------------------------------------- //
// The convergence driver

function openInvariant(store: Store): void {
  const dup = store.read<{ n: number }>(
    "SELECT COUNT(*) AS n FROM (SELECT dedup_key FROM inv_signals WHERE status IN ('active','acknowledged') GROUP BY dedup_key HAVING COUNT(*) > 1)",
  )[0];
  expect(dup?.n).toBe(0);
}

/**
 * Deliver the scenario in `orders` shuffles (single events for even k, random batches for odd k)
 * plus re-delivered duplicates; check the invariant after every batch; return the projected view.
 */
function converge(events: RefEvent[], orders = 40): RefView {
  const expected = normalize(materialize(events));
  let hash: string | undefined;
  let view: RefView | undefined;
  for (let k = 0; k < orders; k++) {
    const names = new Names();
    const envs = toEnvelopes(events, names);
    const order = shuffled(envs, k + 1);
    const withDupes = [...order, ...shuffled(order, k + 1000).slice(0, 3)];
    const store = openTestStore();
    const batches = k % 2 === 0 ? withDupes.map((e) => [e]) : chunked(withDupes, k + 7);
    for (const b of batches) {
      store.applyEnvelopes(b);
      openInvariant(store);
    }
    const projected = project(store, names);
    expect(projected).toEqual(expected);
    const h = viewHash(store).hash;
    if (hash === undefined) hash = h;
    expect(h).toBe(hash);
    store.rebuild();
    expect(viewHash(store).hash).toBe(hash);
    view = projected;
  }
  return view as RefView;
}

// --------------------------------------------------------------------------------------------- //
// Scenarios (copied from reference/convergence.test.ts)

function nrb(bban24: string): string {
  const check = 98n - (BigInt(`${bban24}252100`) % 97n);
  return `${check.toString().padStart(2, "0")}${bban24}`;
}
const N1 = nrb("114000000000000000000001");
const N2 = nrb("114000000000000000000002");
const N3 = nrb("114000000000000000000003");

describe("production fold = reference fold: B1 account identity", () => {
  it("CSV without IBAN and Open Banking by IBAN become one account once the IBAN is learned", () => {
    const evs = [
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
    ];
    const v = converge(evs);
    expect(Object.keys(v.accounts)).toEqual(["acc-ob"]);
    expect(v.accounts["acc-ob"]?.name).toBe("mBank eKonto");
    expect(Object.values(v.transactions)).toHaveLength(2);
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
    expect(Object.keys(v.transactions)).toEqual(["acc-1|h9|0"]);
  });
});

describe("production fold = reference fold: B2 signal episodes", () => {
  const K = "drawdown|i:inst-1";

  it("lease handover: a new leader that has not seen the open signal joins it", () => {
    const v = converge([
      ev("a", 10, "signal.opened", "s1", { dedupKey: K, message: "old leader" }),
      ev("b", 20, "signal.opened", "s2", { dedupKey: K, message: "new leader" }),
      ev("p", 30, "decision.recorded", "d1", { signals: ["s2"] }),
    ]);
    expect(v.signals.s1?.status).toBe("acknowledged");
  });

  it("split brain: concurrent opens at any hlc give one open episode; a close ends it", () => {
    converge([
      ev("b", 10, "signal.opened", "s2", { dedupKey: K, message: "b" }),
      ev("a", 10, "signal.opened", "s1", { dedupKey: K, message: "a" }),
      ev("a", 40, "signal.closed", "s1", { status: "resolved", reason: "condition cleared" }),
      ev("b", 50, "signal.opened", "s3", { dedupKey: K, message: "fired again" }),
    ]);
  });

  it("research signal opened off the lease, dismissed on the phone, restored", () => {
    const R = "research:2026-W44|i:inst-1";
    converge([
      ev("a", 10, "signal.opened", "r1", { dedupKey: R, message: "note" }),
      ev("p", 20, "signal.closed", "r1", { status: "resolved", reason: "note_dismissed" }),
      ev("p", 30, "signal.reopened", "r1", { reason: "note_restored" }),
    ]);
  });

  it("a reopen is a no-op while another episode of the key is open", () => {
    converge([
      ev("a", 10, "signal.opened", "s1", { dedupKey: K }),
      ev("a", 20, "signal.closed", "s1", { status: "expired", reason: "delete" }),
      ev("b", 30, "signal.opened", "s2", { dedupKey: K }),
      ev("a", 40, "signal.reopened", "s1", { reason: "alert_restored" }),
    ]);
  });

  it("M7: a stale wake never erases a newer owner snooze", () => {
    converge([
      ev("a", 10, "signal.opened", "s1", { dedupKey: K }),
      ev("p", 15, "signal.snoozed", "s1", { until: "2026-11-01T00:00:00.000Z" }),
      ev("p", 90, "signal.snoozed", "s1", { until: "2026-11-30T00:00:00.000Z" }),
      ev("a", 95, "signal.woken", "s1", { until: "2026-11-01T00:00:00.000Z" }),
    ]);
  });

  it("decision undo returns the episode to active (production-only extension)", () => {
    const v = converge([
      ev("a", 10, "signal.opened", "s1", { dedupKey: K }),
      ev("p", 20, "decision.recorded", "d1", { signals: ["s1"] }),
      ev("p", 21, "decision.recorded", "d2", { signals: ["s1"] }),
      ev("p", 30, "decision.undone", "d1", {}),
    ]);
    expect(v.signals.s1).toMatchObject({ status: "acknowledged", decisions: ["d2"] });
  });
});

describe("production fold = reference fold: B3 instrument merge is a redirect", () => {
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
    "writes against the merged source from a device that missed it (phone at %i)",
    (w) => {
      const v = converge(scenario(w));
      expect(v.overrides[T]?.segment).toBe("gold");
    },
  );

  it("concurrent opposite merges resolve to one canonical instrument", () => {
    const v = converge([
      ev("a", 10, "instrument.merged", "A", { source: "A", target: "B", reason: "owner" }),
      ev("b", 10, "instrument.merged", "B", { source: "B", target: "A", reason: "owner" }),
      ev("a", 20, "watchlist.added", "w-a", { instrument: "A", source: "user" }),
      ev("b", 20, "watchlist.added", "w-b", { instrument: "B", source: "user" }),
    ]);
    expect(Object.keys(v.watchlist)).toHaveLength(1);
  });

  it("an alias collision folds the later claimer into the first holder", () => {
    converge([
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
    ]);
  });
});

describe("production fold = reference fold: order-sensitive majors", () => {
  it("M1: a connector binding can be removed and created again", () => {
    converge([
      ev("a", 10, "connectorBinding.set", "b1", { account: "acc", connectorId: "c", params: {} }),
      ev("a", 20, "connectorBinding.removed", "b1", {}),
      ev("a", 30, "connectorBinding.set", "b1", {
        account: "acc",
        connectorId: "c",
        params: { x: 1 },
      }),
    ]);
  });

  it("M2: re-adding a removed watchlist entry restores it with the new adder", () => {
    converge([
      ev("a", 10, "watchlist.added", "w", { instrument: "I", note: "n", source: "user" }),
      ev("a", 20, "watchlist.removed", "w", {}),
      ev("b", 30, "watchlist.added", "w", { instrument: "I", source: "agent" }),
    ]);
  });

  it("M5: a losing approval rolls back its caused cursor and imports", () => {
    const approve = ev("a", 30, "proposal.approved", "p1", { result: {} });
    const v = converge([
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
    ]);
    expect(v.bindings["acc|c"]?.cursor).toBe("c-1");
  });
});

describe("production fold = reference fold: v1.2 row addressing (N1)", () => {
  it("removing a watchlist entry by its member gid after the instrument merged", () => {
    converge([
      ev("p", 5, "watchlist.added", "w-s", { instrument: "S", source: "user" }),
      ev("a", 10, "instrument.merged", "S", { source: "S", target: "T", reason: "owner" }),
      ev("a", 20, "watchlist.removed", "w-s", {}),
    ]);
  });

  it("removing a merged watchlist row removes every live member the view shows", () => {
    converge([
      ev("a", 5, "watchlist.added", "w-t", { instrument: "T", source: "user" }),
      ev("p", 6, "watchlist.added", "w-s", { instrument: "S", source: "agent" }),
      ev("a", 10, "instrument.merged", "S", { source: "S", target: "T", reason: "owner" }),
      ev("a", 20, "watchlist.removed", "w-t", {}),
      ev("a", 21, "watchlist.removed", "w-s", {}),
    ]);
  });

  it("a category set on a transaction after its account folded into another", () => {
    converge([
      ev("a", 10, "account.opened", "A", { name: "A", iban: null, keys: ["ext:mbank:k-a"] }),
      ev("b", 11, "account.opened", "B", { name: "B", iban: `PL${N2}`, keys: [`iban:${N2}`] }),
      ev("a", 12, "txn.imported", "t-a", { account: "A", dedupHash: "h", occurrence: 0 }),
      ev("a", 30, "account.identified", "A", { iban: N2, keys: [`iban:${N2}`] }),
      ev("a", 40, "txn.categorySet", "t-a", { category: "fuel", source: "manual_txn" }),
    ]);
  });

  it("cash leg edits reach the leg through any member's leg gid", () => {
    const v = converge([
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
    ]);
    expect(v.transactions["B|h|0"]?.leg).toEqual({ gid: "cashleg:t-a", claim: "cash_food" });
  });
});

describe("production fold = reference fold: v1.2 one IBAN per account (N2)", () => {
  const base = () => [
    ev("b", 5, "account.opened", "Y", { name: "Real Y", iban: `PL${N1}`, keys: [`iban:${N1}`] }),
    ev("a", 6, "account.opened", "A", { name: "A", iban: null, keys: ["ext:mbank:k-a"] }),
  ];

  it.each([
    [20, 21],
    [21, 20],
  ])(
    "two concurrent IBANs for one account never fuse a third account (walls %i / %i)",
    (w3, w1) => {
      const v = converge([
        ...base(),
        ev("a", w3, "account.identified", "A", { iban: N3, keys: [`iban:${N3}`] }),
        ev("p", w1, "account.identified", "A", { iban: N1, keys: [`iban:${N1}`] }),
      ]);
      expect(v.accountConflicts).toHaveLength(1);
    },
  );

  it("an IBAN that fails the mod-97 check is never claimed", () => {
    const masked = `${N1.slice(0, 25)}${N1.endsWith("1") ? "2" : "1"}`;
    converge([
      ...base(),
      ev("a", 20, "account.identified", "A", { iban: masked, keys: [`iban:${masked}`] }),
    ]);
  });
});

describe("production fold = reference fold: v1.2 presence and names (N3, N4)", () => {
  it("N3: removing the duplicate and then merging keeps the target watched", () => {
    converge([
      ev("a", 5, "watchlist.added", "w-t", { instrument: "T", source: "user" }),
      ev("a", 6, "watchlist.added", "w-s", { instrument: "S", source: "user" }),
      ev("a", 7, "watchlist.removed", "w-s", {}),
      ev("a", 10, "instrument.merged", "S", { source: "S", target: "T", reason: "owner" }),
    ]);
  });

  it("N4: an explicit rename beats the root's opened name", () => {
    converge([
      ev("b", 5, "account.opened", "Y", {
        name: "mBank eKonto",
        iban: `PL${N1}`,
        keys: [`iban:${N1}`],
      }),
      ev("a", 6, "account.opened", "A", { name: "Z CSV", iban: null, keys: ["ext:mbank:k-a"] }),
      ev("a", 20, "account.identified", "A", { iban: N1, keys: [`iban:${N1}`] }),
      ev("p", 30, "account.renamed", "A", { name: "Konto domowe" }),
    ]);
  });
});
