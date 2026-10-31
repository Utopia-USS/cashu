import { describe, expect, it } from "vitest";
import { START_CURSOR } from "../carrier.js";
import {
  CryptoError,
  certifyDevice,
  createDeviceIdentity,
  frameKeyId,
  type Keyring,
  openFrame,
  recoveryRecipient,
  rotateKeyring,
  sealFrame,
  wrapKeys,
} from "../crypto/index.js";
import {
  buildDeviceAdded,
  buildDeviceRevoked,
  buildKeysRotated,
  buildLeaseClaim,
} from "./events.js";
import { devicesNeedingRebuild, type FrameAt } from "./guard.js";
import { foldLease } from "./lease.js";
import { type PreparedChange, prepareRotation } from "./rotation.js";
import { createSimVault, hlcAt, newEid, pairDevice, type SimDevice, sodium } from "./testkit.js";
import { MAX_PENDING_WRAPS_PER_SENDER } from "./vaultDevices.js";

const plain = new TextEncoder().encode("synthetic frame");

/** A data event of another module (ignored by the devices state). */
function note() {
  return { t: "note.added", v: 1, i: newEid(), d: {} };
}

function frameCtx(vaultId: string, at: FrameAt) {
  return { vaultId, deviceId: at.device, segment: at.start.seg, offset: at.start.offset };
}

/** The frame of `device` starting at `offset` (100 bytes long, like the simulator's batches). */
function frameAt(device: string, offset: number): FrameAt {
  return { device, start: { seg: 1, offset }, end: { seg: 1, offset: offset + 100 } };
}

function code(f: () => unknown): string {
  try {
    f();
    return "ok";
  } catch (e) {
    if (e instanceof CryptoError) return e.code;
    throw e;
  }
}

/** Opens a frame the way the carrier will: guard policy first, record after success. */
function carrierOpen(reader: SimDevice, frame: Uint8Array, at: FrameAt): string {
  return code(() => {
    const out = openFrame(
      sodium,
      reader.ring,
      frame,
      frameCtx(reader.ring.vaultId, at),
      reader.devices.guard.policy(at),
    );
    const entry = reader.ring.get(frameKeyId(frame));
    if (entry) reader.devices.guard.record(at, entry);
    return out;
  });
}

function revoke(revoker: SimDevice, ...targets: SimDevice[]): PreparedChange {
  const result = revoker.devices.prepareRevocation(
    targets.map((t) => ({ device: t.id, cut: revoker.cursors.get(t.id) ?? START_CURSOR })),
    { revoke: newEid(), rotate: newEid() },
  );
  if (!result.ok) throw new Error(result.reason);
  revoker.write(result.change.events);
  result.change.commit();
  return result.change;
}

function rotate(device: SimDevice): PreparedChange {
  const result = device.devices.prepareRotation(newEid());
  if (!result.ok) throw new Error(result.reason);
  device.write(result.change.events);
  result.change.commit();
  return result.change;
}

function syncAll(devices: readonly SimDevice[], rounds = 2): void {
  for (let i = 0; i < rounds; i++) for (const d of devices) d.sync();
}

async function threeDevices() {
  const vault = createSimVault();
  const a = vault.creator;
  const b = await pairDevice(a, "phone");
  const r = await pairDevice(a, "laptop");
  for (const d of [a, b, r]) d.sync();
  for (const d of [a, b, r]) d.sync();
  return { ...vault, a, b, r };
}

