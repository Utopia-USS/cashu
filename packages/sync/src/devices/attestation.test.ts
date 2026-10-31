// S29c phase A re-check P2 (S29-review.md): a key certified by a device AFTER its cut never backs a
// revocation-time decision. The attack: R, revoked by B, certifies a second key for B's id after its
// cut; one rewritten frame of B's stream carries a "B" lease claim signed with that key that attests
// R's stream far beyond the cut. If the attestation counted, R's cut would be raised past R's own
// revocation of C, which would then count. The control: the same certificate written BEFORE R's cut
// is legitimate and does raise the cut.

import { describe, expect, it } from "vitest";
import type { SegmentCursor, UnstampedEvent } from "../carrier.js";
import { certifyDevice, createDeviceIdentity } from "../crypto/index.js";
import { buildDeviceAdded, buildDeviceRevoked, buildLeaseClaim, type LogEvent } from "./events.js";
import { foldRegistry, type Registry } from "./registry.js";
import { createSimVault, hlcAt, newEid, pairDevice, START_TIME, sodium } from "./testkit.js";

function stamp(e: UnstampedEvent, writer: string, offset: number, wall = START_TIME): LogEvent {
  return {
    eid: e.i,
    hlc: hlcAt(writer, wall),
    writer,
    position: { seg: 1, offset },
    type: e.t,
    v: e.v,
    data: e.d,
  };
}

const CUT: SegmentCursor = { seg: 1, offset: 1_000 };
const FAR: SegmentCursor = { seg: 1, offset: 5_000_000 };

/** The P2 scenario; `certificateAt` places R's certificate of a second key for B in R's stream. */
async function scenario(
  certificateAt: number | null,
  forgedRevocation = false,
  revokesCreator = false,
): Promise<{ registry: Registry; ids: Record<string, string> }> {
  const { creator: a } = createSimVault();
  const b = await pairDevice(a, "phone");
  const r = await pairDevice(a, "laptop");
  const c = await pairDevice(a, "tablet");
  for (let i = 0; i < 2; i++) for (const d of [a, b, r, c]) d.sync();
  const vaultId = a.ring.vaultId;
  // B revokes R with a cut at 1:1000 of R's stream (late in B's stream).
  const bRevokesR = stamp(
    buildDeviceRevoked(b.identity, vaultId, newEid(), [{ device: r.id, cut: CUT }]),
    b.id,
    100_000,
  );
  // R certifies a second key pair for B's id (own lane, R's own stream).
  const fakeB = createDeviceIdentity(sodium, b.id);
  const fakeSubject = {
    deviceId: b.id,
    signPublicKey: fakeB.signPublicKey,
    boxPublicKey: fakeB.box.publicKey,
  };
  const secondKey = stamp(
    buildDeviceAdded(
      r.identity,
      vaultId,
      newEid(),
      fakeSubject,
      "phone",
      certifyDevice(sodium, r.identity, fakeSubject, vaultId),
    ),
    r.id,
    certificateAt ?? 0,
  );
  // A rewritten frame early in B's stream: a "B" lease claim signed with that key, attesting R's
  // stream up to FAR (before B's revocation, so it counts as what B had applied).
  const forgedClaim = stamp(
    buildLeaseClaim(fakeB, vaultId, newEid(), {
      at: START_TIME,
      until: START_TIME + 60 * 60 * 1000,
      watermark: { [r.id]: FAR },
      prev: null,
    }),
    b.id,
    50_000,
  );
  // R, after its cut, revokes C (who never revoked R).
  const rRevokesC = stamp(
    buildDeviceRevoked(r.identity, vaultId, newEid(), [
      { device: c.id, cut: { seg: 1, offset: 0 } },
    ]),
    r.id,
    2_000,
  );
  // Variant: the rewritten frame carries a "B" revocation of C signed with the minted key instead.
  const forgedBRevocation = stamp(
    buildDeviceRevoked(fakeB, vaultId, newEid(), [{ device: c.id, cut: { seg: 1, offset: 0 } }]),
    b.id,
    60_000,
  );
  // Variant: R also states a cut at START for the creator, whose certificates certify everyone.
  const rRevokesA = stamp(
    buildDeviceRevoked(r.identity, vaultId, newEid(), [
      { device: a.id, cut: { seg: 1, offset: 0 } },
    ]),
    r.id,
    2_100,
  );
  const events = [
    ...(forgedRevocation ? [forgedBRevocation] : []),
    ...(revokesCreator ? [rRevokesA] : []),
    ...[a, b, r, c].flatMap((d) => d.stream.flatMap((s) => s.events)),
    bRevokesR,
    ...(certificateAt === null ? [] : [secondKey]),
    forgedClaim,
    rRevokesC,
  ];
  const registry = foldRegistry(sodium, { vaultId, recovery: a.ring.recovery }, events);
  return { registry, ids: { a: a.id, b: b.id, r: r.id, c: c.id } };
}

describe("P2: keys certified after a cut never back a revocation decision", () => {
  it("a second key R certifies for its revoker after its cut cannot raise R's cut; R's post-cut revocation of C does not count", async () => {
    const { registry, ids } = await scenario(1_500); // after the cut at 1:1000
    expect(registry.revoked.get(ids.r as string)?.cut).toEqual(CUT);
    expect(registry.revoked.has(ids.c as string)).toBe(false);
    expect(registry.isTrusted(ids.c as string)).toBe(true);
    expect(registry.isTrusted(ids.b as string)).toBe(true);
  });

  it("a revocation signed in its revoker's name with a key R minted after its cut never counts", async () => {
    const { registry, ids } = await scenario(1_500, true);
    expect(registry.revoked.has(ids.c as string)).toBe(false);
    expect(registry.isTrusted(ids.c as string)).toBe(true);
  });

  it("with a post-cut revocation of the creator too, the minted key changes nothing", async () => {
    // R revoking the creator after its own cut makes the fixpoint undecided (fail closed); whatever
    // that decides, it must be the same with and without the key R minted after its cut.
    const roles = async (certificateAt: number | null) => {
      const { registry, ids } = await scenario(certificateAt, false, true);
      const role = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
      return {
        revoked: [...registry.revoked.keys()].map((d) => role.get(d)).sort(),
        trusted: [...registry.trusted.keys()].map((d) => role.get(d)).sort(),
        rCut: registry.revoked.get(ids.r as string)?.cut,
      };
    };
    const withKey = await roles(1_500);
    expect(withKey).toEqual(await roles(null));
    expect(withKey.rCut).toEqual(CUT);
  });

  it("control: the same certificate written before R's cut is legitimate and does raise the cut", async () => {
    const { registry, ids } = await scenario(500); // before the cut
    expect(registry.revoked.get(ids.r as string)?.cut).toEqual(FAR);
    expect(registry.revoked.has(ids.c as string)).toBe(true);
  });
});
