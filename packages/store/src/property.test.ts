// Property tests on random synthetic event sets over a small universe (so ids collide, rows merge,
// guards and FWW fire): for every generated set
//   1. any two delivery orders (with duplicates, random batching) give the same view hash;
//   2. rebuilding from the log gives the incremental hash;
//   3. the store's view equals the reference fold's view.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatHlc } from "./events/v1/hlc-format.js";
import { materialize, type RefEvent } from "./events/v1/reference/fold.js";
import { complete, syntheticDet } from "./events/v1/reference/testing/scenarios.js";
import { viewHash } from "./snapshot.js";
import { chunked, shuffled } from "./testing/random.js";
import { Names, normalize, project, toEnvelopes } from "./testing/reference-bridge.js";
import { openTestStore } from "./testing/store.js";

const DEVICES = [
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "ffffffffffffffffffffffffffffffff",
] as const;

function nrb(bban24: string): string {
  const check = 98n - (BigInt(`${bban24}252100`) % 97n);
  return `${check.toString().padStart(2, "0")}${bban24}`;
}
const IBANS = [nrb("114000000000000000000001"), nrb("114000000000000000000002")];

const pick = <T>(xs: readonly T[]) => fc.constantFrom(...xs);
const ACCOUNTS = ["A1", "A2", "A3"];
/** Transaction row keys (account, hash, occurrence); the gid name is derived from it (DET). */
const TXNS = ["A1-h1-0", "A1-h1-1", "A2-h1-0", "A3-h2-0", "A2-h2-0"].map((k) => `T-${k}`);
const WATCH_OF = (i: string) => `W-${i}`;
const INSTRUMENTS = ["I1", "I2", "I3"];
const SIGNALS = ["S1", "S2", "S3", "S4"];
const DECISIONS = ["D1", "D2"];

/** One step of a script: [type, gid, data] (cause filled in later for caused imports). */
type Step = {
  type: string;
  gid: string;
  data: Record<string, unknown>;
  causedByApproval?: boolean;
};

const accountKey = fc.oneof(
  pick(["ext:mbank:k1", "ext:mbank:k2", "ext:mbank:k3"]).map((k) => ({ key: k, iban: null })),
  pick(IBANS).map((n) => ({ key: `iban:${n}`, iban: n })),
);

