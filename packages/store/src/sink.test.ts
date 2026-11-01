// The store as the sync engine's EventSink (S28a): two devices write, sync through a shared remote,
// and end with the same view; cursors persist with the view; reset + resync rebuilds it.
import { createSyncEngine, MemoryTransport, type Transport } from "@cashu/sync";
import { insecureTestCodec, insecureTestGate, ManualClock } from "@cashu/sync/testing";
import { describe, expect, it } from "vitest";
import { metaClockStore } from "./hlc.js";
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
    expect(sa.eidAt(last.seq)).toBe(last.eid);
    expect(sa.foreignEvents(last.seq, new Set([A]), 10)).toEqual({ events: [], last: undefined });
    // Paging: one row per page still moves the cursor past an excluded row.
    const first = sa.foreignEvents(0, new Set([A]), 1);
    const second = sa.foreignEvents(first.last?.seq ?? 0, new Set([A]), 1);
    expect([...first.events, ...second.events].map((e) => e.eid)).toEqual([foreign]);
  });
});
