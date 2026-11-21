import { describe, expect, it } from "vitest";
import { roleAllows } from "../roles.js";
import {
  deviceListResultSchema,
  NATIVE_DEVICES_FEATURE,
  NATIVE_DEVICES_METHODS,
  revokeCommitParamsSchema,
  revokePreviewParamsSchema,
  uiDevicesAllowed,
} from "./messages.js";

describe("native.devices.v1 wire", () => {
  it("admits only exact UI methods with feature and minor 6", () => {
    for (const method of NATIVE_DEVICES_METHODS) {
      expect(uiDevicesAllowed(method, 6, [NATIVE_DEVICES_FEATURE])).toBe(true);
      expect(uiDevicesAllowed(method, 5, [NATIVE_DEVICES_FEATURE])).toBe(false);
      expect(uiDevicesAllowed(method, 6, [])).toBe(false);
      for (const role of ["mcp", "cli", "admin"] as const)
        expect(roleAllows(role, { t: "req", id: 1, method, params: {} })).toBe(false);
    }
    expect(uiDevicesAllowed("native.devices.revokeCommit.extra", 6, [NATIVE_DEVICES_FEATURE])).toBe(
      false,
    );
    expect(
      roleAllows("ui", {
        t: "req",
        id: 1,
        method: "native.devices.revokeCommit.extra",
        params: {},
      }),
    ).toBe(false);
  });

  it("requires sorted exact targets and bounded phrase on the dedicated commit method", () => {
    const a = "a".repeat(32);
    const b = "b".repeat(32);
    expect(
      revokePreviewParamsSchema.safeParse({ vault: a, targets: [a, b], recertify: [] }).success,
    ).toBe(true);
    expect(
      revokePreviewParamsSchema.safeParse({ vault: a, targets: [b, a], recertify: [] }).success,
    ).toBe(false);
    expect(
      revokePreviewParamsSchema.safeParse({ vault: a, targets: [a, a], recertify: [] }).success,
    ).toBe(false);
    expect(
      revokeCommitParamsSchema.safeParse({
        vault: a,
        token: b,
        warningAcknowledgement: "revoke_risk_acknowledged",
        recoveryPhrase: "x".repeat(513),
      }).success,
    ).toBe(false);
    expect(
      revokeCommitParamsSchema.safeParse({
        vault: a,
        token: b,
        confirmed: true,
        recoveryPhrase: "x".repeat(50),
      }).success,
    ).toBe(false);
  });

  it("carries the pairing day as a local calendar day, optional, and the pairing revision", () => {
    const a = "a".repeat(32);
    const device = {
      id: a,
      name: "Synthetic phone",
      trusted: true,
      revoked: false,
      behind: false,
      forked: false,
      forkAgreed: null,
      pairedBy: a,
      pairedAt: { seg: 1, offset: 0 },
    };
    const list = (devices: unknown[], extra: object = {}) => ({
      kind: "ready",
      vault: a,
      ownDevice: a,
      operations: [],
      leaderOperations: [],
      evidence: {
        historyPending: false,
        overflow: false,
        authorityUncertain: false,
        writeAdmission: "ready",
      },
      leader: {
        mode: "auto",
        state: "auto",
        device: null,
        pendingFrom: null,
        lastActivityAt: null,
        silentForMs: 0,
        warn: false,
      },
      keyProvenance: { source: "own", sender: null, recipientsKnown: false },
      devices,
      ...extra,
    });
    expect(deviceListResultSchema.safeParse(list([device])).success).toBe(true);
    expect(
      deviceListResultSchema.safeParse(
        list([{ ...device, pairedOn: "2026-11-14" }], { pairingRevision: 3 }),
      ).success,
    ).toBe(true);
    for (const pairedOn of ["2026-11-14T10:00:00Z", "14.11.2026", ""])
      expect(deviceListResultSchema.safeParse(list([{ ...device, pairedOn }])).success).toBe(false);
    expect(deviceListResultSchema.safeParse(list([device], { pairingRevision: -1 })).success).toBe(
      false,
    );
  });
});
