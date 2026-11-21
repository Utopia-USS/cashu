// `device.left`: a device's own note that it removed its copy. It is informational: the registry
// reports `leftAt` for the writer, and nothing about trust, keys, revocations or the lease changes
// (the owner still removes the device with the recovery words). Synthetic data only.
import { describe, expect, it } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import {
  createSimVault,
  newEid,
  pairDevice,
  type SimDevice,
  START_TIME,
  sodium,
} from "../testing/devices/testkit.js";
import { toHex } from "./bytes.js";
import {
  buildDeviceLeft,
  DEVICE_EVENT_VERSION,
  DEVICE_LEFT,
  type LogEvent,
  statementBody,
} from "./events.js";
import { foldRegistry, type Registry } from "./registry.js";

const LEFT_AT = START_TIME + 3_600_000;

async function vaultOfTwo() {
  const { creator: mac, recovery } = createSimVault();
  const phone = await pairDevice(mac, "phone");
  for (const d of [mac, phone]) d.sync();
  return { mac, phone, recovery, vaultId: mac.ring.vaultId };
}

function eventsOf(...devices: SimDevice[]): LogEvent[] {
  return devices.flatMap((d) => d.stream.flatMap((s) => s.events));
}

function fold(device: SimDevice, events: readonly LogEvent[]): Registry {
  return foldRegistry(
    sodium,
    { vaultId: device.ring.vaultId, recovery: device.ring.recovery },
    events,
  );
}

/** Everything the registry decides that is not cosmetic. */
function authority(r: Registry) {
  return {
    trusted: [...r.trusted.keys()].sort(),
    conflicts: [...r.conflicts],
    revoked: [...r.revoked.keys()].sort(),
    revocationCount: r.revocationCount,
    events: r.events.map((e) => e.eid),
    recoveryChanges: r.recoveryChanges.map((c) => c.event.eid),
    names: [...r.devices.values()].map((d) => [d.deviceId, d.name, d.addedEid]).sort(),
  };
}

/** A correctly signed `device.left` written by `signer` that names `device` (any device). */
function signedNote(
  signer: SimDevice,
  vaultId: string,
  device: string,
  at: number,
): UnstampedEvent {
  const eid = newEid();
  const unsigned = { device, at };
  const sig = toHex(
    signer.identity.sign("cashu/registry/v1", statementBody(vaultId, DEVICE_LEFT, eid, unsigned)),
  );
  return { t: DEVICE_LEFT, v: DEVICE_EVENT_VERSION, i: eid, d: { ...unsigned, sig } };
}

