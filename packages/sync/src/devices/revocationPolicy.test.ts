import { describe, expect, it } from "vitest";
import { createRecoveryKey, recoveryIdentity } from "../crypto/index.js";
import {
  createSimVault,
  newEid,
  pairDevice,
  START_CURSOR,
  sodium,
} from "../testing/devices/testkit.js";
import {
  acknowledgeRevocationPreview,
  previewRevocation,
  type RevocationPreviewRequest,
} from "./revocationPolicy.js";

async function pair() {
  const vault = createSimVault();
  const a = vault.creator;
  const b = await pairDevice(a, "phone");
  b.write([{ t: "note.added", v: 1, i: newEid(), d: {} }]);
  b.push();
  a.sync();
  b.sync();
  a.sync();
  return { vault, a, b };
}

function request(
  target: string,
  applied: { readonly seg: number; readonly offset: number },
): RevocationPreviewRequest {
  return {
    targets: [{ device: target, applied }],
    revokeEid: newEid(),
    attemptId: newEid(),
    authority: { kind: "recovery" },
    selection: { recertify: [] },
  };
}

describe("revocation admission", () => {
  it("rejects a forged permit and a permit for another revoke eid or selection", async () => {
    const { vault, a, b } = await pair();
    const input = request(b.id, a.cursors.get(b.id) ?? START_CURSOR);
    const observed = previewRevocation(a.devices, a.gate, input);
    if (!observed.ok) throw new Error(observed.reason);
    const valid = acknowledgeRevocationPreview(observed.preview, { warning: "acknowledged" });
    if (!valid) throw new Error("no permit");
    const eids = { revoke: input.revokeEid, rotate: newEid() };
    const forged = {} as typeof valid;
    expect(
      a.devices.prepareRevocation(a.gate, input, forged, eids, vault.recovery, { recertify: [] }),
    ).toEqual({ ok: false, reason: "revocation_admission_required" });
    expect(
      a.devices.prepareRevocation(
        a.gate,
        input,
        valid,
        { ...eids, revoke: newEid() },
        vault.recovery,
        { recertify: [] },
      ),
    ).toEqual({ ok: false, reason: "revocation_admission_required" });
    const again = previewRevocation(a.devices, a.gate, input);
    if (!again.ok) throw new Error(again.reason);
    const second = acknowledgeRevocationPreview(again.preview, { warning: "acknowledged" });
    if (!second) throw new Error("no permit");
    expect(
      a.devices.prepareRevocation(a.gate, input, second, eids, vault.recovery, {
        recertify: [a.id],
      }),
    ).toEqual({ ok: false, reason: "revocation_admission_required" });
  });

  it("requires the exact local-start acknowledgement when this device has no target head", async () => {
    const vault = createSimVault();
    const a = vault.creator;
    const b = await pairDevice(a, "unseen phone");
    const input = request(b.id, START_CURSOR);
    const observed = previewRevocation(a.devices, a.gate, input);
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(observed.preview.targets[0]?.status).toBe("local_start_no_head");
    expect(
      acknowledgeRevocationPreview(observed.preview, { warning: "acknowledged" }),
    ).toBeUndefined();
    const permit = acknowledgeRevocationPreview(observed.preview, {
      warning: "acknowledged",
      localStart: "local_never_seen",
    });
    expect(permit).toBeDefined();
    if (!permit) return;
    const prepared = a.devices.prepareRevocation(
      a.gate,
      input,
      permit,
      { revoke: input.revokeEid, rotate: newEid() },
      vault.recovery,
      { recertify: [] },
    );
    expect(prepared.ok).toBe(true);
    if (prepared.ok) prepared.change.discard();
  });

  it("requires a universal warning acknowledgement, consumes a permit, and binds the exact cut", async () => {
    const { vault, a, b } = await pair();
    const input = request(b.id, a.cursors.get(b.id) ?? START_CURSOR);
    const observed = previewRevocation(a.devices, a.gate, input);
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(observed.preview.warning).toBe("revoke_may_exclude_unseen_writes");
    expect(observed.preview.targets[0]?.status).toBe("trusted_head");
    expect(
      acknowledgeRevocationPreview(observed.preview, { warning: "missing" as "acknowledged" }),
    ).toBeUndefined();
    const permit = acknowledgeRevocationPreview(observed.preview, { warning: "acknowledged" });
    expect(permit).toBeDefined();
    if (!permit) return;
    const eids = { revoke: input.revokeEid, rotate: newEid() };
    const first = a.devices.prepareRevocation(a.gate, input, permit, eids, vault.recovery, {
      recertify: [],
    });
    expect(first.ok).toBe(true);
    if (first.ok) first.change.discard();
    expect(
      a.devices.prepareRevocation(a.gate, input, permit, eids, vault.recovery, { recertify: [] }),
    ).toEqual({ ok: false, reason: "revocation_admission_required" });
  });

  it("refuses a stale target cut and a changed authority or selection", async () => {
    const { vault, a, b } = await pair();
    const input = request(b.id, a.cursors.get(b.id) ?? START_CURSOR);
    const observed = previewRevocation(a.devices, a.gate, input);
    if (!observed.ok) throw new Error(observed.reason);
    const permit = acknowledgeRevocationPreview(observed.preview, { warning: "acknowledged" });
    if (!permit) throw new Error("no permit");
    b.write([{ t: "note.added", v: 1, i: newEid(), d: {} }]);
    b.push();
    a.sync();
    expect(previewRevocation(a.devices, a.gate, input)).toEqual({
      ok: false,
      reason: "stale_applied_cursor",
    });
    expect(
      a.devices.prepareRevocation(
        a.gate,
        input,
        permit,
        { revoke: input.revokeEid, rotate: newEid() },
        vault.recovery,
        { recertify: [] },
      ),
    ).toEqual({ ok: false, reason: "revocation_admission_required" });
    const changed = {
      ...input,
      targets: [{ device: b.id, applied: a.cursors.get(b.id) ?? START_CURSOR }],
    };
    const again = previewRevocation(a.devices, a.gate, changed);
    if (!again.ok) throw new Error(again.reason);
    const second = acknowledgeRevocationPreview(again.preview, { warning: "acknowledged" });
    if (!second) throw new Error("no permit");
    const other = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    try {
      expect(
        a.devices.prepareRevocation(
          a.gate,
          changed,
          second,
          { revoke: changed.revokeEid, rotate: newEid() },
          other,
          { recertify: [] },
        ),
      ).toEqual({ ok: false, reason: "revocation_admission_required" });
    } finally {
      other.wipe();
    }
  });

  it("treats a non-start missing head as integrity failure, not as a confirmation case", async () => {
    const { a, b } = await pair();
    const missing = { seg: 1, offset: 9_999_999 };
    a.devices.guard.record({ device: b.id, end: missing });
    const input = request(b.id, missing);
    expect(a.gate.checkedRevocationEntry(b.id, input.targets[0]?.applied ?? START_CURSOR)).toEqual({
      kind: "integrity_error",
      code: "head_missing_at_non_start",
    });
    expect(previewRevocation(a.devices, a.gate, input)).toEqual({
      ok: false,
      reason: "integrity_error",
    });
  });
});
