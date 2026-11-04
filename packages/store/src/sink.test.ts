// The store as the sync engine's EventSink (S28a): two devices write, sync through a shared remote,
// and end with the same view; cursors persist with the view; reset + resync rebuilds it.
import { createSyncEngine, MemoryTransport, type Transport } from "@cashu/sync";
import { insecureTestCodec, insecureTestGate, ManualClock } from "@cashu/sync/testing";
import { describe, expect, it } from "vitest";
import { metaClockStore, metaGateStateStore } from "./hlc.js";
import type { Store } from "./materialize.js";
import { viewHash } from "./snapshot.js";
import { openTestStore, testUlid } from "./testing/store.js";

const ROUTING = "0123456789abcdef0123456789abcdef";
const A = "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T0 = Date.UTC(2026, 9, 31, 12);
const ACC = "70cc61c8-79b5-80ae-b8cc-fdca7caef49e";
const RULE = "cc9078fc-ae3d-8c1d-8381-55311fb4c8b2";

function device(id: string, remote: Transport, store: Store, clock: ManualClock) {
  return createSyncEngine({
    vault: ROUTING,
    device: id,
    local: new MemoryTransport(),
    remotes: [remote],
    codec: insecureTestCodec(),
    gate: insecureTestGate(),
    sink: store.sink(),
    clockStore: metaClockStore(store.driver, id),
    physicalClock: clock,
  });
}

const at = (ms: number) => new Date(ms).toISOString();

