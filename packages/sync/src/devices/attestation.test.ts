// S29c review P2 and its variants V1 / V2 (S29-review.md "phase A re-check" 1 and 2): a key whose
// certification chain passes through a revoked device never backs a revocation decision
// (decisionKeys.ts). The attack: B revokes R (cut 1:1000). A key K' for B's id is certified somewhere
// in R's reach; one rewritten frame of B's stream carries a "B" lease claim signed with K' that
// attests R's stream far beyond the cut. If it counted, R's cut would be raised past R's own
// revocation of C, which would then count. Ways to certify K':
// - P2: R itself, after its cut;
// - V1: R itself, at a position before its cut (a rewrite of R's old frame, or genuine);
// - V2: a puppet R certified while trusted, in the puppet's own stream;
// - a chain of length 3 below R (R -> P1 -> P2 -> K').
// Controls: honest attestations (B's real key; a device three certifications below the creator)
// still raise cuts.

import { describe, expect, it } from "vitest";
import type { SegmentCursor, UnstampedEvent } from "../carrier.js";
import { certifyDevice, createDeviceIdentity, type DeviceIdentity } from "../crypto/index.js";
import { buildDeviceAdded, buildDeviceRevoked, buildLeaseClaim, type LogEvent } from "./events.js";
import { foldRegistry, type Registry } from "./registry.js";
import {
  createSimVault,
  hlcAt,
  newEid,
  pairDevice,
  type SimDevice,
  START_TIME,
  sodium,
} from "./testkit.js";

function stamp(e: UnstampedEvent, writer: string, offset: number): LogEvent {
  return {
    eid: e.i,
    hlc: hlcAt(writer, START_TIME),
    writer,
    position: { seg: 1, offset },
    type: e.t,
    v: e.v,
    data: e.d,
  };
}

function subjectOf(d: DeviceIdentity) {
  return { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.box.publicKey };
}

/** `issuer` certifies `subject` in its own stream at `offset`. */
function certify(
  vaultId: string,
  issuer: DeviceIdentity,
  subject: DeviceIdentity,
  offset: number,
): LogEvent {
  const s = subjectOf(subject);
  const cert = certifyDevice(sodium, issuer, s, vaultId);
  return stamp(
    buildDeviceAdded(issuer, vaultId, newEid(), s, "tablet 2", cert),
    issuer.deviceId,
    offset,
  );
}

const CUT: SegmentCursor = { seg: 1, offset: 1_000 };
const FAR: SegmentCursor = { seg: 1, offset: 5_000_000 };

type Mint = "p2" | "v1" | "v2" | "chain3" | "none";

interface Scenario {
  readonly registry: Registry;
  readonly a: SimDevice;
  readonly b: SimDevice;
  readonly r: SimDevice;
  readonly c: SimDevice;
}

/**
 * B revokes R at CUT; K' for B's id is minted as `mint` says; a forged "B" claim signed with K'
 * attests R up to FAR; R revokes C after its cut. Options add R's post-cut revocation of the creator
 * or, as the honest control, B's real attestation of FAR.
 */
async function scenario(
  mint: Mint,
  options: { revokesCreator?: boolean; forgedRevocation?: boolean; honestClaim?: boolean } = {},
): Promise<Scenario> {
  const { creator: a } = createSimVault();
  const b = await pairDevice(a, "phone");
  const r = await pairDevice(a, "laptop");
  const c = await pairDevice(a, "tablet");
  for (let i = 0; i < 2; i++) for (const d of [a, b, r, c]) d.sync();
  const vaultId = a.ring.vaultId;
  const events: LogEvent[] = [...[a, b, r, c].flatMap((d) => d.stream.flatMap((s) => s.events))];
  events.push(
    stamp(
      buildDeviceRevoked(b.identity, vaultId, newEid(), [{ device: r.id, cut: CUT }]),
      b.id,
      100_000,
    ),
  );
  const fakeB = createDeviceIdentity(sodium, b.id);
  const p1 = createDeviceIdentity(sodium);
  const p2 = createDeviceIdentity(sodium);
  if (mint === "p2") events.push(certify(vaultId, r.identity, fakeB, 1_500));
  if (mint === "v1") events.push(certify(vaultId, r.identity, fakeB, 500));
  if (mint === "v2") {
    events.push(certify(vaultId, r.identity, p1, 500)); // while R is trusted
    events.push(certify(vaultId, p1, fakeB, 900_000)); // any time later, in the puppet's stream
  }
  if (mint === "chain3") {
    events.push(certify(vaultId, r.identity, p1, 500));
    events.push(certify(vaultId, p1, p2, 100));
    events.push(certify(vaultId, p2, fakeB, 100));
  }
  const claim = (signer: DeviceIdentity) =>
    stamp(
      buildLeaseClaim(signer, vaultId, newEid(), {
        at: START_TIME,
        until: START_TIME + 60 * 60 * 1000,
        watermark: { [r.id]: FAR },
        prev: null,
      }),
      b.id,
      50_000,
    );
  events.push(claim(options.honestClaim ? b.identity : fakeB));
  if (options.forgedRevocation) {
    events.push(
      stamp(
        buildDeviceRevoked(fakeB, vaultId, newEid(), [
          { device: c.id, cut: { seg: 1, offset: 0 } },
        ]),
        b.id,
        60_000,
      ),
    );
  }
  events.push(
    stamp(
      buildDeviceRevoked(r.identity, vaultId, newEid(), [
        { device: c.id, cut: { seg: 1, offset: 0 } },
      ]),
      r.id,
      2_000,
    ),
  );
  if (options.revokesCreator) {
    events.push(
      stamp(
        buildDeviceRevoked(r.identity, vaultId, newEid(), [
          { device: a.id, cut: { seg: 1, offset: 0 } },
        ]),
        r.id,
        2_100,
      ),
    );
  }
  const registry = foldRegistry(sodium, { vaultId, recovery: a.ring.recovery }, events);
  return { registry, a, b, r, c };
}

