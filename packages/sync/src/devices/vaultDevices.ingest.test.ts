// `VaultDevices.ingest` builds an event's copy key (its canonical content, the dedupe key) only for the
// events the devices state keeps: registry, lease and `device.keysRotated` statements. Every other event
// (the vault's data: imports, balances, categories) is skipped before its content is read, and leaves
// the outcome exactly as if it had never been delivered. Synthetic data only.
import { describe, expect, it } from "vitest";
import {
  createSimVault,
  newEid,
  pairDevice,
  type SimDevice,
  START_TIME,
  sodium,
} from "../testing/devices/testkit.js";
import type { LogEvent } from "./events.js";
import { type IngestReport, VaultDevices } from "./vaultDevices.js";

/** `e` with its `data` behind a getter that counts reads (the copy key reads it; nothing else here does). */
function counted(e: LogEvent, reads: { n: number }): LogEvent {
  const { data, ...rest } = e;
  return Object.defineProperty({ ...rest }, "data", {
    enumerable: true,
    get() {
      reads.n++;
      return data;
    },
  }) as LogEvent;
}

/** A data event of the vault (not a statement the devices state keeps). */
function dataEvent(writer: string, i: number, type = "budget.txn.imported"): LogEvent {
  return {
    eid: newEid(),
    hlc: `${String(START_TIME + i).padStart(13, "0")}-0000-${writer}`,
    writer,
    position: { seg: 1, offset: 10_000 + i },
    type,
    v: 1,
    data: { account: "acc-1", amount: `-${i}.00`, payee: `SHOP ${i % 7}`, tags: [i, { k: i }] },
  };
}

function statementsOf(...devices: SimDevice[]): LogEvent[] {
  return devices.flatMap((d) => d.stream.flatMap((s) => s.events));
}

/** A devices state over `d`'s identity and keys, nothing ingested yet. */
function fresh(d: SimDevice): VaultDevices {
  return new VaultDevices({
    sodium,
    identity: d.identity,
    ring: d.ring,
    provenance: d.provenance,
    clock: () => START_TIME + 1_000_000,
    verify: d.verify,
    certificateCache: d.certificateCache,
  });
}

function trustState(v: VaultDevices) {
  const r = v.registry;
  return {
    trusted: [...r.trusted.keys()].sort(),
    revoked: [...r.revoked].sort(),
    events: r.events.map((e) => e.eid),
  };
}

async function vaultOfTwo() {
  const { creator: a } = createSimVault();
  const b = await pairDevice(a, "phone");
  for (const d of [a, b]) d.sync();
  return { a, b };
}

describe("VaultDevices.ingest copy keys", () => {
  it("never reads a data event's content; reads every statement's (dedupe)", async () => {
    const { a, b } = await vaultOfTwo();
    const statements = statementsOf(a, b);
    expect(statements.length).toBeGreaterThan(2);
    const dataReads = { n: 0 };
    const data = Array.from({ length: 500 }, (_, i) =>
      counted(
        dataEvent(i % 2 ? a.id : b.id, i, i % 3 ? "budget.txn.imported" : "budget.balance"),
        dataReads,
      ),
    );
    const report = a.devices.ingest(data);
    expect(dataReads.n).toBe(0);
    expect(report.registryChanged).toBe(false);

    // The statements again (already held): each one's copy key is built, so each content is read,
    // and the copies are recognised as held (no new fold).
    const statementReads = { n: 0 };
    const again = a.devices.ingest(statements.map((e) => counted(e, statementReads)));
    expect(statementReads.n).toBeGreaterThanOrEqual(statements.length);
    expect(again.registryChanged).toBe(false);
  });

  it("data events interleaved and duplicated change nothing: same reports and trust state as statements alone", async () => {
    const { a, b } = await vaultOfTwo();
    const statements = statementsOf(a, b);
    const mixed: LogEvent[] = [];
    for (const [i, s] of statements.entries()) {
      mixed.push(dataEvent(a.id, i), s, dataEvent(b.id, 100 + i));
    }
    // a statement delivered twice in one pass and a data event that shares a statement's eid
    mixed.push(statements[0] as LogEvent, {
      ...dataEvent(a.id, 999),
      eid: (statements[0] as LogEvent).eid,
    });

    const plain = fresh(a);
    const noisy = fresh(a);
    const reports: [IngestReport, IngestReport][] = [
      [plain.ingest(statements), noisy.ingest(mixed)],
      [plain.ingest(statements), noisy.ingest([...mixed].reverse())], // redelivery: all held
      [plain.ingest([]), noisy.ingest(mixed.filter((_, i) => i % 3 !== 1))], // data only
    ];
    for (const [want, got] of reports) expect(got).toEqual(want);
    expect(reports[0]?.[0].registryChanged).toBe(true);
    expect(reports[1]?.[0].registryChanged).toBe(false);
    expect(trustState(noisy)).toEqual(trustState(plain));
    expect(trustState(plain).trusted).toEqual([a.id, b.id].sort());
  });
});
