// Random synthetic event scripts over a small universe (so ids collide, rows merge, guards and FWW
// fire) for the store's property tests (property.test.ts: the fast tier; property.exhaustive.test.ts:
// the long search), and the two properties they check. Synthetic data only.
import fc from "fast-check";
import { expect } from "vitest";
import { formatHlc } from "../events/v1/hlc-format.js";
import { materialize, type RefEvent } from "../events/v1/reference/fold.js";
import { complete, syntheticDet } from "../events/v1/reference/testing/scenarios.js";
import { viewHash } from "../snapshot.js";
import { expectCategoriesRecomputed } from "./categories-oracle.js";
import { chunked, shuffled } from "./random.js";
import { Names, normalize, project, toEnvelopes } from "./reference-bridge.js";
import { openTestStore } from "./store.js";

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

const POOL = {
  bank: "manual",
  name: "Gotówka",
  externalId: "cash:PLN",
  type: "cash",
  keys: ["ext:manual:cash:PLN"],
};
const NAMED = ["M1", "M2", "M3"]; // manual accounts sharing one name key (parking, D-24.7)
const EXPENSES = ["X1", "X2"];
const MODULES = ["budget", "loans"];

/** S24 core / budget steps: pool, name-key accounts, removal, balances, modules, cash expenses. */
const s24Step: fc.Arbitrary<Step> = fc.oneof(
  fc.constant({ type: "account.opened", gid: "pool:PLN", data: POOL }),
  pick(NAMED).map((gid) => ({
    type: "account.opened",
    gid,
    data: { bank: "manual", name: "Dom", externalId: "manual:Dom", type: "property", keys: [] },
  })),
  fc
    .record({ gid: pick([...NAMED, ...ACCOUNTS]), removed: fc.boolean() })
    .map(({ gid, removed }) => ({
      type: removed ? "account.removed" : "account.restored",
      gid,
      data: {},
    })),
  fc.record({ gid: pick(ACCOUNTS) }).map(({ gid }) => ({
    type: "account.typeSet",
    gid,
    data: { type: "cash" },
  })),
  fc
    .record({
      account: pick(ACCOUNTS),
      date: pick(["2026-10-01", "2026-10-02"]),
      amount: pick(["1.00", "2.50"]),
    })
    .map(({ account, date, amount }) => ({
      type: "balance.recorded",
      gid: `BAL-${account}-${date}`,
      data: { account, date, amount, source: "csv", currency: "PLN" },
    })),
  fc.record({ m: pick(MODULES), on: fc.boolean() }).map(({ m, on }) => ({
    type: on ? "module.enabled" : "module.disabled",
    gid: `mod-${m}`,
    data: { moduleId: m },
  })),
  pick(EXPENSES).map((gid) => ({
    type: "txn.cashExpenseAdded",
    gid,
    data: {
      account: "pool:PLN",
      bookingDate: "2026-10-20",
      amount: "-3.00",
      currency: "PLN",
      title: "Kawa",
      category: "food",
    },
  })),
  pick(EXPENSES).map((gid) => ({ type: "txn.deleted", gid, data: {} })),
  fc.record({ a: pick(ACCOUNTS), p: pick(["100.00", "200.00"]) }).map(({ a, p }) => ({
    type: "loan.termsSet",
    gid: `LOAN-${a}`,
    data: {
      account: a,
      principal: p,
      annualRate: "6.5",
      termMonths: 120,
      startDate: "2026-01-10",
      originationDate: null,
    },
  })),
  fc.record({ a: pick(ACCOUNTS), t: fc.option(pick(["RATA"])) }).map(({ a, t }) => ({
    type: "loan.paymentMatchingSet",
    gid: `LOAN-${a}`,
    data: { account: a, paymentIban: null, paymentText: t },
  })),
  fc.record({ a: pick(NAMED), note: fc.option(pick(["n1", "n2"])) }).map(({ a, note }) => ({
    type: "assetDetails.noteSet",
    gid: `NOTE-${a}`,
    data: { account: a, note },
  })),
  fc
    .record({ x: pick(EXPENSES), source: pick(["manual_txn", "llm_full"]) })
    .map(({ x, source }) => ({
      type: "txn.categorySet",
      gid: x,
      data: { category: "fuel", source },
    })),
);

const step: fc.Arbitrary<Step> = fc.oneof(
  s24Step,
  s24Step,
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

/**
 * 1. two delivery orders (duplicates, random batching) give the same view hash; 2. re-deriving
 * everything changes nothing (derived oracle, S24 6); 3. a rebuild gives the incremental hash.
 */
export const convergesProperty = fc.property(
  script,
  fc.integer({ min: 1, max: 1_000_000 }),
  (events, seed) => {
    const a = deliver(events, seed).store;
    const b = deliver(events, seed + 1).store;
    const h = viewHash(a).hash;
    expect(viewHash(b).hash).toBe(h);
    expect(a.rederive().touchedTables).toEqual(new Set());
    expectCategoriesRecomputed(a);
    a.rebuild();
    expect(viewHash(a).hash).toBe(h);
  },
);

/** The store's view equals the reference fold's view. */
export const referenceProperty = fc.property(
  script,
  fc.integer({ min: 1, max: 1_000_000 }),
  (events, seed) => {
    const { store, names } = deliver(events, seed);
    expect(project(store, names)).toEqual(normalize(materialize(events, syntheticDet(events))));
  },
);
