// Test support (not exported): the registry's order-freedom property on a mutual revocation (each
// device revokes the other with its consent, each after the other's cut), shared by the default
// tier (registry.test.ts, a few seeds) and the sweep (registry.order.exhaustive.test.ts).

import { expect } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import { CertificateCache } from "../crypto/index.js";
import type { LogEvent } from "./events.js";
import { foldRegistry, type Registry } from "./registry.js";
import { memoizedVerifier } from "./statements.js";
import {
  createSimVault,
  hlcAt,
  pairDevice,
  revokedWithConsent,
  type SimDevice,
  START_TIME,
  sodium,
} from "./testkit.js";

export interface OrderScenario {
  readonly a: SimDevice;
  readonly events: readonly LogEvent[];
  readonly reference: Registry;
  readonly fold: (events: readonly LogEvent[]) => Registry;
}

function stamp(e: UnstampedEvent, writer: string, wall: number, offset: number): LogEvent {
  const position = { seg: 1, offset };
  return { eid: e.i, hlc: hlcAt(writer, wall), writer, position, type: e.t, v: e.v, data: e.d };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** A, B (paired by A), C (paired by B), D (paired by A); B and D revoke each other with consent. */
export async function mutualRevocationScenario(): Promise<OrderScenario> {
  const { creator: a } = createSimVault();
  const b = await pairDevice(a, "phone");
  const c = await pairDevice(b, "laptop");
  const d = await pairDevice(a, "watch"); // B's sibling: neither certified the other (H5')
  for (const x of [a, b, c, d]) x.sync();
  const vaultId = a.ring.vaultId;
  const bRevokesD = stamp(
    revokedWithConsent(b.identity, vaultId, [{ device: d.id, cut: { seg: 1, offset: 0 } }], [d]),
    b.id,
    START_TIME + 1e7,
    1e6,
  );
  const dRevokesB = stamp(
    revokedWithConsent(d.identity, vaultId, [{ device: b.id, cut: { seg: 1, offset: 0 } }], [b]),
    d.id,
    START_TIME + 2e7,
    1e6,
  );
  const events = [
    ...[a, b, c, d].flatMap((x) => x.stream.flatMap((s) => s.events)),
    bRevokesD,
    dRevokesB,
  ];
  // One signature cache for every fold of the scenario: results are a function of the bytes.
  const options = { verify: memoizedVerifier(), certificateCache: new CertificateCache() };
  const fold = (list: readonly LogEvent[]) =>
    foldRegistry(sodium, { vaultId, recovery: a.ring.recovery }, list, options);
  const reference = fold(events);
  // No order decides between the two: both are revoked, the pair is contested.
  expect(reference.revoked.has(d.id)).toBe(true);
  expect(reference.revoked.has(b.id)).toBe(true);
  expect(reference.revoked.get(b.id)?.contested).toBe(true);
  expect(reference.revocationCount).toBe(2);
  expect([...reference.trusted.keys()]).toEqual([a.id]);
  return { a, events, reference, fold };
}

/** The fold of a shuffled copy (with duplicates) equals the reference. */
export function expectOrderFree(s: OrderScenario, seed: number): void {
  const { events, reference } = s;
  const r = s.fold(shuffle([...events, ...events.slice(0, seed % events.length)], seed));
  expect([...r.trusted.keys()].sort()).toEqual([...reference.trusted.keys()].sort());
  expect([...r.revoked.keys()]).toEqual([...reference.revoked.keys()]);
  expect([...r.revoked.values()].map((x) => x.cut)).toEqual(
    [...reference.revoked.values()].map((x) => x.cut),
  );
  expect(r.revocationCount).toBe(2);
}
