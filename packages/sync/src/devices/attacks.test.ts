// The S29 security review's attacks (S29-review.md B1 / M1), kept as permanent tests, and the
// delivery-order property: devices that hold the same events agree on the registry and on the
// accepted data, whatever order the events arrived in.

import { describe, expect, it } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import { parseHlc } from "../hlc.js";
import { buildDeviceRevoked, buildLeaseClaim, type LogEvent } from "./events.js";
import { foldRegistry, type Registry } from "./registry.js";
import {
  type Batch,
  createSimVault,
  hlcAt,
  newEid,
  pairDevice,
  type SimDevice,
  START_CURSOR,
  sodium,
} from "./testkit.js";

function note(): UnstampedEvent {
  return { t: "note.added", v: 1, i: newEid(), d: {} };
}

function honestRevoke(revoker: SimDevice, ...targets: SimDevice[]): LogEvent {
  const result = revoker.devices.prepareRevocation(
    targets.map((t) => ({ device: t.id, cut: revoker.cursors.get(t.id) ?? START_CURSOR })),
    { revoke: newEid(), rotate: newEid() },
  );
  if (!result.ok) throw new Error(result.reason);
  const batch = revoker.write(result.change.events);
  result.change.commit();
  return batch.events[0] as LogEvent;
}

async function fourDevices() {
  const vault = createSimVault();
  const a = vault.creator;
  const b = await pairDevice(a, "phone");
  const r = await pairDevice(a, "laptop");
  const c = await pairDevice(a, "tablet");
  for (let i = 0; i < 2; i++) for (const d of [a, b, r, c]) d.sync();
  return { ...vault, a, b, r, c };
}

function summary(reg: Registry) {
  return {
    trusted: [...reg.trusted.keys()].sort(),
    revoked: [...reg.revoked.values()].map((x) => [x.device, x.cut.seg, x.cut.offset]).sort(),
    count: reg.revocationCount,
  };
}

function syncAll(devices: readonly SimDevice[], rounds = 2): void {
  for (let i = 0; i < rounds; i++) for (const d of devices) d.sync();
}

