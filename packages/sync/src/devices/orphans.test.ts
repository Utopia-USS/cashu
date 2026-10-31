// S29c review round 6, W1: re-certifying the orphans of a revocation is the owner's explicit choice
// per device. On the words path (lost or stolen: the thief may have paired anything) nothing is
// preselected; the consent path (the device is in the owner's hands) may suggest them. Orphans not
// chosen stay untrusted and nothing is sealed for them.

import { describe, expect, it } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import { certifyDevice, createDeviceIdentity } from "../crypto/index.js";
import { buildDeviceAdded, buildLeaseClaim, DEVICE_ADDED, type LogEvent } from "./events.js";
import { foldRegistry } from "./registry.js";
import {
  createSimVault,
  hlcAt,
  newEid,
  pairDevice,
  prepareConsented,
  type SimDevice,
  START_CURSOR,
  START_TIME,
  sodium,
} from "./testkit.js";

function syncAll(devices: readonly SimDevice[], rounds = 2): void {
  for (let i = 0; i < rounds; i++) for (const d of devices) d.sync();
}

/** The owner's phone B; the laptop R the creator paired; an "iPad" paired by R (the thief). */
async function stolenLaptop() {
  const vault = createSimVault();
  const a = vault.creator;
  const b = await pairDevice(a, "phone");
  const r = await pairDevice(a, "laptop");
  const ipad = await pairDevice(r, "iPad");
  syncAll([a, b, r, ipad]);
  return { ...vault, a, b, r, ipad };
}

function revokeWithWords(
  a: SimDevice,
  r: SimDevice,
  words: NonNullable<SimDevice["words"]>,
  recertify: readonly string[] = [],
) {
  return a.devices.prepareRevocation(
    [{ device: r.id, cut: a.cursors.get(r.id) ?? START_CURSOR }],
    { revoke: newEid(), rotate: newEid(), recertify: newEid },
    words,
    { recertify },
  );
}

describe("W1: re-certification is the owner's choice", () => {
  it("revoking a stolen laptop with the words never re-certifies the iPad it paired, nor seals the new key for it", async () => {
    const { a, b, r, ipad, recovery } = await stolenLaptop();
    const result = revokeWithWords(a, r, recovery);
    if (!result.ok) throw new Error(result.reason);
    expect(result.change.affected).toMatchObject([
      {
        device: ipad.id,
        name: "iPad",
        pairedBy: r.id,
        suggested: false,
        recertified: false,
        reason: "not_selected",
      },
    ]);
    expect(result.change.events.some((e) => e.t === DEVICE_ADDED)).toBe(false);
    expect(result.change.recipients).not.toContain(ipad.id);
    a.write(result.change.events);
    result.change.commit();
    syncAll([a, b, ipad]);
    for (const x of [a, b]) {
      expect(x.devices.registry.isTrusted(ipad.id), x.name).toBe(false);
      expect(x.devices.registry.revoked.has(r.id), x.name).toBe(true);
    }
    expect(ipad.ring.get(a.ring.active.kid)).toBeUndefined(); // the new data key never reached it
  });

  it("on the words path an explicit selection re-certifies exactly the chosen orphans", async () => {
    const { a, b, r, ipad, recovery } = await stolenLaptop();
    const phone2 = await pairDevice(r, "work phone");
    syncAll([a, b, ipad, phone2]);
    const result = revokeWithWords(a, r, recovery, [phone2.id]);
    if (!result.ok) throw new Error(result.reason);
    const byDevice = new Map(result.change.affected.map((x) => [x.device, x]));
    expect(byDevice.get(phone2.id)).toMatchObject({ recertified: true, suggested: false });
    expect(byDevice.get(ipad.id)).toMatchObject({ recertified: false, reason: "not_selected" });
    expect(result.change.recipients).toContain(phone2.id);
    expect(result.change.recipients).not.toContain(ipad.id);
    a.write(result.change.events);
    result.change.commit();
    syncAll([a, b, ipad, phone2]);
    expect(b.devices.registry.isTrusted(phone2.id)).toBe(true);
    expect(b.devices.registry.isTrusted(ipad.id)).toBe(false);
  });

  it("the consent path suggests the orphans; re-certifying them is still the owner's explicit pick", async () => {
    const { a, b, r, ipad } = await stolenLaptop();
    const suggested = prepareConsented(b, [r]); // R is in the owner's hands: B retires it
    if (!suggested.ok) throw new Error(suggested.reason);
    expect(suggested.change.affected).toMatchObject([
      { device: ipad.id, suggested: true, recertified: false, reason: "not_selected" },
    ]);
    suggested.change.discard();
    const picked = prepareConsented(b, [r], undefined, [ipad]);
    if (!picked.ok) throw new Error(picked.reason);
    expect(picked.change.affected).toMatchObject([{ device: ipad.id, recertified: true }]);
    b.write(picked.change.events);
    picked.change.commit();
    syncAll([a, b, ipad]);
    expect(a.devices.registry.isTrusted(ipad.id)).toBe(true);
  });

  it("V2 stays closed: an unchosen pre-cut puppet of R is not revived, so its minted key cannot raise R's cut", async () => {
    const { a, b, r, ipad: puppet } = await stolenLaptop();
    const result = prepareConsented(b, [r]); // default: nothing re-certified
    if (!result.ok) throw new Error(result.reason);
    const batch = b.write(result.change.events);
    result.change.commit();
    syncAll([a, b]);
    const cut = a.devices.registry.revoked.get(r.id)?.cut;
    expect(cut).toBeDefined();
    // The puppet certifies a second key for B; a rewritten early frame of B's stream carries a "B"
    // lease claim signed with it, attesting R's stream far past its cut.
    const vaultId = a.ring.vaultId;
    const fakeB = createDeviceIdentity(sodium, b.id);
    const subject = {
      deviceId: b.id,
      signPublicKey: fakeB.signPublicKey,
      boxPublicKey: fakeB.box.publicKey,
    };
    const stamp = (e: UnstampedEvent, writer: string, offset: number): LogEvent => ({
      eid: e.i,
      hlc: hlcAt(writer, START_TIME),
      writer,
      position: { seg: 1, offset },
      type: e.t,
      v: e.v,
      data: e.d,
    });
    const forged = [
      stamp(
        buildDeviceAdded(
          puppet.identity,
          vaultId,
          newEid(),
          subject,
          "phone",
          certifyDevice(sodium, puppet.identity, subject, vaultId),
        ),
        puppet.id,
        900_000,
      ),
      stamp(
        buildLeaseClaim(fakeB, vaultId, newEid(), {
          at: START_TIME,
          until: START_TIME + 60 * 60 * 1000,
          watermark: { [r.id]: { seg: 1, offset: 5_000_000 } },
          prev: null,
        }),
        b.id,
        1,
      ),
    ];
    const events = [a, b, r, puppet].flatMap((d) => d.stream.flatMap((s) => s.events));
    const reg = foldRegistry(sodium, { vaultId, recovery: a.ring.recovery }, [
      ...events,
      ...forged,
    ]);
    expect(reg.isTrusted(puppet.id)).toBe(false);
    expect(reg.isTrusted(b.id)).toBe(true);
    expect(reg.revoked.get(r.id)?.cut).toEqual(cut);
    expect(batch.events.some((e) => e.type === DEVICE_ADDED)).toBe(false);
  });
});