function expectClosed(s: Scenario): void {
  expect(s.registry.revoked.get(s.r.id)?.cut).toEqual(CUT);
  expect(s.registry.revoked.has(s.c.id)).toBe(false);
  expect(s.registry.isTrusted(s.c.id)).toBe(true);
  expect(s.registry.isTrusted(s.b.id)).toBe(true);
}

describe("decision keys: no key certified through a revoked device backs a revocation decision", () => {
  it("P2: a key R certifies for its revoker after its cut cannot raise R's cut", async () => {
    expectClosed(await scenario("p2"));
  });

  it("P2: a revocation signed in its revoker's name with a key R minted never counts", async () => {
    expectClosed(await scenario("p2", { forgedRevocation: true }));
  });

  it("V1: a key R certified before its cut (an old frame) cannot raise R's cut either", async () => {
    expectClosed(await scenario("v1"));
  });

  it("V2: a key a puppet of R certifies in its own stream cannot raise R's cut", async () => {
    expectClosed(await scenario("v2"));
  });

  it("a key three certifications below R cannot raise R's cut", async () => {
    expectClosed(await scenario("chain3"));
  });

  it("with a post-cut revocation of the creator too, a minted key changes nothing", async () => {
    // R revoking the creator after its own cut leaves the fixpoint undecided (fail closed); whatever
    // that decides, it is the same with and without the minted key.
    const roles = async (mint: Mint) => {
      const s = await scenario(mint, { revokesCreator: true });
      const role = new Map([s.a, s.b, s.r, s.c].map((d, i) => [d.id, "abrc"[i]]));
      return {
        revoked: [...s.registry.revoked.keys()].map((d) => role.get(d)).sort(),
        trusted: [...s.registry.trusted.keys()].map((d) => role.get(d)).sort(),
        rCut: s.registry.revoked.get(s.r.id)?.cut,
      };
    };
    const without = await roles("none");
    for (const mint of ["p2", "v1", "v2", "chain3"] as const) {
      expect(await roles(mint), mint).toEqual(without);
    }
  });

  it("control: B's own attestation (its real key) raises R's cut, and R's revocation of C then counts", async () => {
    const s = await scenario("none", { honestClaim: true });
    expect(s.registry.revoked.get(s.r.id)?.cut).toEqual(FAR);
    expect(s.registry.revoked.has(s.c.id)).toBe(true);
  });

  it("control: a device three certifications below the creator attests and revokes with a raised cut", async () => {
    const { creator: a } = createSimVault();
    const r = await pairDevice(a, "laptop");
    for (let i = 0; i < 2; i++) for (const d of [a, r]) d.sync();
    const vaultId = a.ring.vaultId;
    const [d1, d2, d3] = [0, 1, 2].map(() => createDeviceIdentity(sodium)) as [
      DeviceIdentity,
      DeviceIdentity,
      DeviceIdentity,
    ];
    const events = [
      ...[a, r].flatMap((d) => d.stream.flatMap((s) => s.events)),
      certify(vaultId, a.identity, d1, 10_000),
      certify(vaultId, d1, d2, 100),
      certify(vaultId, d2, d3, 100),
      stamp(
        buildLeaseClaim(d3, vaultId, newEid(), {
          at: START_TIME,
          until: START_TIME + 60 * 60 * 1000,
          watermark: { [r.id]: FAR },
          prev: null,
        }),
        d3.deviceId,
        100,
      ),
      stamp(
        buildDeviceRevoked(d3, vaultId, newEid(), [{ device: r.id, cut: { seg: 1, offset: 0 } }]),
        d3.deviceId,
        200,
      ),
    ];
    const registry = foldRegistry(sodium, { vaultId, recovery: a.ring.recovery }, events);
    expect(registry.isTrusted(d3.deviceId)).toBe(true);
    expect(registry.revoked.get(r.id)?.cut).toEqual(FAR);
  });
});
