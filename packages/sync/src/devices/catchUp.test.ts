// S29c R3a (S29-review.md "S29b re-check" R3): one bogus or stale watermark entry must not block
// newest-day imports forever. Entries count only for registered devices, expire with revocation
// (capped at the cut), are dropped for conflicted devices, and the owner can waive a device whose
// data is lost or withheld. R3b (signed heads) comes later.

import { describe, expect, it } from "vitest";
import { type SegmentCursor, START_CURSOR } from "../carrier.js";
import { certifyDevice, createDeviceIdentity } from "../crypto/index.js";
import {
  buildDeviceAdded,
  buildLeaseClaim,
  buildLeaseRenewal,
  decodeLeaseClaim,
  decodeLeaseRenewal,
  type Watermark,
} from "./events.js";
import { catchUpMissing, foldLease, type LeaseView } from "./lease.js";
import { createSimVault, newEid, pairDevice, type SimDevice, sodium } from "./testkit.js";

const HOUR = 60 * 60 * 1000;

function view(d: SimDevice): LeaseView {
  return d.devices.lease;
}

function missing(d: SimDevice): string[] {
  return catchUpMissing(view(d), d.applied).map((m) => m.device);
}

function watermarkOf(d: SimDevice, extra: Watermark = {}): Watermark {
  return { ...Object.fromEntries(d.applied), ...extra };
}

/** `d` claims the lease (any trusted device may) naming `watermark` and waiving `waive`. */
function claim(d: SimDevice, watermark: Watermark, waive?: readonly string[]): string {
  const eid = newEid();
  d.write([
    buildLeaseClaim(d.identity, d.ring.vaultId, eid, {
      at: d.now(),
      until: d.now() + HOUR,
      watermark,
      prev: view(d).head,
      ...(waive ? { waive } : {}),
    }),
  ]);
  return eid;
}

function note() {
  return { t: "note.added", v: 1, i: newEid(), d: {} };
}

function syncAll(devices: readonly SimDevice[], rounds = 2): void {
  for (let i = 0; i < rounds; i++) for (const d of devices) d.sync();
}

async function vault() {
  const v = createSimVault();
  const a = v.creator;
  const b = await pairDevice(a, "phone");
  const c = await pairDevice(a, "laptop");
  const r = await pairDevice(a, "tablet");
  syncAll([a, b, c, r]);
  return { ...v, a, b, c, r };
}

const FAR: SegmentCursor = { seg: 999, offset: 0 };

