// The decision-key property (decisionKeys.ts), shared by decisionKeys.test.ts (one seed) and the sweep
// (decisionKeys.property.exhaustive.test.ts). Test support only (synthetic data).
//
// A seeded random vault: devices certified by random earlier devices (a certification graph rooted at
// the creator), lease claims attesting other streams, and random revocations (device- and
// recovery-signed, random cuts). Folded once: the BASE decision. Then every device the base revokes
// mints: second keys for random device ids and puppets, certified by itself or below its puppets
// (chains of length 1 to 3, before or after its cut), and with those keys forged "victim" lease claims
// attesting the minter's stream far past its cut and forged revocations. Invariant: material whose
// certification chain passes through a revoked device never changes a decision in the attacker's
// favour: no revoked device's cut is raised, no base revocation is dropped, no device gains trust.
// (It may only revoke more: the fixpoint fails closed.)

import { expect } from "vitest";
import type { SegmentCursor, UnstampedEvent } from "../carrier.js";
import {
  CertificateCache,
  certifyDevice,
  createDeviceIdentity,
  type DeviceIdentity,
  type RecoveryIdentity,
} from "../crypto/index.js";
import { buildDeviceAdded, buildDeviceRevoked, buildLeaseClaim, type LogEvent } from "./events.js";
import { comparePositions } from "./positions.js";
import { foldRegistry, type Registry } from "./registry.js";
import { memoizedVerifier } from "./statements.js";
import { createSimVault, hlcAt, mulberry32, newEid, START_TIME, sodium } from "./testkit.js";

class Streams {
  readonly events: LogEvent[] = [];
  readonly #next = new Map<string, number>();

  /** Appends to `writer`'s stream (positions grow by 100 per event). */
  add(writer: string, e: UnstampedEvent): SegmentCursor {
    const offset = (this.#next.get(writer) ?? 0) + 100;
    this.#next.set(writer, offset);
    return this.at(writer, offset, e);
  }

  /** Places an event at an explicit position (a rewrite of an old frame, or a far future one). */
  at(writer: string, offset: number, e: UnstampedEvent): SegmentCursor {
    const position = { seg: 1, offset };
    this.#next.set(writer, Math.max(this.#next.get(writer) ?? 0, offset));
    this.events.push({
      eid: e.i,
      hlc: hlcAt(writer, START_TIME),
      writer,
      position,
      type: e.t,
      v: e.v,
      data: e.d,
    });
    return position;
  }

  end(writer: string): number {
    return this.#next.get(writer) ?? 0;
  }
}

function subjectOf(d: DeviceIdentity) {
  return { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.box.publicKey };
}

function added(vaultId: string, issuer: DeviceIdentity, subject: DeviceIdentity): UnstampedEvent {
  const s = subjectOf(subject);
  return buildDeviceAdded(
    issuer,
    vaultId,
    newEid(),
    s,
    "device",
    certifyDevice(sodium, issuer, s, vaultId),
  );
}

function claim(vaultId: string, signer: DeviceIdentity, watermark: Record<string, SegmentCursor>) {
  return buildLeaseClaim(signer, vaultId, newEid(), {
    at: START_TIME,
    until: START_TIME + 60 * 60 * 1000,
    watermark,
    prev: null,
  });
}

function revoke(
  vaultId: string,
  signer: DeviceIdentity | RecoveryIdentity,
  device: string,
  cut: SegmentCursor,
) {
  return buildDeviceRevoked(signer, vaultId, newEid(), [{ device, cut }]);
}

export async function decisionKeysRun(seed: number): Promise<{ minters: number }> {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const vault = createSimVault();
  const a = vault.creator;
  const vaultId = vault.vaultId;
  const s = new Streams();
  for (const e of a.stream.flatMap((b) => b.events))
    s.at(a.id, e.position.offset, { t: e.type, v: e.v, i: e.eid, d: e.data });
  // --- Certification graph: 6 devices, each certified by a random earlier one.
  const devices: DeviceIdentity[] = [a.identity];
  for (let i = 0; i < 6; i++) {
    const d = createDeviceIdentity(sodium);
    const issuer = pick(devices);
    s.add(issuer.deviceId, added(vaultId, issuer, d));
    devices.push(d);
  }
  const others = devices.slice(1);
  // --- Honest activity: notes advance streams; claims attest what a device saw of others.
  for (let i = 0; i < 8; i++) {
    const d = pick(devices);
    if (rand() < 0.5) {
      s.add(d.deviceId, { t: "note.added", v: 1, i: newEid(), d: {} });
    } else {
      const other = pick(devices);
      if (other !== d) {
        s.add(
          d.deviceId,
          claim(vaultId, d, { [other.deviceId]: { seg: 1, offset: s.end(other.deviceId) } }),
        );
      }
    }
  }
  // --- Revocations: 1-3, device-signed with a random cut, sometimes by the recovery words.
  const revocations = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < revocations; i++) {
    const target = pick(others);
    const cut = { seg: 1, offset: Math.floor(rand() * (s.end(target.deviceId) / 100 + 1)) * 100 };
    if (rand() < 0.25) s.add(a.id, revoke(vaultId, vault.recovery, target.deviceId, cut));
    else {
      const signer = pick(devices.filter((d) => d !== target));
      s.add(signer.deviceId, revoke(vaultId, signer, target.deviceId, cut));
    }
  }
  const root = { vaultId, recovery: a.ring.recovery };
  const options = () => ({ verify: memoizedVerifier(), certificateCache: new CertificateCache() });
  const base = foldRegistry(sodium, root, s.events, options());

