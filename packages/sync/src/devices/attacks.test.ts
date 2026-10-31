// The S29 security review's attacks (S29-review.md B1 / M1), kept as permanent tests, and the
// delivery-order property: devices that hold the same events agree on the registry and on the
// accepted data, whatever order the events arrived in.

import { describe, expect, it } from "vitest";
import { parseHlc } from "../hlc.js";
import { buildDeviceRevoked, buildLeaseClaim, type LogEvent } from "./events.js";
import { deliveryOrderRun, note, summary, syncAll } from "./orderSim.js";
import {
  type Batch,
  createSimVault,
  hlcAt,
  newEid,
  pairDevice,
  revokedWithConsent,
  revokeWithConsent,
  type SimDevice,
  START_CURSOR,
} from "./testkit.js";

/** The honest revoke flow (the targets consent, H2). */
function honestRevoke(revoker: SimDevice, ...targets: SimDevice[]): LogEvent {
  return revokeWithConsent(revoker, targets).events[0] as LogEvent;
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

describe("review attacks", () => {
  // One test per delivery order (each pairs a joiner and rebuilds: two in one test ran too long under load).
  for (const order of ["revoker-first", "attacker-first"] as const) {
    it(`A1 (${order}): a revoked device backdates a revocation of its revoker; it never counts (no consent, H2), in any order`, async () => {
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
      // ... and every device converges: R stays revoked; B never consented, so it stays trusted.
      const reference = summary(a.devices.registry);
      expect(reference.revoked.map((x) => x[0])).toEqual([r.id]);
      expect(reference.trusted).toEqual([a.id, b.id, c.id].sort());
      for (const d of [b, r, c]) expect(summary(d.devices.registry)).toEqual(reference);
      expect(a.devices.registry.revoked.get(r.id)?.contested).toBe(false);
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
      expect(after.revoked.map((x) => x[0])).toEqual([r.id]);
      for (const d of [c, j]) expect(d.acceptedData()).toEqual(a.acceptedData());
      // The next rotation wraps for neither of them.
      const rotation = a.devices.prepareRotation(newEid());
      if (!rotation.ok) throw new Error(rotation.reason);
      expect(rotation.change.recipients).not.toContain(r.id);
      expect(rotation.change.recipients).toContain(b.id);
      rotation.change.discard();
    });
  }

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
      // The rewritten revocation of B carries no consent of B (H2): it never counts; R is never
      // trusted again and B stays trusted, on joiners and rebuilds alike.
      expect(reg.revoked.has(r.id)).toBe(true);
      expect(reg.isTrusted(r.id)).toBe(false);
      expect(reg.isTrusted(b.id)).toBe(true);
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
    // R (still trusted) once attested B's stream in a lease claim, then revokes B at START; B
    // consented (H2: the owner confirmed on B, with a cut that loses history).
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
      revokedWithConsent(r.identity, r.ring.vaultId, [{ device: b.id, cut: START_CURSOR }], [b]),
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

  // The sweep over ten seeds is attacks.order.exhaustive.test.ts; one seed here.
  it("property: any delivery order gives every device the same registry and accepted data (seed 1)", async () => {
    await deliveryOrderRun(1);
  });
});