describe("revocation", () => {
  it("revoke then rotate: the revoked device cannot read new frames nor get its frames accepted", async () => {
    const { a, b, r } = await threeDevices();
    // R writes one legitimate batch before the revocation; everyone applied it.
    r.write([note()]);
    r.sync();
    a.pull();
    b.pull();
    const beforeAt = frameAt(r.id, 0);
    const before = sealFrame(sodium, r.ring, plain, frameCtx(r.ring.vaultId, beforeAt));

    const change = revoke(a, r);
    expect(change.key?.epoch).toBe(1);
    expect(change.recipients).not.toContain(r.id);
    a.push();
    b.pull();
    r.pull();

    for (const d of [a, b, r]) expect(d.devices.registry.revoked.has(r.id)).toBe(true);
    expect(b.ring.active.kid).toBe(change.key?.kid);
    expect(a.ring.active.kid).toBe(change.key?.kid);
    expect(r.ring.get(change.key?.kid ?? "")).toBeUndefined();
    expect(b.devices.rotationNeeded()).toBeUndefined();
    expect(a.devices.rotationNeeded()).toBeUndefined();

    // New data: readable by B, not by R.
    const at = frameAt(a.id, 5000);
    const fresh = sealFrame(sodium, a.ring, plain, frameCtx(a.ring.vaultId, at));
    expect(carrierOpen(b, fresh, at)).toBe("ok");
    expect(code(() => openFrame(sodium, r.ring, fresh, frameCtx(r.ring.vaultId, at)))).toBe(
      "unknown_key",
    );

    // R's own stream: history before its cut still opens; anything at or after the cut is rejected.
    const revocation = b.devices.registry.revoked.get(r.id);
    expect(revocation?.cut).toEqual({ seg: 1, offset: 100 });
    const cut = revocation?.cut ?? START_CURSOR;
    expect(carrierOpen(b, before, beforeAt)).toBe("ok");
    const afterAt = frameAt(r.id, cut.offset);
    const after = sealFrame(sodium, r.ring, plain, frameCtx(r.ring.vaultId, afterAt));
    expect(carrierOpen(b, after, afterAt)).toBe("key_not_allowed");
    expect(b.devices.guard.check(afterAt, r.ring.active)).toEqual({
      ok: false,
      reason: "revoked_writer",
    });

    // Under B's id: once B wrote at the new key, an old-key frame at a later position is rejected.
    const bAt = frameAt(b.id, 7000);
    const bFrame = sealFrame(sodium, b.ring, plain, frameCtx(b.ring.vaultId, bAt));
    expect(carrierOpen(a, bFrame, bAt)).toBe("ok");
    const forgedAt = frameAt(b.id, 7100);
    const forged = sealFrame(sodium, r.ring, plain, frameCtx(r.ring.vaultId, forgedAt));
    expect(carrierOpen(a, forged, forgedAt)).toBe("key_not_allowed");
    // The same frame re-opened at its earlier position (verify, then apply) still passes.
    expect(carrierOpen(a, bFrame, bAt)).toBe("ok");

    // Under a fresh id: the key predates the revocation, so it is refused.
    const strangerAt = frameAt(createDeviceIdentity(sodium).deviceId, 0);
    const stranger = sealFrame(sodium, r.ring, plain, frameCtx(r.ring.vaultId, strangerAt));
    expect(carrierOpen(a, stranger, strangerAt)).toBe("key_not_allowed");
  });

  it("statements a revoked device writes after its cut are ignored (no re-admission, no lease)", async () => {
    const { a, b, r } = await threeDevices();
    revoke(a, r);
    a.push();
    r.pull();
    // R certifies a sockpuppet, revokes B (which never revoked R) and claims the lease, all in its
    // own stream after the cut.
    const puppet = createDeviceIdentity(sodium);
    const subject = {
      deviceId: puppet.deviceId,
      signPublicKey: puppet.signPublicKey,
      boxPublicKey: puppet.box.publicKey,
    };
    const cert = certifyDevice(sodium, r.identity, subject, r.ring.vaultId);
    r.write([
      buildDeviceAdded(r.identity, r.ring.vaultId, newEid(), subject, "puppet", cert),
      buildDeviceRevoked(r.identity, r.ring.vaultId, newEid(), [
        { device: b.id, cut: START_CURSOR },
      ]),
      buildLeaseClaim(r.identity, r.ring.vaultId, newEid(), {
        at: r.now(),
        until: r.now() + 60 * 60 * 1000,
        watermark: {},
        prev: null,
      }),
    ]);
    r.push();
    for (const d of [a, b]) {
      d.pull();
      const reg = d.devices.registry;
      expect(reg.isTrusted(a.id)).toBe(true);
      expect(reg.isTrusted(b.id)).toBe(true);
      expect(reg.isTrusted(puppet.deviceId)).toBe(false);
      expect(reg.revocationCount).toBe(1);
      expect(reg.ignored.map((i) => i.reason)).toEqual(
        expect.arrayContaining(["after_revocation"]),
      );
      expect(
        foldLease(
          reg,
          r.stream.flatMap((s) => s.events),
        ).holder,
      ).toBeNull();
    }
  });

  it("a revoked device that revokes its revoker after its cut takes it down too (fail closed); the recovery words keep the honest device's history", async () => {
    const { a, b, r, recovery } = await threeDevices();
    a.write([note()]);
    a.push();
    for (const d of [b, r]) d.pull();
    revoke(a, r);
    a.push();
    r.pull();
    // R answers with a revocation of A at START, after its own cut: positions cannot tell who
    // revoked first, so both revocations count, on every device and in any order.
    r.write([
      buildDeviceRevoked(r.identity, r.ring.vaultId, newEid(), [
        { device: a.id, cut: START_CURSOR },
      ]),
    ]);
    r.push();
    b.pull();
    a.pull();
    for (const d of [a, b]) {
      const reg = d.devices.registry;
      expect(reg.revoked.has(r.id)).toBe(true);
      expect(reg.revoked.get(a.id)).toMatchObject({ cut: START_CURSOR, contested: true });
      // B was certified by A only: it loses trust with A's certificate subtree.
      expect([...reg.trusted.keys()]).toEqual([]);
    }
    // A's data is gone from B's view until the owner acts.
    expect(b.cursors.get(a.id)).toBeUndefined();
    // The owner, with the recovery words on B, revokes R and raises A's cut to the end of A's
    // stream B downloaded: recovery-signed cuts override the malicious one, A's history comes back
    // (A itself stays revoked: a revoked id is never trusted again; the owner re-pairs it) and B is
    // re-certified by the recovery identity.
    const aEnd = a.stream[a.stream.length - 1]?.cursor ?? START_CURSOR;
    const rCut = a.cursors.get(r.id) ?? START_CURSOR;
    const bSubject = {
      deviceId: b.id,
      signPublicKey: b.identity.signPublicKey,
      boxPublicKey: b.identity.box.publicKey,
    };
    const bCert = certifyDevice(sodium, recovery, bSubject, b.ring.vaultId);
    b.write([
      buildDeviceRevoked(recovery, b.ring.vaultId, newEid(), [
        { device: a.id, cut: aEnd },
        { device: r.id, cut: rCut },
      ]),
      buildDeviceAdded(recovery, b.ring.vaultId, newEid(), bSubject, "phone", bCert),
    ]);
    b.push();
    a.pull();
    for (const d of [a, b]) {
      expect(d.devices.registry.revoked.get(a.id)?.cut).toEqual(aEnd);
      expect(d.devices.registry.revoked.has(r.id)).toBe(true);
      expect([...d.devices.registry.trusted.keys()]).toEqual([b.id]);
    }
    expect(b.cursors.get(a.id)).toEqual(aEnd);
  });

  it("concurrent revoke and plain rotate: the revocation key wins on every device, in any order", async () => {
    for (const order of ["a-first", "b-first"] as const) {
      const { a, b, r } = await threeDevices();
      const revocation = revoke(a, r); // epoch 1, wrapped for B only
      const plainRotation = rotate(b); // epoch 0, B has not seen the revocation: wrapped for R too
      expect(plainRotation.recipients).toContain(r.id);
      if (order === "a-first") {
        a.push();
        b.pull();
        b.push();
        a.pull();
      } else {
        b.push();
        a.pull();
        a.push();
        b.pull();
      }
      r.pull();
      for (const d of [a, b]) {
        expect(d.ring.active.kid).toBe(revocation.key?.kid);
        expect(d.devices.rotationNeeded()).toBeUndefined();
      }
      expect(r.ring.get(revocation.key?.kid ?? "")).toBeUndefined();
      // R may hold B's epoch-0 key, but it is never active anywhere.
      expect(a.ring.active.epoch).toBe(1);
    }
  });

  it("two concurrent revocations: the S29 rule rotates again so no revoked device holds the active key", async () => {
    const vault = createSimVault();
    const a = vault.creator;
    const b = await pairDevice(a, "phone");
    const r1 = await pairDevice(a, "old laptop");
    const r2 = await pairDevice(a, "old tablet");
    for (let i = 0; i < 2; i++) for (const d of [a, b, r1, r2]) d.sync();

    const fromA = revoke(a, r1); // wraps for B and R2
    const fromB = revoke(b, r2); // wraps for A and R1
    expect(fromA.recipients).toContain(r2.id);
    expect(fromB.recipients).toContain(r1.id);
    a.push();
    b.push();
    a.pull();
    b.pull();
    for (const d of [a, b]) {
      expect(d.devices.registry.revocationCount).toBe(2);
      expect(d.ring.active.epoch).toBe(1);
      expect(d.devices.rotationNeeded()).toBe("revocation_pending");
    }
    const again = rotate(a);
    expect(again.key?.epoch).toBe(2);
    expect(again.recipients).toEqual(expect.not.arrayContaining([r1.id, r2.id]));
    a.push();
    b.pull();
    r1.pull();
    r2.pull();
    expect(b.ring.active.kid).toBe(again.key?.kid);
    expect(b.devices.rotationNeeded()).toBeUndefined();
    expect(a.devices.rotationNeeded()).toBeUndefined();
    for (const r of [r1, r2]) expect(r.ring.get(again.key?.kid ?? "")).toBeUndefined();
  });

  it("a revoked device's own rotation (even claiming epoch + 1) is never accepted", async () => {
    const { a, b, r } = await threeDevices();
    // R rotates claiming the revoker's epoch before the revocation lands.
    const clone = r.ring.clone(sodium);
    const entry = rotateKeyring(sodium, clone, { epoch: 1 });
    const bDevice = r.devices.registry.trusted.get(b.id);
    if (!bDevice) throw new Error("B not trusted on R");
    const wire = wrapKeys(sodium, clone, r.identity, bDevice, [entry.kid], [b.id]);
    r.write([buildKeysRotated(newEid(), new Map([[b.id, wire]]))]);
    r.push();
    b.pull();
    expect(b.ring.get(entry.kid)).toBeUndefined(); // epoch 1 > 0 counted revocations
    revoke(a, r);
    a.push();
    b.pull();
    expect(b.ring.get(entry.kid)).toBeUndefined(); // R is now untrusted
    expect(b.ring.active.epoch).toBe(1);
    expect(b.ring.active.kid).toBe(a.ring.active.kid);
  });

  it("a refused revocation wrap (generation filled by a still-trusted device) makes devices rotate again", async () => {
    const { a, b, r } = await threeDevices();
    // R, still trusted, fills generation n + 1 with 8 keys and wraps them all for B.
    const n = r.ring.maxGeneration;
    const flood: Keyring = r.ring.clone(sodium);
    for (let i = 0; i < 8; i++) {
      const c = r.ring.clone(sodium);
      rotateKeyring(sodium, c);
      flood.merge(c);
    }
    expect(flood.entries().filter((e) => e.generation === n + 1)).toHaveLength(8);
    const bDevice = r.devices.registry.trusted.get(b.id);
    if (!bDevice) throw new Error("B not trusted on R");
    r.write([
      buildKeysRotated(
        newEid(),
        new Map([[b.id, wrapKeys(sodium, flood, r.identity, bDevice, undefined, [b.id])]]),
      ),
    ]);
    r.push();
    b.pull();
    expect(b.ring.entries().filter((e) => e.generation === n + 1)).toHaveLength(8);

    const revocation = revoke(a, r); // generation n + 1 on A
    a.push();
    b.pull();
    expect(b.ring.get(revocation.key?.kid ?? "")).toBeUndefined(); // refused: 9th key in n + 1
    expect(b.devices.rotationNeeded()).toBe("revocation_pending");
    const again = rotate(b);
    expect(again.key).toMatchObject({ epoch: 1, generation: n + 2 });
    b.push();
    a.pull();
    expect(a.ring.active.kid).toBe(again.key?.kid);
    expect(b.ring.active.kid).toBe(again.key?.kid);
    r.pull();
    expect(r.ring.get(again.key?.kid ?? "")).toBeUndefined();
  });

  it("rate-limits rotations per sender and accepts them again after the window", async () => {
    const { a, b } = await threeDevices();
    for (let i = 0; i < 7; i++) rotate(b);
    b.push();
    a.pull();
    const report = a.devices.ingest([]);
    expect(report.pending).toHaveLength(1);
    expect(report.pending[0]?.outcome).toMatchObject({ status: "retry", refusal: "rate_limited" });
    expect(a.ring.active.kid).not.toBe(b.ring.active.kid);
    a.remote.time += 25 * 60 * 60 * 1000;
    expect(a.devices.ingest([]).pending).toHaveLength(0);
    expect(a.ring.active.kid).toBe(b.ring.active.kid);
  });

  it("a cut below what a device already applied rejects that data (guard recheck) and asks for a rebuild", async () => {
    const { a, b, r } = await threeDevices();
    r.write([note()]); // a batch only B pulls before the revocation
    r.push();
    b.pull();
    const before = new Map(b.cursors);
    expect(before.get(r.id)).toBeDefined();
    revoke(a, r); // A's cut is before that batch
    a.push();
    b.pull();
    const cut = b.devices.registry.revoked.get(r.id)?.cut;
    expect(devicesNeedingRebuild(b.devices.registry, before)).toEqual([r.id]);
    expect(b.rejections).toContainEqual({ device: r.id, after: cut, reason: "revoked_writer" });
    expect(b.cursors.get(r.id)).toEqual(a.cursors.get(r.id));
    expect(devicesNeedingRebuild(b.devices.registry, b.cursors)).toEqual([]);
    expect(devicesNeedingRebuild(a.devices.registry, a.cursors)).toEqual([]);
  });

  it("revoking itself writes the revocation only; the others rotate", async () => {
    const { a, b, r } = await threeDevices();
    const result = r.devices.prepareRevocation(
      [{ device: r.id, cut: { seg: 1, offset: 1_000_000 } }],
      {
        revoke: newEid(),
        rotate: newEid(),
      },
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.change.key).toBeUndefined();
    r.write(result.change.events);
    r.push();
    a.pull();
    b.pull();
    expect(a.devices.rotationNeeded()).toBe("revocation_pending");
    rotate(a);
    a.push();
    b.pull();
    expect(b.devices.rotationNeeded()).toBeUndefined();
    expect(b.ring.active.kid).toBe(a.ring.active.kid);
  });

  it("an untrusted device cannot prepare a rotation, and the recovery recipient always gets a wrap", async () => {
    const { a, b, r } = await threeDevices();
    revoke(a, r);
    a.push();
    r.pull();
    expect(prepareRotation(r.devices.keyContext(), newEid())).toEqual({
      ok: false,
      reason: "not_trusted",
    });
    const change = rotate(b);
    expect(change.recipients).toContain("0".repeat(32));
    expect(recoveryRecipient(b.ring).vaultId).toBe(b.ring.vaultId);
  });
});

