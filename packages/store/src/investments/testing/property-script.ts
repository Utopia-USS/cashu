// Random synthetic investments event sets over a small colliding universe (S25 spec 7.2): three
// instruments whose aliases collide and merge, two accounts that merge through a shared key, two
// alerts, two notes, two plans, one topic, one thesis, strategy versions over two shas, signals on
// two keys. Test code only; synthetic data only.
import fc from "fast-check";
import { expect } from "vitest";
import type { Store } from "../../materialize.js";
import { viewHash } from "../../snapshot.js";
import { chunked, shuffled } from "../../testing/random.js";
import { openTestStore, type TestEnvelope } from "../../testing/store.js";
import { DEV_A, DEV_B, det, Events, ulid } from "./kit.js";

const DEVICES = [DEV_A, DEV_B, "ffffffffffffffffffffffffffffffff"] as const;
const pick = <T>(xs: readonly T[]) => fc.constantFrom(...xs);

const ALIASES: readonly (readonly [string, string])[] = [
  ["isin", "PLRAND000001"],
  ["yahoo", "RND2.WA"],
  ["stooq", "rnd3"],
];
const I1 = det("inv_instruments", "isin:PLRAND000001");
const I2 = det("inv_instruments", "yahoo:RND2.WA");
const I3 = ulid(900);
const INSTRUMENTS = [I1, I2, I3];
const CREATION: Record<string, string | null> = {
  [I1]: "isin:PLRAND000001",
  [I2]: "yahoo:RND2.WA",
  [I3]: null,
};
const ACCOUNTS = [ulid(901), ulid(902)];
const HASHES = ["1".repeat(64), "2".repeat(64)];
const ALERTS = [ulid(903), ulid(904)];
const NOTES = [ulid(905), ulid(906)];
const PLANS = [ulid(907), ulid(908)];
const TXN_NAMES = [ulid(909), ulid(910)];
const THESIS = ulid(911);
const RUN = ulid(912);
const REVIEW = ulid(913);
const VERSIONS = [ulid(914), ulid(915), ulid(916)];
const SIGNALS = [ulid(917), ulid(918), ulid(919)];
const KEYS = ["dd|r1", "dd|r2"];
const SEG = "gold";
const TOPIC = det("inv_topic_theses", SEG);
const TIMES = ["2026-11-01T00:00:00.000Z", "2026-11-05T00:00:00.000Z"];

type Step = { type: string; gid: string; data: Record<string, unknown> };
const s = (type: string, gid: string, data: Record<string, unknown> = {}): Step => ({
  type,
  gid,
  data,
});

const instrumentSteps: fc.Arbitrary<Step>[] = [
  fc
    .record({ i: pick(INSTRUMENTS), symbol: pick([null, "SYM"]), cur: pick(["PLN", "EUR"]) })
    .map(({ i, symbol, cur }) =>
      s("instrument.created", i, { creationAlias: CREATION[i], symbol, currency: cur }),
    ),
  fc.record({ i: pick(INSTRUMENTS), a: pick(ALIASES) }).map(({ i, a }) =>
    s("instrument.aliasAdded", det("inv_instrument_aliases", a[0], a[1]), {
      instrument: i,
      namespace: a[0],
      value: a[1],
    }),
  ),
  fc
    .record({ i: pick(INSTRUMENTS), name: pick(["N1", "N2"]) })
    .map(({ i, name }) => s("instrument.updated", i, { name })),
  fc
    .tuple(pick(INSTRUMENTS), pick(INSTRUMENTS))
    .filter(([a, b]) => a !== b)
    .map(([a, b]) => s("instrument.merged", a, { source: a, target: b, reason: "owner" })),
];

