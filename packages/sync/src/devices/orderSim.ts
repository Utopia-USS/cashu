// The delivery-order property of the review attacks, shared by attacks.test.ts (one seed) and the
// sweep (attacks.order.exhaustive.test.ts): five devices write, revoke (honestly or maliciously,
// backdated) and exchange events in a seeded random order; afterwards every device, a rebuild and a
// plain fold over the shuffled union agree on the registry and the accepted data.
// Test support only (synthetic data); production code never imports it.

import { expect } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import { buildDeviceRevoked } from "./events.js";
import { foldRegistry, type Registry } from "./registry.js";
import {
  consentsOf,
  createSimVault,
  hlcAt,
  mulberry32,
  newEid,
  pairDevice,
  prepareReviewedRevocation,
  type SimDevice,
  START_CURSOR,
  sodium,
} from "./testkit.js";

export async function deliveryOrderRun(seed: number): Promise<void> {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const vault = createSimVault();
  const a = vault.creator;
  const b = await pairDevice(a, "b");
  const c = await pairDevice(a, "c");
  const d = await pairDevice(a, "d");
  const e = await pairDevice(b, "e"); // certified by B only (subtree effects)
  const all = [a, b, c, d, e];
  syncAll(all);
  let revocations = 0;
  for (let step = 0; step < 30; step++) {
    const actor = pick(all);
    const roll = rand();
    if (roll < 0.3) {
      actor.write([note()]);
    } else if (roll < 0.42 && revocations < 3) {
      const target = pick(all.filter((x) => x !== actor));
      // Honest: the target consents (H2), half the time; a revocation without consent is refused.
      const entries = [{ device: target.id, cut: actor.cursors.get(target.id) ?? START_CURSOR }];
      const eid = newEid();
      const consent =
        rand() < 0.5 ? consentsOf([target], actor.ring.vaultId, eid, entries, actor.id) : {};
      const honest = prepareReviewedRevocation(
        actor,
        entries,
        { revoke: eid, rotate: newEid(), recertify: newEid },
        { consent },
      );
      if (honest.ok) {
        actor.write(honest.change.events);
        honest.change.commit();
      } else {
        // A malicious (or already revoked) device: arbitrary cut, backdated stamp.
        actor.write(
          [
            buildDeviceRevoked(actor.identity, actor.ring.vaultId, newEid(), [
              {
                device: target.id,
                cut: rand() < 0.5 ? START_CURSOR : (actor.cursors.get(target.id) ?? START_CURSOR),
              },
            ]),
          ],
          { hlc: () => hlcAt(actor.id, vault.remote.time - Math.floor(rand() * 1e7)) },
        );
      }
      revocations += 1;
    } else if (roll < 0.75) {
      actor.pull(() => rand() < 0.6);
    } else {
      actor.push();
    }
    vault.remote.time += 60_000;
  }
  for (const x of all) x.push();
  // Deliver the rest in a random order per device (random partial pulls until complete).
  for (let round = 0; round < 12; round++) for (const x of all) x.pull(() => rand() < 0.5);
  syncAll(all, 2);
  const reference = summary(a.devices.registry);
  for (const x of all) {
    expect(summary(x.devices.registry), `seed ${seed} ${x.name}`).toEqual(reference);
    expect(x.acceptedData(), `seed ${seed} ${x.name}`).toEqual(a.acceptedData());
  }
  // A rebuild from scratch and a plain fold over the shuffled union agree too.
  c.rebuild();
  expect(summary(c.devices.registry)).toEqual(reference);
  expect(c.acceptedData()).toEqual(a.acceptedData());
  const events = shuffle(
    all.flatMap((x) => x.stream.flatMap((s) => s.events)),
    seed,
  );
  const fresh = foldRegistry(
    sodium,
    { vaultId: a.ring.vaultId, recovery: a.ring.recovery },
    events,
    { bootstrapCertificates: [] },
  );
  expect(summary(fresh).revoked).toEqual(reference.revoked);
  expect(summary(fresh).count).toEqual(reference.count);
}

export function note(): UnstampedEvent {
  return { t: "note.added", v: 1, i: newEid(), d: {} };
}

export function summary(reg: Registry) {
  return {
    trusted: [...reg.trusted.keys()].sort(),
    revoked: [...reg.revoked.values()].map((x) => [x.device, x.cut.seg, x.cut.offset]).sort(),
    count: reg.revocationCount,
  };
}

export function syncAll(devices: readonly SimDevice[], rounds = 2): void {
  for (let i = 0; i < rounds; i++) for (const d of devices) d.sync();
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed * 7919);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
