// A complete transfer run crosses the sync engine's default 1000-event frame boundary.
import { createSyncEngine, MemoryTransport } from "@cashu/sync";
import { insecureTestCodec, insecureTestGate, ManualClock } from "@cashu/sync/testing";
import { expect, it } from "vitest";
import { detGid } from "../gid.js";
import { metaClockStore } from "../hlc.js";
import type { Store } from "../materialize.js";
import { viewHash } from "../snapshot.js";
import {
  EventFactory,
  openTestStore,
  TEST_SALT,
  TEST_VAULT,
  type TestEnvelope,
  testUlid,
} from "../testing/store.js";

const A = "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T0 = Date.UTC(2026, 9, 31, 12);
const A1 = testUlid("01JD", 1);
const A2 = testUlid("01JD", 2);
const OLD = testUlid("01JD", 3);
const NEXT = testUlid("01JD", 4);
const NEW_PAIRS = 1001;

function nrb(bban: string): string {
  const check = 98n - (BigInt(`${bban}252100`) % 97n);
  return `${check.toString().padStart(2, "0")}${bban}`;
}
const N1 = nrb("114000000000000000000001");
const N2 = nrb("114000000000000000000002");

function source() {
  const f = new EventFactory();
  const account = (gid: string, iban: string) =>
    f.make("account.opened", gid, {
      bank: "mbank",
      externalId: null,
      iban,
      currency: "PLN",
      type: "checking",
      name: "Synthetic",
      keys: [`iban:${iban}`],
    });
  const seed: TestEnvelope[] = [account(A1, N1), account(A2, N2)];
  const rowPairs: { out: string; inc: string }[] = [];
  for (let i = 0; i <= NEW_PAIRS; i++) {
    const amount = `${i + 1}.00`;
    const makeRow = (accountGid: string, sign: string, side: string, iban: string | null) => {
      const hash = (i * 2 + (side === "in" ? 1 : 0) + 1).toString(16).padStart(40, "0");
      const gid = detGid(TEST_SALT, "transactions", [accountGid, hash, "0"]);
      seed.push(
        f.make("txn.imported", gid, {
          account: accountGid,
          batch: null,
          bookingDate: "2026-10-01",
          valueDate: null,
          amount: `${sign}${amount}`,
          currency: "PLN",
          counterpartyName: "Synthetic transfer",
          counterpartyIban: iban,
          description: null,
          reference: `pair-${i}-${side}`,
          bankTransactionId: null,
          source: "csv",
          dedupHash: hash,
          occurrence: 0,
          raw: {},
        }),
      );
      return gid;
    };
    rowPairs.push({
      out: makeRow(A1, "-", "out", N2),
      inc: makeRow(A2, "", "in", null),
    });
  }
  seed.push(
    f.make(
      "transferRun.started",
      OLD,
      {
        reset: true,
        maxDays: 3,
        pairCount: 1,
      },
      { wall: 5000 },
    ),
  );
  seed.push(
    f.make(
      "transferPair.claimed",
      OLD,
      {
        run: OLD,
        out: rowPairs[0]?.out,
        in: rowPairs[0]?.inc,
        ordinal: 0,
      },
      { wall: 5001 },
    ),
  );
  const run = [
    f.make(
      "transferRun.started",
      NEXT,
      {
        reset: true,
        maxDays: 3,
        pairCount: NEW_PAIRS,
      },
      { wall: 10000 },
    ),
  ];
  for (let i = 1; i <= NEW_PAIRS; i++) {
    run.push(
      f.make(
        "transferPair.claimed",
        NEXT,
        {
          run: NEXT,
          out: rowPairs[i]?.out,
          in: rowPairs[i]?.inc,
          ordinal: i - 1,
        },
        { wall: 10000 + i },
      ),
    );
  }
  return { seed, run, rowPairs };
}

function groups(store: Store) {
  return new Map(
    store
      .read<{ gid: string; is_internal_transfer: number; transfer_group_id: string | null }>(
        "SELECT gid, is_internal_transfer, transfer_group_id FROM transactions",
      )
      .map((r) => [r.gid, [r.is_internal_transfer, r.transfer_group_id] as const]),
  );
}

function expectedGroups(
  rowPairs: readonly { out: string; inc: string }[],
  first: number,
  last: number,
) {
  const expected = new Map<string, readonly [number, string | null]>();
  for (const [i, pair] of rowPairs.entries()) {
    const active = i >= first && i <= last;
    expected.set(pair.out, active ? [1, pair.out] : [0, null]);
    expected.set(pair.inc, active ? [1, pair.out] : [0, null]);
  }
  return expected;
}

it("keeps the previous complete transfer run through a 1000-event prefix and activates all 1001 claims after the tail", async () => {
  const { seed, run, rowPairs } = source();
  const partial = openTestStore();
  partial.applyEnvelopes(seed);
  expect(groups(partial)).toEqual(expectedGroups(rowPairs, 0, 0));
  partial.applyEnvelopes(run.slice(0, 1000));
  expect(groups(partial)).toEqual(expectedGroups(rowPairs, 0, 0));
  partial.applyEnvelopes(run.slice(1000));
  expect(groups(partial)).toEqual(expectedGroups(rowPairs, 1, NEW_PAIRS));
  const finalHash = viewHash(partial).hash;
  partial.rebuild();
  expect(groups(partial)).toEqual(expectedGroups(rowPairs, 1, NEW_PAIRS));
  expect(viewHash(partial).hash).toBe(finalHash);

  const remote = new MemoryTransport();
  const writerStore = openTestStore();
  const readerStore = openTestStore();
  writerStore.applyEnvelopes(seed);
  readerStore.applyEnvelopes(seed);
  const engine = (device: string, store: Store) =>
    createSyncEngine({
      vault: TEST_VAULT,
      device,
      local: new MemoryTransport(),
      remotes: [remote],
      codec: insecureTestCodec(),
      gate: insecureTestGate(),
      sink: store.sink(),
      clockStore: metaClockStore(store.driver, device),
      physicalClock: new ManualClock(T0 + 20_000),
    });
  const writer = await engine(A, writerStore);
  const reader = await engine(B, readerStore);
  try {
    const written = await writer.write(
      run.map((e) => ({
        t: e.type,
        v: e.v,
        i: e.eid,
        g: e.gid,
        a: e.at,
        d: e.data,
      })),
    );
    expect(written.frames).toBeGreaterThan(1);
    await writer.sync();
    await reader.sync();
    expect(groups(readerStore)).toEqual(expectedGroups(rowPairs, 1, NEW_PAIRS));
    const hash = viewHash(readerStore).hash;
    readerStore.rebuild();
    expect(groups(readerStore)).toEqual(expectedGroups(rowPairs, 1, NEW_PAIRS));
    expect(viewHash(readerStore).hash).toBe(hash);
  } finally {
    await writer.close();
    await reader.close();
    partial.close();
    writerStore.close();
    readerStore.close();
  }
});