const step: fc.Arbitrary<Step> = fc.oneof(
  fc
    .record({ gid: pick(ACCOUNTS), k: accountKey, name: pick(["X", "Y"]) })
    .map(({ gid, k, name }) => ({
      type: "account.opened",
      gid,
      data: { name, iban: k.iban, keys: [k.key] },
    })),
  fc.record({ gid: pick(ACCOUNTS), k: accountKey }).map(({ gid, k }) => ({
    type: "account.identified",
    gid,
    data: k.iban === null ? { keys: [k.key] } : { iban: k.iban, keys: [k.key] },
  })),
  fc.record({ gid: pick(ACCOUNTS), name: pick(["R1", "R2"]) }).map(({ gid, name }) => ({
    type: "account.renamed",
    gid,
    data: { name },
  })),
  pick(TXNS).map((gid) => {
    const [, account, h, o] = gid.split("-");
    return {
      type: "txn.imported",
      gid,
      data: { account, dedupHash: h, occurrence: Number(o) },
    };
  }),
  // An invalid-gid import (events.md 7.10): the gid name of another row key.
  fc
    .tuple(pick(TXNS), pick(TXNS))
    .filter(([g, k]) => g !== k)
    .map(([gid, key]) => {
      const [, account, h, o] = key.split("-");
      return {
        type: "txn.imported",
        gid,
        data: { account, dedupHash: h, occurrence: Number(o) },
      };
    }),
  fc
    .record({
      t: pick(TXNS),
      leg: fc.boolean(),
      category: pick(["groceries", "cash_withdrawal", "fuel"]),
      source: pick(["manual_txn", "llm_full"]),
    })
    .map(({ t, leg, category, source }) => ({
      type: "txn.categorySet",
      gid: leg ? `cashleg:${t}` : t,
      data: { category, source },
    })),
  pick(TXNS).map((t) => ({ type: "txn.categoryCleared", gid: t, data: {} })),
  fc.record({ i: pick(INSTRUMENTS), v: pick(["X1", "X2", "Y1"]) }).map(({ i, v }) => ({
    type: "instrument.aliasAdded",
    gid: `al-${v}`,
    data: { instrument: i, namespace: "yahoo", value: v },
  })),
  fc
    .tuple(pick(INSTRUMENTS), pick(INSTRUMENTS))
    .filter(([s, t]) => s !== t)
    .map(([s, t]) => ({
      type: "instrument.merged",
      gid: s,
      data: { source: s, target: t, reason: "owner" },
    })),
  fc
    .record({
      i: pick(INSTRUMENTS),
      source: pick(["user", "agent"]),
      note: fc.option(pick(["n1", "n2"])),
    })
    .map(({ i, source, note }) => ({
      type: "watchlist.added",
      gid: WATCH_OF(i),
      data: { instrument: i, source, ...(note === null ? {} : { note }) },
    })),
  pick(INSTRUMENTS).map((i) => ({ type: "watchlist.removed", gid: WATCH_OF(i), data: {} })),
  fc
    .record({ i: pick(INSTRUMENTS), tags: pick([["a"], ["b", "c"]]) })
    .map(({ i, tags }) => ({ type: "watchlist.updated", gid: WATCH_OF(i), data: { tags } })),
  fc
    .record({
      i: pick(INSTRUMENTS),
      segment: fc.option(pick(["gold", "energy"])),
      by: pick(["owner", "agent"]),
    })
    .map(({ i, segment, by }) => ({
      type: "instrumentOverride.segmentSet",
      gid: `o-${i}`,
      data: { instrument: i, segment, by },
    })),
  fc
    .record({
      i: pick(INSTRUMENTS),
      asOf: pick(["2026-10-01", "2026-10-02"]),
      v: pick(["1", "2", "3"]),
    })
    .map(({ i, asOf, v }) => ({
      type: "valuation.set",
      gid: `v-${i}-${asOf}`,
      data: { instrument: i, asOf, unitValue: v },
    })),
  fc
    .record({
      s: pick(SIGNALS),
      rule: pick(["dd", "r2"]),
      i: pick(INSTRUMENTS),
      message: pick(["m1", "m2"]),
    })
    .map(({ s, rule, i, message }) => ({
      type: "signal.opened",
      gid: s,
      data: { dedupKey: `${rule}|i:${i}`, message },
    })),
  fc
    .record({ s: pick(SIGNALS), status: pick(["resolved", "expired"]) })
    .map(({ s, status }) => ({ type: "signal.closed", gid: s, data: { status, reason: "x" } })),
  fc
    .record({ s: pick(SIGNALS), reason: pick(["alert_restored", "note_restored"]) })
    .map(({ s, reason }) => ({ type: "signal.reopened", gid: s, data: { reason } })),
  fc
    .record({
      s: pick(SIGNALS),
      until: pick(["2026-11-01T00:00:00.000Z", "2026-11-30T00:00:00.000Z"]),
    })
    .map(({ s, until }) => ({ type: "signal.snoozed", gid: s, data: { until } })),
  fc
    .record({
      s: pick(SIGNALS),
      until: pick(["2026-11-01T00:00:00.000Z", "2026-11-30T00:00:00.000Z"]),
    })
    .map(({ s, until }) => ({ type: "signal.woken", gid: s, data: { until } })),
  fc
    .record({
      d: pick(DECISIONS),
      signals: fc.uniqueArray(pick(SIGNALS), { minLength: 1, maxLength: 2 }),
    })
    .map(({ d, signals }) => ({ type: "decision.recorded", gid: d, data: { signals } })),
  pick(DECISIONS).map((d) => ({ type: "decision.undone", gid: d, data: {} })),
  fc.constant({ type: "proposal.created", gid: "P1", data: { kind: "budget_import" } }),
  fc.constant({ type: "proposal.approved", gid: "P1", data: { result: {} } }),
  fc.constant({ type: "proposal.rejected", gid: "P1", data: { note: null } }),
  fc.record({ account: pick(ACCOUNTS) }).map(({ account }) => ({
    type: "txn.imported",
    gid: `T-${account}-h3-0`,
    data: { account, dedupHash: "h3", occurrence: 0 },
    causedByApproval: true,
  })),
  fc
    .record({ account: pick(ACCOUNTS), params: pick([{}, { x: 1 }]) })
    .map(({ account, params }) => ({
      type: "connectorBinding.set",
      gid: `B-${account}`,
      data: { account, connectorId: "c", params },
    })),
  pick(ACCOUNTS).map((a) => ({ type: "connectorBinding.removed", gid: `B-${a}`, data: {} })),
  fc
    .record({ a: pick(ACCOUNTS), cursor: pick(["c1", "c2"]), caused: fc.boolean() })
    .map(({ a, cursor, caused }) => ({
      type: "connectorBinding.cursorAdvanced",
      gid: `B-${a}`,
      data: { cursor },
      causedByApproval: caused,
    })),
);

