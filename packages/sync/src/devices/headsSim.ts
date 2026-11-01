// Test support (not exported): the signed-heads attacks (S29c phase B2) as scenarios shared by the
// default tier (heads.attacks.test.ts, one seed each) and the sweeps
// (heads.attacks.exhaustive.test.ts).

import { expect } from "vitest";
import type { UnstampedEvent } from "../carrier.js";
import { genesisChain } from "../crypto/index.js";
import { note, summary, syncAll } from "./orderSim.js";
import {
  type Batch,
  createSimVault,
  forgeBatch,
  mulberry32,
  pairDevice,
  revokeWithConsent,
} from "./testkit.js";

export async function fourDevices() {
  const vault = createSimVault();
  const a = vault.creator;
  const b = await pairDevice(a, "phone");
  const r = await pairDevice(a, "laptop");
  const c = await pairDevice(a, "tablet");
  syncAll([a, b, r, c]);
  return { ...vault, a, b, r, c };
}

/** A note event with a recognisable eid. */
export function marked(): UnstampedEvent {
  return note();
}

/**
 * A1b with a random schedule: R writes `writes` notes amid random pulls, B revokes R with R's
 * consent (the cut commits to R's head), then R rewrites one of its pre-cut batches (and re-signs
 * every later one) in storage. Devices that applied the original, a rebuild and a fresh joiner must
 * agree on the registry, and no device ever accepts the rewritten content.
 */
export async function rewriteRun(seed: number): Promise<void> {
  const rand = mulberry32(seed);
  const { a, b, r, c } = await fourDevices();
  const all = [a, b, r, c];
  const writes = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < writes; i++) {
    r.write([marked()]);
    for (const d of all) if (rand() < 0.5) d.sync();
  }
  syncAll(all);
  revokeWithConsent(b, [r]);
  syncAll(all);
  const preCut = r.stream.length - 1 - Math.floor(rand() * writes);
  const replacement = marked();
  for (const batch of r.rewrite(preCut, [replacement])) a.remote.replace(batch);
  const joiner = await pairDevice(a, "joiner");
  syncAll([...all, joiner]);
  c.rebuild();
  const reference = summary(a.devices.registry);
  expect(reference.revoked.map((x) => x[0])).toEqual([r.id]);
  expect(reference.trusted).toContain(b.id);
  for (const d of [b, c, joiner]) expect(summary(d.devices.registry), d.name).toEqual(reference);
  for (const d of [a, b, c, joiner]) {
    expect(d.acceptedEids(), `${d.name} seed ${seed}`).not.toContain(replacement.i);
  }
  // Devices that read the rewritten stream see the fork: R frozen, its data no longer accepted.
  for (const d of [c, joiner]) {
    expect(
      d.gate.forks().map((f) => f.device),
      `${d.name} seed ${seed}`,
    ).toEqual([r.id]);
    expect(d.acceptedData().some((x) => x.startsWith(`${r.id}@`))).toBe(false);
  }
}

/**
 * m6 with a random victim position: after R's revocation, R writes AEAD-valid batches at an idle
 * writer's next position, signed with its own key or with a key nobody certified for the victim's
 * id. No device copies or accepts them; the victim's real batch later applies everywhere.
 */
export async function forgeryRun(seed: number): Promise<void> {
  const rand = mulberry32(seed);
  const { a, b, r, c, vaultId } = await fourDevices();
  const all = [a, b, r, c];
  for (let i = Math.floor(rand() * 3); i > 0; i--) b.write([marked()]);
  syncAll(all);
  revokeWithConsent(a, [r]);
  syncAll(all);
  const last = b.stream.at(-1);
  const start = last?.cursor ?? { seg: 1, offset: 0 };
  const at = { start, cursor: { seg: 1, offset: start.offset + 100 } };
  const prev = last?.head.chain ?? genesisChain({ vaultId, deviceId: b.id, stream: 1 });
  const payload = marked();
  const stamped = [
    {
      eid: payload.i,
      hlc: b.stream.at(-1)?.events.at(-1)?.hlc ?? "",
      writer: b.id,
      position: at.cursor,
      type: payload.t,
      v: payload.v,
      data: payload.d,
    },
  ];
  const forged: Batch = forgeBatch(vaultId, r.identity, b.id, at, stamped, prev);
  a.remote.publish(forged);
  const joiner = await pairDevice(a, "joiner");
  for (const d of [a, c, joiner]) d.pull();
  for (const d of [a, c, joiner]) {
    expect(d.acceptedEids(), `${d.name} seed ${seed}`).not.toContain(payload.i);
    expect(d.verdicts).toContainEqual({
      device: b.id,
      cursor: at.cursor,
      verdict: "bad_head_signature",
    });
  }
  // The victim's genuine batch at that position replaces the forgery in storage and applies.
  const genuine = b.write([marked()]);
  a.remote.replace(genuine);
  for (const d of [a, c, joiner]) {
    d.pull();
    expect(d.acceptedEids()).toContain(genuine.events[0]?.eid);
  }
}
