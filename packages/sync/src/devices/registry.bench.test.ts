// Registry fold cost with many devices (review M4, A7 / A8). Synthetic identities only. The numbers
// are printed for the checkpoint; the assertions are loose bounds that catch a return to quadratic
// folds (A8 measured 21 s for 150 puppets before S29b).

import { describe, expect, it } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import {
  CertificateCache,
  certifyDevice,
  createDeviceIdentity,
  type DeviceIdentity,
} from "../crypto/index.js";
import { buildDeviceAdded, buildDeviceRevoked, type LogEvent } from "./events.js";
import { foldRegistry } from "./registry.js";
import { memoizedVerifier } from "./statements.js";
import { createSimVault, hlcAt, newEid, START_TIME, sodium } from "./testkit.js";

function subjectOf(d: DeviceIdentity) {
  return { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.box.publicKey };
}

class Stream {
  #offset = 0;
  readonly events: LogEvent[] = [];
  constructor(readonly writer: string) {}
  add(e: UnstampedEvent): void {
    this.#offset += 100;
    this.events.push({
      eid: e.i,
      hlc: hlcAt(this.writer, START_TIME + this.#offset),
      writer: this.writer,
      position: { seg: 1, offset: this.#offset },
      type: e.t,
      v: e.v,
      data: e.d,
    });
  }
}

function timed<T>(f: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = f();
  return { value, ms: Math.round(performance.now() - start) };
}

describe("registry fold cost (M4)", () => {
  for (const n of [150, 1000]) {
    it(`A8: one trusted device certifies ${n} puppets and revokes them one by one`, () => {
      const { creator: a } = createSimVault();
      const vaultId = a.ring.vaultId;
      const stream = new Stream(a.id);
      const puppets = Array.from({ length: n }, () => createDeviceIdentity(sodium));
      for (const p of puppets) {
        const cert = certifyDevice(sodium, a.identity, subjectOf(p), vaultId);
        stream.add(buildDeviceAdded(a.identity, vaultId, newEid(), subjectOf(p), "puppet", cert));
      }
      for (const p of puppets) {
        stream.add(
          buildDeviceRevoked(a.identity, vaultId, newEid(), [
            { device: p.deviceId, cut: { seg: 1, offset: 0 } },
          ]),
        );
      }
      const events = [...a.stream.flatMap((s) => s.events), ...stream.events];
      const root = { vaultId, recovery: a.ring.recovery };
      const options = { verify: memoizedVerifier(), certificateCache: new CertificateCache() };
      const cold = timed(() => foldRegistry(sodium, root, events, options));
      const warm = timed(() => foldRegistry(sodium, root, events, options));
      console.log(`A8 n=${n}: cold fold ${cold.ms} ms, warm re-fold ${warm.ms} ms`);
      expect(cold.value.revocationCount).toBe(64); // per-signer cap
      expect(warm.value.revocationCount).toBe(64);
      expect(warm.ms).toBeLessThan(2000);
    }, 120_000);
  }

  it("1000 trusted devices (a two-level tree) with 160 revocations", () => {
    const { creator: a } = createSimVault();
    const vaultId = a.ring.vaultId;
    const top = new Stream(a.id);
    const issuers = Array.from({ length: 16 }, () => createDeviceIdentity(sodium));
    for (const i of issuers) {
      const cert = certifyDevice(sodium, a.identity, subjectOf(i), vaultId);
      top.add(buildDeviceAdded(a.identity, vaultId, newEid(), subjectOf(i), "issuer", cert));
    }
    const streams = [top];
    const leaves: DeviceIdentity[] = [];
    for (const i of issuers) {
      const s = new Stream(i.deviceId);
      const children = Array.from({ length: 62 }, () => createDeviceIdentity(sodium));
      for (const c of children) {
        const cert = certifyDevice(sodium, i, subjectOf(c), vaultId);
        s.add(buildDeviceAdded(i, vaultId, newEid(), subjectOf(c), "leaf", cert));
      }
      for (const c of children.slice(0, 10)) {
        s.add(
          buildDeviceRevoked(i, vaultId, newEid(), [
            { device: c.deviceId, cut: { seg: 1, offset: 0 } },
          ]),
        );
      }
      leaves.push(...children);
      streams.push(s);
    }
    const events = [...a.stream.flatMap((s) => s.events), ...streams.flatMap((s) => s.events)];
    const root = { vaultId, recovery: a.ring.recovery };
    const options = { verify: memoizedVerifier(), certificateCache: new CertificateCache() };
    const cold = timed(() => foldRegistry(sodium, root, events, options));
    const warm = timed(() => foldRegistry(sodium, root, events, options));
    console.log(
      `tree: ${cold.value.trusted.size} trusted, ${cold.value.revocationCount} revocations: cold ${cold.ms} ms, warm ${warm.ms} ms`,
    );
    expect(cold.value.trusted.size).toBe(1 + 16 + 16 * 52);
    expect(cold.value.revocationCount).toBe(160);
    expect(warm.ms).toBeLessThan(3000);
  }, 180_000);
});