const accountSteps: fc.Arbitrary<Step>[] = [
  fc
    .record({ a: pick(ACCOUNTS), k: pick(["ext:xtb:1", "ext:xtb:2"]) })
    .map(({ a, k }) => s("account.opened", a, { keys: [k] })),
  fc
    .record({ a: pick(ACCOUNTS), h: pick(HASHES), i: pick([...INSTRUMENTS, null]) })
    .map(({ a, h, i }) =>
      s("invTxn.imported", det("inv_transactions", a, h), {
        account: a,
        dedupHash: h,
        instrument: i,
      }),
    ),
  fc.record({ a: pick(ACCOUNTS), i: pick(INSTRUMENTS), q: pick(["1", "2"]) }).map(({ a, i, q }) =>
    s("position.snapshotImported", det("inv_position_snapshots", a, i, "2026-03-31"), {
      account: a,
      instrument: i,
      asOf: "2026-03-31",
      quantity: q,
    }),
  ),
  fc
    .tuple(pick(INSTRUMENTS), pick(INSTRUMENTS))
    .filter(([a, b]) => a !== b)
    .map(([o, n]) =>
      s("instrumentRename.recorded", det("inv_instrument_renames", "2026-02-01", o, n), {
        date: "2026-02-01",
        old: o,
        new: n,
      }),
    ),
  fc
    .record({ a: pick(ACCOUNTS), w: pick(["regular", "ike"]) })
    .map(({ a, w }) =>
      s("invAccount.settingsSet", det("inv_account_settings", a), { account: a, wrapper: w }),
    ),
];

const alertSteps: fc.Arbitrary<Step>[] = [
  pick(ALERTS).map((g) => s("alert.created", g, { instrument: I1 })),
  fc
    .record({ g: pick(ALERTS), t: pick(["A", "B"]) })
    .map(({ g, t }) => s("alert.updated", g, { title: t })),
  fc
    .record({ g: pick(ALERTS), st: pick(["active", "muted", "snoozed"]), until: pick(TIMES) })
    .map(({ g, st, until }) =>
      s("alert.statusSet", g, { status: st, snoozedUntil: st === "snoozed" ? until : null }),
    ),
  pick(ALERTS).map((g) => s("alert.deleted", g)),
  fc
    .record({ g: pick(ALERTS), rearm: fc.boolean() })
    .map(({ g, rearm }) => s("alert.restored", g, rearm ? { rearm: true } : {})),
  fc
    .record({ g: pick(ALERTS), t: fc.boolean(), at: pick(TIMES) })
    .map(({ g, t, at }) => s("alert.evaluated", g, { triggered: t, lastCheckedAt: at })),
];

const journalSteps: fc.Arbitrary<Step>[] = [
  pick(INSTRUMENTS).map((i) => s("thesis.created", THESIS, { instrument: i })),
  pick([{ thesis: "T2" }, { exitPlan: "E" }, { exitPlan: null }, { reviewed: true }]).map((d) =>
    s("thesis.updated", THESIS, d),
  ),
  fc.constant(s("thesis.deleted", THESIS)),
  pick(PLANS).map((p) => s("plannedDeposit.created", p, { account: ACCOUNTS[0] })),
  pick(PLANS).map((p) => s("plannedDeposit.cancelled", p)),
  fc
    .record({ p: pick(PLANS), t: pick(TXN_NAMES) })
    .map(({ p, t }) => s("plannedDeposit.booked", p, { txn: t })),
  fc
    .record({ v: pick(VERSIONS), sha: pick(["a".repeat(64), "b".repeat(64)]) })
    .map(({ v, sha }) => s("strategy.versionSaved", v, { sha256: sha })),
  pick([{}, { notes: "x" }]).map((d) => s("review.done", REVIEW, d)),
  fc.constant(s("review.undone", REVIEW)),
];

