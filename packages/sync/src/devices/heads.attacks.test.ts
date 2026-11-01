// The gaps signed heads close (S29c phase B2; S29-review.md A1b, m6, the forged self-revocation
// residual, withholding), as permanent attack tests. One seed each here; the sweeps are
// heads.attacks.exhaustive.test.ts.

import { describe, expect, it } from "vitest";
import { certifyDevice, createDeviceIdentity, genesisChain, signHead } from "../crypto/index.js";
import { buildDeviceAdded, buildDeviceRevoked, type LogEvent } from "./events.js";
import { StreamIndex } from "./heads.js";
import { forgeryRun, fourDevices, marked, rewriteRun } from "./headsSim.js";
import { note, syncAll } from "./orderSim.js";
import {
  chainOf,
  forgeBatch,
  newEid,
  revokedWithConsent,
  revokeWithConsent,
  sodium,
} from "./testkit.js";

describe("signed heads close the rewrite and forgery classes", () => {
  it("m6: a revoked device cannot forge an idle writer's frames, under any key (seed 1)", async () => {
    await forgeryRun(1);
  });

  it("A1b: a rewritten pre-cut frame is a proven fork; no device accepts its content (seed 1)", async () => {
    await rewriteRun(1);
  });

  it("a forged self-revocation in a rewritten early frame never counts (minted key, H5 residual)", async () => {
    const { a, b, r, c, vaultId } = await fourDevices();
    const all = [a, b, r, c];
    b.write([note()]);
    syncAll(all);
    // R, still trusted, certifies a second key pair for B's id: B is conflicted for now.
    const minted = createDeviceIdentity(sodium, b.id);
    const subject = {
      deviceId: b.id,
      signPublicKey: minted.signPublicKey,
      boxPublicKey: minted.box.publicKey,
    };
    r.write([
      buildDeviceAdded(
        r.identity,
        vaultId,
        newEid(),
        subject,
        "phone",
        certifyDevice(sodium, r.identity, subject, vaultId),
      ),
    ]);
    syncAll(all);
    // B retires R with R's consent (R in the owner's hands): R and its certificates no longer count.
    b.write([revokedWithConsent(b.identity, vaultId, [r.gate.ownEntry()], [r])]);
    syncAll(all);
    for (const d of all) {
      expect(d.devices.registry.revoked.has(r.id), d.name).toBe(true);
      expect(d.devices.registry.isTrusted(b.id), d.name).toBe(true);
    }
    // Storage rewrites B's first batch: a self-revocation of B (cut at its own start), signed and
    // head-signed with the minted key.
    const first = b.stream[0] as (typeof b.stream)[number];
    const selfRevocation = buildDeviceRevoked(minted, vaultId, newEid(), [
      { device: b.id, cut: first.cursor },
    ]);
    const stamped: LogEvent[] = [
      {
        eid: selfRevocation.i,
        hlc: first.events[0]?.hlc ?? "",
        writer: b.id,
        position: first.cursor,
        type: selfRevocation.t,
        v: selfRevocation.v,
        data: selfRevocation.d,
      },
    ];
    const forged = forgeBatch(
      vaultId,
      minted,
      b.id,
      first,
      stamped,
      genesisChain({ vaultId, deviceId: b.id, stream: 1 }),
    );
    a.remote.replace(forged);
    c.rebuild();
    for (const d of [c, a]) {
      const reg = d.devices.registry;
      expect(reg.revoked.has(b.id), d.name).toBe(false);
      expect(
        reg.events.some((e) => e.eid === selfRevocation.i),
        d.name,
      ).toBe(false);
    }
    // The rebuilt device cannot tell which of B's two keys its stream is bound to while R is
    // undecided for it, so B's stream waits there (fail closed): what remains is withholding (D10).
    expect(c.verdicts.some((v) => v.device === b.id && v.verdict !== "ok")).toBe(true);
  });

  it("withholding: a cut's signed head shows a reader that storage holds back the writer's tail", async () => {
    const { a, b, r, c } = await fourDevices();
    const all = [a, b, r, c];
    for (let i = 0; i < 3; i++) r.write([marked()]);
    syncAll(all);
    revokeWithConsent(b, [r]);
    syncAll(all);
    const cut = b.devices.registry.revoked.get(r.id)?.cut;
    expect(cut).toEqual(r.stream.at(-1)?.cursor);
    // A rebuilt reader whose storage serves only R's first batch.
    const firstEnd = r.stream[0]?.cursor.offset ?? 0;
    c.rebuild();
    expect(c.gate.behind()).toEqual([]);
    c.rebuild((batch) => batch.device !== r.id || batch.cursor.offset <= firstEnd);
    expect(c.gate.behind()).toEqual([{ device: r.id, attested: cut, held: r.stream[0]?.cursor }]);
  });

  it("a device id reused on a second install (two signed histories) is frozen at the agreed prefix", () => {
    const vaultId = "0123456789abcdef0123456789abcdef";
    const identity = createDeviceIdentity(sodium);
    const device = identity.deviceId;
    const index = new StreamIndex();
    const genesis = genesisChain({ vaultId, deviceId: device, stream: 1 });
    const batch = (offset: number, eid: string, prev: Uint8Array) => {
      const content = {
        device,
        start: { seg: 1, offset: offset - 100 },
        cursor: { seg: 1, offset },
        events: [
          {
            eid,
            hlc: "",
            writer: device,
            position: { seg: 1, offset },
            type: "note.added",
            v: 1,
            data: {},
          },
        ],
      };
      const chain = chainOf(vaultId, content, prev);
      return signHead(identity, vaultId, { device, stream: 1, seg: 1, offset, chain });
    };
    const h1 = batch(100, "e1", genesis);
    const mine = batch(200, "e2", h1.chain); // what this device holds
    const theirs = batch(200, "other", h1.chain); // the clone's frame at the same position
    index.observe(h1);
    index.observe(mine);
    const genuine = () => true;
    expect(index.forks(genuine)).toEqual([]);
    index.attest(h1); // an attestation that matches
    index.attest(theirs); // a head of the same writer with another chain at 1:200
    expect(index.forks(genuine)).toEqual([{ device, agreed: { seg: 1, offset: 100 } }]);
    // A head that is not the writer's (junk) never proves anything.
    const fresh = new StreamIndex();
    fresh.observe(h1);
    fresh.observe(mine);
    fresh.attest(theirs);
    expect(fresh.forks(() => false)).toEqual([]);
  });
});