  // --- Every revoked device mints keys and forges with them.
  const minted = new Streams();
  const minters = devices.filter((d) => base.revoked.has(d.deviceId));
  for (const m of minters) {
    const cut = base.revoked.get(m.deviceId)?.cut as SegmentCursor;
    // Its signing chain: itself, or puppets below it (length 1 to 3), certified before or after its cut.
    let signer = m;
    const depth = Math.floor(rand() * 3);
    for (let i = 0; i < depth; i++) {
      const puppet = createDeviceIdentity(sodium);
      const offset = signer === m && rand() < 0.5 ? Math.max(1, cut.offset - 1) : 900_000 + i;
      minted.at(signer.deviceId, offset, added(vaultId, signer, puppet));
      signer = puppet;
    }
    // A second key for a "victim": mostly one of its revokers (whose attestation raises its cut),
    // else a random device; in the signer's stream.
    const revokers = devices.filter(
      (d) => d !== m && base.revoked.get(m.deviceId)?.signers.includes(d.deviceId),
    );
    const victim =
      revokers.length > 0 && rand() < 0.8 ? pick(revokers) : pick(devices.filter((d) => d !== m));
    const fake = createDeviceIdentity(sodium, victim.deviceId);
    minted.at(
      signer.deviceId,
      rand() < 0.5 ? Math.max(1, cut.offset - 1) : 950_000,
      added(vaultId, signer, fake),
    );
    // A forged victim claim early in its stream attesting the minter far past its cut, a forged
    // victim revocation of a random device, and the minter's own post-cut revocation.
    minted.at(
      victim.deviceId,
      1,
      claim(vaultId, fake, { [m.deviceId]: { seg: 1, offset: 5_000_000 } }),
    );
    minted.at(
      victim.deviceId,
      2,
      revoke(vaultId, fake, pick(others).deviceId, { seg: 1, offset: 0 }),
    );
    minted.at(
      m.deviceId,
      cut.offset + 50,
      revoke(vaultId, m, pick(others).deviceId, { seg: 1, offset: 0 }),
    );
  }
  const attacked = foldRegistry(sodium, root, [...s.events, ...minted.events], options());
  expectNoGain(base, attacked, seed);
  return { minters: minters.length };
}

function expectNoGain(base: Registry, attacked: Registry, seed: number): void {
  for (const [device, r] of base.revoked) {
    const after = attacked.revoked.get(device);
    expect(after, `seed ${seed}: ${device} stays revoked`).toBeDefined();
    if (after) {
      expect(
        comparePositions(after.cut, r.cut),
        `seed ${seed}: cut of ${device} not raised`,
      ).toBeLessThanOrEqual(0);
    }
  }
  for (const device of attacked.trusted.keys()) {
    expect(base.trusted.has(device), `seed ${seed}: ${device} gains no trust`).toBe(true);
  }
}