/** A script with walls that mostly increase (causal) and sometimes repeat (concurrent devices). */
const script = fc
  .array(fc.record({ step, device: fc.nat(2), concurrent: fc.boolean() }), {
    minLength: 1,
    maxLength: 28,
  })
  .map((items) => {
    let wall = 0;
    let seq = 0;
    let lastApproval: string | undefined;
    const out: RefEvent[] = [];
    for (const { step: s, device, concurrent } of items) {
      if (!concurrent) wall += 1;
      seq += 1;
      const eid = `01JC${String(seq).padStart(22, "0")}`;
      if (s.causedByApproval && lastApproval === undefined) continue;
      out.push(
        complete({
          eid,
          hlc: formatHlc({
            wall: 1_793_448_000_000 + wall,
            counter: seq,
            device: DEVICES[device] ?? DEVICES[0],
          }),
          at: new Date(1_793_448_000_000 + wall).toISOString(),
          type: s.type,
          gid: s.gid,
          data: s.data,
          ...(s.causedByApproval ? { cause: lastApproval } : {}),
        }),
      );
      if (s.type === "proposal.approved") lastApproval = eid;
    }
    return out;
  });

function deliver(events: RefEvent[], seed: number) {
  const names = new Names();
  const envs = toEnvelopes(events, names, syntheticDet(events));
  const order = shuffled(envs, seed);
  const withDupes = [...order, ...shuffled(order, seed + 99).slice(0, 2)];
  const store = openTestStore();
  for (const b of chunked(withDupes, seed + 7, seed % 3 === 0 ? 1 : 5)) store.applyEnvelopes(b);
  return { store, names };
}

describe("property: convergence on random synthetic event sets", () => {
  it("permutations and duplicates give identical view hashes; rebuild == incremental", () => {
    fc.assert(
      fc.property(script, fc.integer({ min: 1, max: 1_000_000 }), (events, seed) => {
        const a = deliver(events, seed).store;
        const b = deliver(events, seed + 1).store;
        const h = viewHash(a).hash;
        expect(viewHash(b).hash).toBe(h);
        a.rebuild();
        expect(viewHash(a).hash).toBe(h);
      }),
      { numRuns: 150 },
    );
  });

  it("the store's view equals the reference fold's view", () => {
    fc.assert(
      fc.property(script, fc.integer({ min: 1, max: 1_000_000 }), (events, seed) => {
        const { store, names } = deliver(events, seed);
        expect(project(store, names)).toEqual(normalize(materialize(events, syntheticDet(events))));
      }),
      { numRuns: 150 },
    );
  });
});
