// The store as the sync engine's EventSink (S28a): two devices write, sync through a shared remote,
// and end with the same view; cursors persist with the view; reset + resync rebuilds it.
import { createSyncEngine, MemoryTransport, type Transport } from "@cashu/sync";
import { insecureTestCodec, ManualClock } from "@cashu/sync/testing";
import { describe, expect, it } from "vitest";
import { metaClockStore } from "./hlc.js";
import type { Store } from "./materialize.js";
import { viewHash } from "./snapshot.js";
import { openTestStore, testUlid } from "./testing/store.js";

const ROUTING = "0123456789abcdef0123456789abcdef";
const A = "deviceaaaaaaaaaa";
const B = "devicebbbbbbbbbb";
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
});
