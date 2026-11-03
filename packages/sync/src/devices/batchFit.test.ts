// S29c-B3 review minor: a revocation (or rotation) batch must fit ONE frame. The engine would split a
// larger batch into a frame group, and a group whose tail is missing leaves the revocation in
// `incomplete_batch` for good; so preparing refuses such a batch with a typed result and writes
// nothing; with the engine defaults a normal revocation fits.

import { describe, expect, it } from "vitest";
import { frameLoad } from "../segment.js";
import { acknowledgeRevocationPreview, previewRevocation } from "./revocationPolicy.js";
import { prepareRevocation, prepareRotation } from "./rotation.js";
import { createSimVault, newEid, pairDevice, type SimDevice, START_CURSOR } from "./testkit.js";

function syncAll(devices: readonly SimDevice[]): void {
  for (let i = 0; i < 2; i++) for (const d of devices) d.sync();
}

async function vault() {
  const v = createSimVault();
  const a = v.creator;
  const b = await pairDevice(a, "phone");
  const r = await pairDevice(a, "laptop");
  const ipad = await pairDevice(r, "iPad");
  syncAll([a, b, r, ipad]);
  return { ...v, a, b, r, ipad };
}

describe("a prepared batch fits one frame", () => {
  it("refuses a revocation that would not fit one frame, and keeps the ring unchanged", async () => {
    const { a, r, ipad, recovery } = await vault();
    const targets = [{ device: r.id, applied: a.cursors.get(r.id) ?? START_CURSOR }];
    const eids = { revoke: newEid(), rotate: newEid(), recertify: newEid };
    const selection = { recertify: [ipad.id] };
    const reviewed = (recertify: readonly string[]) => {
      const request = {
        targets,
        revokeEid: eids.revoke,
        attemptId: newEid(),
        authority: { kind: "recovery" as const },
        selection: { recertify },
      };
      const observed = previewRevocation(a.devices, a.gate, request);
      if (!observed.ok) throw new Error(observed.reason);
      const permit = acknowledgeRevocationPreview(observed.preview, {
        warning: "acknowledged",
        ...(observed.preview.requiresLocalStartConfirmation
          ? { localStart: "local_never_seen" as const }
          : {}),
      });
      if (!permit) throw new Error("missing revocation permit");
      return { request, permit };
    };
    const kids = a.devices.ring.entries().map((e) => e.kid);
    // Revocation + re-certification of the iPad + rotation = 3 events.
    const tight = { ...a.devices.keyContext(), frameLimits: { events: 2, bytes: 1 << 20 } };
    const tightReview = reviewed(selection.recertify);
    const refused = prepareRevocation(
      tight,
      a.gate,
      tightReview.request,
      tightReview.permit,
      eids,
      recovery,
      selection,
    );
    expect(refused).toMatchObject({ ok: false, reason: "batch_too_large", events: 3 });
    const small = { ...a.devices.keyContext(), frameLimits: { events: 10, bytes: 200 } };
    const smallReview = reviewed([]);
    expect(
      prepareRevocation(small, a.gate, smallReview.request, smallReview.permit, eids, recovery, {
        recertify: [],
      }),
    ).toMatchObject({
      ok: false,
      reason: "batch_too_large",
    });
    expect(prepareRotation(small, newEid())).toMatchObject({
      ok: false,
      reason: "batch_too_large",
    });
    expect(a.devices.ring.entries().map((e) => e.kid)).toEqual(kids);

    // With the engine defaults it fits one frame.
    const finalReview = reviewed(selection.recertify);
    const ok = prepareRevocation(
      a.devices.keyContext(),
      a.gate,
      finalReview.request,
      finalReview.permit,
      eids,
      recovery,
      selection,
    );
    if (!ok.ok) throw new Error(ok.reason);
    expect(frameLoad(ok.change.events).events).toBe(3);
    ok.change.commit();
  });
});