describe("device.left (a device removed its copy)", () => {
  it("the helper builds a note about the writer itself, signed in the registry context", async () => {
    const { phone, vaultId } = await vaultOfTwo();
    const note = buildDeviceLeft(phone.identity, vaultId, newEid(), LEFT_AT);
    expect(note.t).toBe("device.left");
    expect(note.v).toBe(1);
    expect(Object.keys(note.d).sort()).toEqual(["at", "device", "sig"]);
    expect(note.d.device).toBe(phone.id);
    expect(note.d.at).toBe(LEFT_AT);
    expect(() => buildDeviceLeft(phone.identity, vaultId, "not-a-ulid", LEFT_AT)).toThrow();
    expect(() => buildDeviceLeft(phone.identity, vaultId, newEid(), 0)).toThrow();
    expect(() => buildDeviceLeft(phone.identity, vaultId, newEid(), 1.5)).toThrow();
  });

  it("every device's registry reports leftAt for the writer, and trust, keys and the lease stay the same", async () => {
    const { mac, phone, vaultId } = await vaultOfTwo();
    const before = authority(mac.devices.registry);
    const leaseBefore = { ...mac.devices.lease };
    const rotationBefore = mac.devices.rotationNeeded();
    expect(mac.devices.registry.devices.get(phone.id)?.leftAt).toBeUndefined();

    phone.write([buildDeviceLeft(phone.identity, vaultId, newEid(), LEFT_AT)]);
    phone.push();
    mac.sync();

    const after = mac.devices.registry;
    expect(after.devices.get(phone.id)?.leftAt).toBe(LEFT_AT);
    expect(after.devices.get(mac.id)?.leftAt).toBeUndefined();
    expect(after.isTrusted(phone.id)).toBe(true);
    expect(after.isRegistered(phone.id)).toBe(true);
    expect(after.revoked.has(phone.id)).toBe(false);
    expect(authority(after)).toEqual(before);
    expect(after.ignored).toEqual([]);
    expect(mac.devices.lease).toEqual(leaseBefore);
    expect(mac.devices.rotationNeeded()).toBe(rotationBefore);
    // The phone's own fold agrees (the note is in its own stream).
    expect(phone.devices.registry.devices.get(phone.id)?.leftAt).toBe(LEFT_AT);
    // The frame carrying the note was accepted like any other.
    expect(mac.rejections).toEqual([]);
  });

  it("a note naming another device than its writer is ignored", async () => {
    const { mac, phone, vaultId } = await vaultOfTwo();
    const events = eventsOf(mac, phone);
    const forged = signedNote(mac, vaultId, phone.id, LEFT_AT);
    mac.write([forged]);
    const r = fold(mac, eventsOf(mac, phone));
    expect(r.devices.get(phone.id)?.leftAt).toBeUndefined();
    expect(r.devices.get(mac.id)?.leftAt).toBeUndefined();
    expect(r.ignored).toEqual([{ eid: forged.i, reason: "untrusted_signer" }]);
    expect(authority(r)).toEqual(authority(fold(mac, events)));
  });

  it("forged, tampered and malformed notes are ignored", async () => {
    const { mac, phone, vaultId } = await vaultOfTwo();
    const genuine = buildDeviceLeft(phone.identity, vaultId, newEid(), LEFT_AT);
    // Signed by the Mac with the phone's id as writer of the frame: the key does not match.
    const wrongKey = signedNote(mac, vaultId, phone.id, LEFT_AT);
    const tampered = { ...genuine, i: newEid(), d: { ...genuine.d, at: LEFT_AT - 1 } };
    const otherVault = buildDeviceLeft(phone.identity, "ab".repeat(16), newEid(), LEFT_AT);
    const extraField = { ...genuine, i: newEid(), d: { ...genuine.d, reason: "x" } };
    const newerVersion = { ...genuine, i: newEid(), v: 2 };
    const at = (e: UnstampedEvent, offset: number): LogEvent => ({
      eid: e.i,
      hlc: `${String(LEFT_AT + offset).padStart(13, "0")}-0000-${phone.id}`,
      writer: phone.id,
      position: { seg: 1, offset: 90_000 + offset },
      type: e.t,
      v: e.v,
      data: e.d,
    });
    const r = fold(mac, [
      ...eventsOf(mac, phone),
      at(wrongKey, 1),
      at(tampered, 2),
      at(otherVault, 3),
      at(extraField, 4),
      at(newerVersion, 5),
    ]);
    expect(r.devices.get(phone.id)?.leftAt).toBeUndefined();
    expect(r.ignored.map((i) => i.reason).sort()).toEqual([
      "bad_signature",
      "bad_signature",
      "bad_signature",
      "malformed",
      "malformed",
    ]);
  });

  it("duplicates are idempotent and several notes report the earliest, in any order", async () => {
    const { mac, phone, vaultId } = await vaultOfTwo();
    const later = buildDeviceLeft(phone.identity, vaultId, newEid(), LEFT_AT + 60_000);
    const earlier = buildDeviceLeft(phone.identity, vaultId, newEid(), LEFT_AT);
    phone.write([later]);
    phone.write([earlier]);
    const all = eventsOf(mac, phone);
    const notes = all.filter((e) => e.type === DEVICE_LEFT);
    expect(notes).toHaveLength(2);
    const forward = fold(mac, [...all, ...notes]);
    const backward = fold(mac, [...notes, ...all].reverse());
    for (const r of [forward, backward]) {
      expect(r.devices.get(phone.id)?.leftAt).toBe(LEFT_AT);
      expect(r.ignored).toEqual([]);
    }
    expect(authority(forward)).toEqual(authority(backward));
  });

  it("a device.* type this build does not know is skipped without refusing the frame (old builds meet device.left like this)", async () => {
    const { mac, phone } = await vaultOfTwo();
    const before = authority(mac.devices.registry);
    phone.write([
      { t: "device.notYetDefined", v: 1, i: newEid(), d: { device: phone.id, at: LEFT_AT } },
    ]);
    phone.push();
    mac.sync();
    expect(mac.rejections).toEqual([]);
    expect(authority(mac.devices.registry)).toEqual(before);
    expect(mac.devices.registry.ignored).toEqual([]);
  });
});