describe("R1: mutual revocations are contested", () => {
  it("a retaliation that states a cut past the revocation of its signer never shows as uncontested", async () => {
    const { a, b, r } = await threeDevices();
    a.write([note()]);
    syncAll([a, b, r]);
    revoke(a, r); // A revokes R
    a.push();
    r.pull();
    // R (revoked, malicious) answers with a revocation of A whose cut covers A's revocation of R:
    // positions alone exempt it (review A1b), so both count; the UI must still see a dispute.
    r.write([
      buildDeviceRevoked(r.identity, r.ring.vaultId, newEid(), [
        { device: a.id, cut: r.cursors.get(a.id) ?? START_CURSOR },
      ]),
    ]);
    syncAll([a, b, r]);
    for (const d of [a, b]) {
      const reg = d.devices.registry;
      expect(reg.revoked.get(a.id)?.contested, d.name).toBe(true);
      expect(reg.revoked.get(r.id)?.contested, d.name).toBe(true);
    }
  });

  it("a one-sided revocation is not contested", async () => {
    const { a, b, r } = await threeDevices();
    revoke(a, r);
    syncAll([a, b]);
    expect(b.devices.registry.revoked.get(r.id)?.contested).toBe(false);
  });

  it("a recovery-signed revocation is never contested, even when its target revoked someone", async () => {
    const { a, b, r, recovery } = await threeDevices();
    // R revokes B (one-sided, contested by nobody), then the owner revokes R with the words.
    r.write([
      buildDeviceRevoked(r.identity, r.ring.vaultId, newEid(), [
        { device: b.id, cut: r.cursors.get(b.id) ?? START_CURSOR },
      ]),
    ]);
    syncAll([a, b, r]);
    a.write([
      buildDeviceRevoked(recovery, a.ring.vaultId, newEid(), [
        { device: r.id, cut: a.cursors.get(r.id) ?? START_CURSOR },
      ]),
    ]);
    syncAll([a, b, r]);
    const reg = a.devices.registry;
    expect(reg.revoked.get(r.id)?.contested).toBe(false);
    expect(reg.revoked.has(b.id)).toBe(true);
  });
});