describe("Store as EventSink", () => {
  it("converges two devices through the carrier", async () => {
    const remote = new MemoryTransport();
    const clock = new ManualClock(T0);
    const sa = openTestStore();
    const sb = openTestStore();
    const a = await device(A, remote, sa, clock);
    const b = await device(B, remote, sb, clock);
    await a.write([
      {
        t: "account.opened",
        v: 1,
        i: testUlid("01JE", 1),
        g: ACC,
        a: at(T0),
        d: {
          bank: "mbank",
          externalId: null,
          iban: null,
          currency: "PLN",
          type: "checking",
          name: "Konto",
          keys: [],
        },
      },
    ]);
    clock.advance(10);
    await b.write([
      {
        t: "categoryRule.set",
        v: 1,
        i: testUlid("01JE", 2),
        g: RULE,
        a: at(T0 + 10),
        d: { merchantKey: "SKLEP TESTOWY", category: "groceries", source: "manual", locked: true },
      },
    ]);
    await a.sync();
    await b.sync();
    await a.sync();
    expect(sa.read("SELECT name FROM accounts")).toEqual([{ name: "Konto" }]);
    expect(sb.read("SELECT category FROM category_rules")).toEqual([{ category: "groceries" }]);
    expect(viewHash(sa).hash).toBe(viewHash(sb).hash);
    expect(sa.cursors().get(B)).toBeDefined();
    expect(metaClockStore(sa.driver, A).load()).toBeDefined();

    const before = viewHash(sa).hash;
    await a.rebuild();
    expect(viewHash(sa).hash).toBe(before);
  });

  it("reads the HLCs of held eids and the other devices' events after a cursor (S31a 5.4)", async () => {
    const remote = new MemoryTransport();
    const clock = new ManualClock(T0);
    const sa = openTestStore();
    const sb = openTestStore();
    const a = await device(A, remote, sa, clock);
    const b = await device(B, remote, sb, clock);
    const own = testUlid("01JE", 1);
    const foreign = testUlid("01JE", 2);
    const written = await a.write([
      {
        t: "account.opened",
        v: 1,
        i: own,
        g: ACC,
        a: at(T0),
        d: {
          bank: "mbank",
          externalId: null,
          iban: null,
          currency: "PLN",
          type: "checking",
          name: "Konto",
          keys: [],
        },
      },
    ]);
    clock.advance(10);
    await b.write([
      {
        t: "categoryRule.set",
        v: 1,
        i: foreign,
        g: RULE,
        a: at(T0 + 10),
        d: { merchantKey: "SKLEP TESTOWY", category: "groceries", source: "manual", locked: true },
      },
    ]);
    await b.sync();
    await a.sync();
    const missing = testUlid("01JE", 3);
    const hlcs = sa.eventHlcs([own, foreign, missing]);
    expect(hlcs.get(own)).toBe(written.first);
    expect(hlcs.get(foreign)?.endsWith(B)).toBe(true);
    expect(hlcs.has(missing)).toBe(false);

    const page = sa.foreignEvents(0, new Set([A]), 10);
    expect(page.events.map((e) => [e.eid, e.type, e.vault, e.device])).toEqual([
      [foreign, "categoryRule.set", sa.vault, B],
    ]);
    expect(page.last).toBeDefined();
    const last = page.last ?? { seq: 0, eid: "" };
    expect(sa.foreignEvents(last.seq, new Set([A]), 10)).toEqual({ events: [], last: undefined });
    // Paging: one row per page still moves the cursor past an excluded row.
    const first = sa.foreignEvents(0, new Set([A]), 1);
    const second = sa.foreignEvents(first.last?.seq ?? 0, new Set([A]), 1);
    expect([...first.events, ...second.events].map((e) => e.eid)).toEqual([foreign]);
  });

  it("skips sync statements (device.*, lease.*): not folded, held, parked or rejected (S29c-B3)", async () => {
    const remote = new MemoryTransport();
    const clock = new ManualClock(T0);
    const sa = openTestStore();
    const sb = openTestStore();
    const a = await device(A, remote, sa, clock);
    const b = await device(B, remote, sb, clock);
    const statement = (t: string, n: number) => ({
      t,
      v: 1,
      i: testUlid("01JF", n),
      d: { device: A, signer: A, sig: "00" },
    });
    await a.write([
      statement("device.added", 1),
      statement("lease.renewed", 2),
      {
        t: "categoryRule.set",
        v: 1,
        i: testUlid("01JE", 9),
        g: RULE,
        a: at(T0),
        d: { merchantKey: "SKLEP TESTOWY", category: "groceries", source: "manual", locked: true },
      },
    ]);
    await a.sync();
    const pulled = await b.sync();
    expect(pulled.pulledFrames).toBe(1);
    expect(pulled.needsUpgrade).toBe(false);
    expect(pulled.parked).toBe(0);
    for (const s of [sa, sb]) {
      expect(s.needsUpgrade()).toBe(false);
      expect(s.read("SELECT type FROM event_log")).toEqual([{ type: "categoryRule.set" }]);
      expect(s.read("SELECT COUNT(*) AS n FROM event_rejects")).toEqual([{ n: 0 }]);
      expect(s.read("SELECT category FROM category_rules")).toEqual([{ category: "groceries" }]);
    }
    const direct = openTestStore().applyWire({
      device: A,
      events: [statement("device.revoked", 3)],
      cursor: { seg: 1, offset: 10 },
    });
    expect(direct).toMatchObject({ statements: 1, applied: 0, parked: 0, rejected: [] });
    // snapshot.* (S32) is not defined: an unknown statement-like type is not skipped.
    const unknown = openTestStore().applyWire({
      device: A,
      events: [{ ...statement("snapshot.made", 4), g: ACC, a: at(T0), h: undefined }],
    });
    expect(unknown.statements).toBe(0);
  });

  it("applies wire batches in one transaction: sequential outcomes, all or nothing (S29c-B3)", () => {
    const hlc = (n: number) => `0mvwcmtc${n}-0000-${A}`;
    const rule = (n: number, category: string) => ({
      t: "categoryRule.set",
      v: 1,
      h: hlc(n),
      i: testUlid("01JG", n),
      g: RULE,
      a: at(T0 + n),
      d: { merchantKey: "SKLEP TESTOWY", category, source: "manual", locked: true },
    });
    const batches = [1, 2, 3, 4].map((n) => ({
      device: A,
      events:
        n === 3 ? [rule(2, "fuel"), rule(3, "fuel")] : [rule(n, n % 2 ? "groceries" : "fuel")],
      cursor: { seg: 1, offset: n * 100 },
    }));
    const one = openTestStore();
    const sequential = batches.map((b) => one.applyWire(b));
    const all = openTestStore();
    let notified = 0;
    all.subscribe(["category_rules"], () => {
      notified += 1;
    });
    const together = all.applyWireBatches(batches);
    expect(notified).toBe(1);
    expect(together.map((r) => [r.applied, r.duplicates, r.suppressed])).toEqual(
      sequential.map((r) => [r.applied, r.duplicates, r.suppressed]),
    );
    expect(viewHash(all).hash).toBe(viewHash(one).hash);
    expect(all.cursors().get(A)).toEqual({ seg: 1, offset: 400 });

    // A failure inside the call (here: a cursor the table refuses) rolls every batch back.
    const failing = openTestStore();
    const broken = { ...batches[1], cursor: { seg: null, offset: 0 } } as never;
    expect(() => failing.applyWireBatches([batches[0] as never, broken])).toThrow();
    expect(failing.read("SELECT COUNT(*) AS n FROM event_log")).toEqual([{ n: 0 }]);
    expect(failing.cursors().size).toBe(0);
  });

  it("keeps a device's gate snapshot in store_meta, across a view reset (S29c-B3)", () => {
    const s = openTestStore();
    const gate = metaGateStateStore(s.driver, A);
    expect(gate.load()).toBeUndefined();
    gate.save('{"v":1}\nab');
    s.reset();
    expect(metaGateStateStore(s.driver, A).load()).toBe('{"v":1}\nab');
    expect(metaGateStateStore(s.driver, B).load()).toBeUndefined();
    gate.appendEvidence(["p1", "p2"]);
    gate.appendEvidence(["p1"]);
    gate.save("{}\ncd");
    s.reset();
    expect(metaGateStateStore(s.driver, A).loadEvidence()).toEqual(["p1", "p2"]);
    expect(metaGateStateStore(s.driver, B).loadEvidence()).toEqual([]);
  });
});