const researchSteps: fc.Arbitrary<Step>[] = [
  pick(["ownerSaved", "draftProposed"]).chain((kind) =>
    pick(["T1", "T2"]).map((thesis) =>
      s(`topicThesis.${kind}`, TOPIC, {
        segment: SEG,
        thesis,
        ...(kind === "ownerSaved" ? { invalidation: null } : {}),
      }),
    ),
  ),
  fc.constant(s("topicThesis.rejected", TOPIC)),
  pick([null, "A"]).map((assessment) =>
    s("topicThesis.marketViewSet", TOPIC, { segment: SEG, assessment, outlook: null, by: "agent" }),
  ),
  fc.constant(s("researchRun.started", RUN)),
  fc.constant(s("researchRun.finished", RUN, { status: "done", counts: { n: 1 } })),
  pick(NOTES).map((n) => s("note.added", n, { run: RUN, instrument: I2 })),
  pick(NOTES).map((n) => s("note.read", n)),
  pick(NOTES).map((n) => s("note.dismissed", n, { cooldownUntil: null })),
  pick(NOTES).map((n) => s("note.restored", n)),
  fc
    .record({ n: pick(NOTES), i: pick([...INSTRUMENTS, null]) })
    .map(({ n, i }) => s("note.candidateUpdated", n, { instrument: i, details: { i } })),
  fc
    .record({ n: pick(NOTES), sig: pick(SIGNALS) })
    .map(({ n, sig }) => s("note.signalLinked", n, { signal: sig })),
];

const signalSteps: fc.Arbitrary<Step>[] = [
  fc
    .record({ g: pick(SIGNALS), k: pick(KEYS), kind: pick(["k1", "k2"]) })
    .map(({ g, k, kind }) => s("signal.opened", g, { dedupKey: k, kind, run: RUN })),
  fc
    .record({ g: pick(SIGNALS), run: pick([RUN, null]), i: pick([I1, I3]) })
    .map(({ g, run, i }) =>
      s("signal.refreshed", g, { run, seenAt: TIMES[0], instrument: i, polarity: "negative" }),
    ),
  fc
    .record({ g: pick(SIGNALS), st: pick(["resolved", "expired"]) })
    .map(({ g, st }) =>
      s("signal.closed", g, { status: st, reason: "x", payloadSet: { closed_by: "x" } }),
    ),
  fc
    .record({ g: pick(SIGNALS), r: pick(["alert_restored", "note_restored"]) })
    .map(({ g, r }) => s("signal.reopened", g, { reason: r, payloadUnset: ["closed_by"] })),
];

const step = fc.oneof(
  ...instrumentSteps,
  ...accountSteps,
  ...alertSteps,
  ...journalSteps,
  ...researchSteps,
  ...signalSteps,
);

/** A script with walls that mostly increase (causal) and sometimes repeat (concurrent devices). */
const script: fc.Arbitrary<TestEnvelope[]> = fc
  .array(fc.record({ step, device: fc.nat(2), concurrent: fc.boolean() }), {
    minLength: 1,
    maxLength: 30,
  })
  .map((items) => {
    const ev = new Events();
    let wall = 0;
    return items.map(({ step: st, device, concurrent }, i) => {
      if (!concurrent) wall += 1;
      return ev.make(st.type, st.gid, st.data, {
        wall,
        counter: i,
        device: DEVICES[device] ?? DEV_A,
      });
    });
  });

function deliver(events: readonly TestEnvelope[], seed: number): Store {
  const order = shuffled(events, seed);
  const withDupes = [...order, ...shuffled(order, seed + 99).slice(0, 2)];
  const store = openTestStore();
  for (const b of chunked(withDupes, seed + 7, seed % 3 === 0 ? 1 : 5)) {
    const r = store.applyEnvelopes(b);
    expect(r.rejected).toEqual([]);
    expect(r.parked).toBe(0);
  }
  return store;
}

/** Two delivery orders (duplicates, random batching) give one view hash; a rebuild gives it too. */
export const convergesProperty = fc.property(
  script,
  fc.integer({ min: 1, max: 1_000_000 }),
  (events, seed) => {
    const a = deliver(events, seed);
    const b = deliver(events, seed + 1);
    const h = viewHash(a).hash;
    expect(viewHash(b).hash).toBe(h);
    a.rebuild();
    expect(viewHash(a).hash).toBe(h);
  },
);