describe("key wraps under attack (review m2, M4)", () => {
  it("A5: a junk copy of a rotation event delivered first never hides the genuine wraps", async () => {
    const { a, b } = await threeDevices();
    const change = rotate(b);
    const genuine = b.stream[b.stream.length - 1]?.events[0];
    if (!genuine) throw new Error("no rotation event");
    const wraps = genuine.data.wraps as Record<string, string>;
    const wire = wraps[a.id] ?? "";
    const junkWire = `${wire.slice(0, -8)}${wire.slice(-8) === "00000000" ? "11111111" : "00000000"}`;
    const junk = {
      ...genuine,
      writer: createDeviceIdentity(sodium).deviceId,
      data: { wraps: { ...wraps, [a.id]: junkWire } },
    };
    const first = a.devices.ingest([junk]);
    expect(first.wraps.map((w) => w.outcome.status)).toEqual(["refused"]);
    b.push();
    a.pull();
    expect(a.ring.get(change.key?.kid ?? "")).toBeDefined();
  });

  it("pending wraps are bounded per claimed sender and dropped when the sender is revoked", async () => {
    const { a } = await threeDevices();
    const ghost = createDeviceIdentity(sodium).deviceId;
    const wire = (i: number) => {
      const bytes = new Uint8Array(1 + 16 + 64 + 2 + 16 + 48);
      bytes[0] = 3;
      bytes.set(Buffer.from(ghost, "hex"), 1);
      bytes[1 + 16 + 64 + 1] = 1;
      bytes.set(Buffer.from(a.id, "hex"), 1 + 16 + 64 + 2);
      bytes[bytes.length - 1] = i;
      return bytes;
    };
    const events = Array.from({ length: 40 }, (_, i) => ({
      eid: newEid(),
      hlc: hlcAt(ghost, a.now(), i),
      writer: ghost,
      position: { seg: 1, offset: 100 * (i + 1) },
      type: "device.keysRotated",
      v: 1,
      data: { wraps: { [a.id]: Buffer.from(wire(i)).toString("hex") } },
    }));
    const report = a.devices.ingest(events);
    expect(report.pending).toHaveLength(MAX_PENDING_WRAPS_PER_SENDER);
    expect(report.pending.every((p) => p.outcome.status === "retry")).toBe(true);
  });
});