describe("R3a: validated catch-up watermarks", () => {
  it("an entry naming an unregistered device never blocks; it is reported as unknown_device", async () => {
    const { a, b, c, r } = await vault();
    const bogus = createDeviceIdentity(sodium).deviceId;
    const eid = claim(r, watermarkOf(r, { [bogus]: FAR }));
    syncAll([a, b, c, r]);
    for (const d of [a, b, c]) {
      expect(missing(d), d.name).toEqual([]);
      expect(view(d).catchUp[bogus]).toBeUndefined();
      expect(view(d).catchUpDropped).toContainEqual({
        device: bogus,
        reason: "unknown_device",
        eid,
      });
    }
  });

  it("a stale entry for a real device blocks until the owner waives it; a later holder can raise it again", async () => {
    const { a, b, c, r } = await vault();
    b.write([note()]);
    syncAll([a, b, c, r]);
    claim(r, watermarkOf(r, { [b.id]: FAR }));
    syncAll([a, b, c, r]);
    expect(missing(c)).toEqual([b.id]);
    // The owner confirms on C that B's data up to there does not exist: C's claim waives B, and the
    // requirement for B restarts at C's own entry for it.
    claim(c, watermarkOf(c), [b.id]);
    syncAll([a, b, c, r]);
    for (const d of [a, b, c]) {
      expect(missing(d), d.name).toEqual([]);
      expect(view(d).catchUp[b.id]).toEqual(c.applied.get(b.id));
    }
    claim(a, watermarkOf(a, { [b.id]: FAR }));
    syncAll([a, b, c, r]);
    expect(missing(c)).toEqual([b.id]);
  });

  it("a revoked writer's pre-cut entries still count; a revoked named device is needed only up to its cut", async () => {
    const { a, b, c, r } = await vault();
    c.write([note()]);
    syncAll([a, b, c, r]);
    const high = { seg: 1, offset: 100_000 };
    claim(r, watermarkOf(r, { [c.id]: high }));
    syncAll([a, b, c, r]);
    const revoke = (target: SimDevice) => {
      const p = a.devices.prepareRevocation(
        [{ device: target.id, cut: a.cursors.get(target.id) ?? START_CURSOR }],
        { revoke: newEid(), rotate: newEid() },
      );
      if (!p.ok) throw new Error(p.reason);
      a.write(p.change.events);
      p.change.commit();
    };
    revoke(r);
    syncAll([a, b, c]);
    expect(b.devices.registry.revoked.has(r.id)).toBe(true);
    expect(view(b).catchUp[c.id]).toEqual(high); // R's claim lies before its cut: it counts
    expect(missing(b)).toEqual([c.id]);
    revoke(c);
    syncAll([a, b]);
    const cut = b.devices.registry.revoked.get(c.id)?.cut;
    expect(view(b).catchUp[c.id]).toEqual(cut);
    expect(missing(b)).toEqual([]);
  });

  it("an entry naming a conflicted device is dropped as untrusted_device", async () => {
    const { a, b, c, r } = await vault();
    const other = createDeviceIdentity(sodium);
    const second = {
      deviceId: b.id,
      signPublicKey: other.signPublicKey,
      boxPublicKey: other.box.publicKey,
    };
    // A trusted device certifies a second key pair for B: B is conflicted (untrusted, not revoked).
    a.write([
      buildDeviceAdded(
        a.identity,
        a.ring.vaultId,
        newEid(),
        second,
        "phone",
        certifyDevice(sodium, a.identity, second, a.ring.vaultId),
      ),
    ]);
    syncAll([a, c, r]);
    expect(c.devices.registry.conflicts).toContain(b.id);
    const eid = claim(r, watermarkOf(r, { [b.id]: FAR }));
    syncAll([a, c, r]);
    expect(missing(c)).toEqual([]);
    expect(view(c).catchUpDropped).toContainEqual({
      device: b.id,
      reason: "untrusted_device",
      eid,
    });
  });

  it("withheld honest data blocks and names who requires it; the owner's waiver unblocks", async () => {
    const { a, b, c, r } = await vault();
    b.write([note()]);
    b.push();
    a.pull();
    const eid = claim(a, watermarkOf(a));
    a.push();
    // The remote withholds B's frames from C.
    const notB = (batch: { device: string }) => batch.device !== b.id;
    c.pull(notB);
    expect(missing(c)).toEqual([b.id]);
    expect(view(c).catchUpSources.get(b.id)).toBe(eid);
    claim(c, watermarkOf(c), [b.id]);
    c.push();
    for (const d of [a, r]) d.pull(notB);
    for (const d of [a, c, r]) {
      expect(missing(d), d.name).toEqual([]);
      expect(view(d).catchUp[b.id]).toBeUndefined();
    }
  });

  it("the requirement is a function of the event set (shuffled delivery)", async () => {
    const { a, b, c, r } = await vault();
    b.write([note()]);
    syncAll([a, b, c, r]);
    const bogus = createDeviceIdentity(sodium).deviceId;
    claim(r, watermarkOf(r, { [bogus]: FAR, [b.id]: FAR }));
    syncAll([a, b, c, r]);
    claim(c, watermarkOf(c), [b.id]);
    syncAll([a, b, c, r]);
    claim(a, watermarkOf(a, { [c.id]: { seg: 1, offset: 50_000 } }));
    syncAll([a, b, c, r]);
    const events = [a, b, c, r].flatMap((d) => d.stream.flatMap((s) => s.events));
    const reference = view(a);
    for (let seed = 1; seed <= 6; seed++) {
      const again = foldLease(a.devices.registry, shuffle(events, seed));
      expect(again.catchUp).toEqual(reference.catchUp);
      expect(again.catchUpSources).toEqual(reference.catchUpSources);
      expect(again.catchUpDropped).toEqual(reference.catchUpDropped);
    }
  });

  it("waive is strict: sorted, unique, 1-64 device ids; claims and renewals carry it", async () => {
    const { a } = await vault();
    const ids = Array.from({ length: 3 }, () => createDeviceIdentity(sodium).deviceId);
    const built = buildLeaseRenewal(a.identity, a.ring.vaultId, newEid(), {
      at: a.now(),
      until: a.now() + HOUR,
      watermark: {},
      prev: newEid(),
      waive: [ids[2] as string, ids[0] as string, ids[1] as string, ids[0] as string],
    });
    expect(decodeLeaseRenewal(built.d)?.waive).toEqual([...ids].sort());
    const claimed = buildLeaseClaim(a.identity, a.ring.vaultId, newEid(), {
      at: a.now(),
      until: a.now() + HOUR,
      watermark: {},
      prev: null,
    });
    expect(decodeLeaseClaim(claimed.d)).toBeDefined();
    expect(decodeLeaseClaim(claimed.d)).not.toHaveProperty("waive");
    const sorted = [...ids].sort();
    for (const waive of [
      [],
      [...sorted].reverse(),
      [sorted[0], sorted[0]],
      ["x"],
      Array.from({ length: 65 }, (_, i) => (i + 1).toString(16).padStart(32, "0")),
    ]) {
      expect(decodeLeaseClaim({ ...claimed.d, waive }), JSON.stringify(waive)).toBeUndefined();
    }
    expect(() =>
      buildLeaseClaim(a.identity, a.ring.vaultId, newEid(), {
        at: a.now(),
        until: a.now() + HOUR,
        watermark: {},
        prev: null,
        waive: ["not a device"],
      }),
    ).toThrow(RangeError);
  });
});

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