describe("review attacks", () => {
  it("A1: a revoked device backdates a revocation of its revoker; every device ends with both revoked, in any delivery order", async () => {
    for (const order of ["revoker-first", "attacker-first"] as const) {
      const { a, b, r, c } = await fourDevices();
      r.write([note()]);
      syncAll([a, b, r, c]);
      const bRevokesR = honestRevoke(b, r);
      b.push();
      r.pull(); // the batch is sealed under the old key: R reads it
      // R answers in its own stream, after its cut, stamped one second BEFORE B's revocation.
      const wall = parseHlc(bRevokesR.hlc).wall - 1000;
      r.write(
        [
          buildDeviceRevoked(r.identity, r.ring.vaultId, newEid(), [
            { device: b.id, cut: START_CURSOR },
          ]),
        ],
        { hlc: () => hlcAt(r.id, wall) },
      );
      r.push();
      if (order === "attacker-first") {
        c.pull((batch) => batch.device === r.id);
        // C's guard accepted R's frame while it did not know R was revoked ...
        expect(c.acceptedData()).toContain(
          `${r.id}@${r.stream[r.stream.length - 1]?.cursor.offset}`,
        );
        expect(c.devices.registry.isTrusted(r.id)).toBe(true);
      } else {
        c.pull((batch) => batch.device === b.id);
      }
      syncAll([a, b, r, c]);
      // ... and every device converges: R stays revoked, B is revoked too (mutual: fail closed).
      const reference = summary(a.devices.registry);
      expect(reference.revoked.map((x) => x[0]).sort()).toEqual([b.id, r.id].sort());
      expect(reference.trusted).toEqual([a.id, c.id].sort());
      for (const d of [b, r, c]) expect(summary(d.devices.registry)).toEqual(reference);
      expect(a.devices.registry.revoked.get(b.id)?.contested).toBe(true);
      for (const d of [b, r, c]) expect(d.acceptedData()).toEqual(a.acceptedData());
      if (order === "attacker-first") {
        expect(c.rejections.some((x) => x.device === r.id)).toBe(true);
      }
      // A device paired afterwards and a rebuilt device reach the same registry.
      const j = await pairDevice(a, "new phone");
      c.rebuild();
      syncAll([a, b, r, c, j]);
      const after = summary(a.devices.registry);
      for (const d of [b, c, j]) expect(summary(d.devices.registry)).toEqual(after);
      expect(after.revoked.map((x) => x[0]).sort()).toEqual([b.id, r.id].sort());
      for (const d of [c, j]) expect(d.acceptedData()).toEqual(a.acceptedData());
      // The next rotation wraps for neither of them.
      const rotation = a.devices.prepareRotation(newEid());
      if (!rotation.ok) throw new Error(rotation.reason);
      expect(rotation.change.recipients).toEqual(expect.not.arrayContaining([b.id, r.id]));
      rotation.change.discard();
    }
  });

  it("A1b: a revoked device rewrites one of its own frames before its cut; fresh joiners and rebuilds never trust it again", async () => {
    const { a, b, r, c } = await fourDevices();
    const original = r.write([note()]);
    syncAll([a, b, r, c]);
    honestRevoke(b, r);
    syncAll([a, b, c]);
    // Untrusted storage now holds a rewritten frame at the same position (before R's cut) that
    // also carries a backdated revocation of B. Devices that applied the original never re-read it.
    const forged = buildDeviceRevoked(r.identity, r.ring.vaultId, newEid(), [
      { device: b.id, cut: START_CURSOR },
    ]);
    const rewritten: Batch = {
      ...original,
      events: [
        ...original.events,
        {
          eid: forged.i,
          hlc: hlcAt(r.id, parseHlc(original.events[0]?.hlc ?? "").wall, 1),
          writer: r.id,
          position: original.cursor,
          type: forged.t,
          v: forged.v,
          data: forged.d,
        },
      ],
    };
    r.remote.replace(rewritten);
    const j = await pairDevice(a, "new phone");
    c.rebuild();
    syncAll([a, b, c, j]);
    for (const d of [j, c]) {
      const reg = d.devices.registry;
      // The rewritten revocation attests nothing B did not see: B revoked R with a cut past it,
      // so it cannot defeat B's revocation; both count, R is never trusted again.
      expect(reg.revoked.has(r.id)).toBe(true);
      expect(reg.isTrusted(r.id)).toBe(false);
      expect(reg.revoked.has(b.id)).toBe(true);
    }
    expect(summary(c.devices.registry)).toEqual(summary(j.devices.registry));
    // Devices that applied the original frame never saw the rewrite (no signed heads yet, S28d).
    expect(a.devices.registry.revoked.has(r.id)).toBe(true);
    expect(a.devices.registry.isTrusted(b.id)).toBe(true);
  });

  it("A2 / M1: a cut at START is raised to what the revoker attested; recovery-signed cuts override it", async () => {
    const { a, b, r, c, recovery } = await fourDevices();
    b.write([note()]);
    syncAll([a, b, r, c]);
    // R (still trusted, stolen) once attested B's stream in a lease claim, then revokes B at START.
    const attested = r.cursors.get(b.id);
    expect(attested).toBeDefined();
    r.write([
      buildLeaseClaim(r.identity, r.ring.vaultId, newEid(), {
        at: r.now(),
        until: r.now() + 60 * 60 * 1000,
        watermark: { [b.id]: attested ?? START_CURSOR },
        prev: null,
      }),
    ]);
    r.write([
      buildDeviceRevoked(r.identity, r.ring.vaultId, newEid(), [
        { device: b.id, cut: START_CURSOR },
      ]),
    ]);
    syncAll([a, b, r, c]);
    expect(a.devices.registry.revoked.get(b.id)?.cut).toEqual(attested);
    expect(a.cursors.get(b.id)).toEqual(attested);
    b.write([note()]); // after its cut: rejected for now
    syncAll([a, b, r, c]);
    expect(a.cursors.get(b.id)).toEqual(attested);
    // The owner notices: the recovery words revoke R and set B's cut to the end of B's stream.
    const bEnd = b.stream[b.stream.length - 1]?.cursor ?? START_CURSOR;
    a.write([
      buildDeviceRevoked(recovery, a.ring.vaultId, newEid(), [
        { device: r.id, cut: a.cursors.get(r.id) ?? START_CURSOR },
        { device: b.id, cut: bEnd },
      ]),
    ]);
    syncAll([a, b, r, c]);
    for (const d of [a, c]) {
      expect(d.devices.registry.revoked.get(b.id)?.cut).toEqual(bEnd);
      expect(d.devices.registry.revoked.has(r.id)).toBe(true);
      expect(d.cursors.get(b.id)).toEqual(bEnd);
    }
  });

  it("property: any delivery order gives every device the same registry and accepted data", async () => {
    for (let seed = 1; seed <= 10; seed++) {
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
          const honest = actor.devices.prepareRevocation(
            [{ device: target.id, cut: actor.cursors.get(target.id) ?? START_CURSOR }],
            { revoke: newEid(), rotate: newEid() },
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
                    cut:
                      rand() < 0.5 ? START_CURSOR : (actor.cursors.get(target.id) ?? START_CURSOR),
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
  }, 120_000);
});

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed * 7919);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
