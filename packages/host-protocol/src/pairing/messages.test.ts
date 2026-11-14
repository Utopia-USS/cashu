import { describe, expect, it } from "vitest";
import { pairingCancelResultSchema, pairingInspectResultSchema } from "./messages.js";

const operationId = "01JZ0000000000000000000000";

describe("native.pairing.v1 wire", () => {
  it("says on a pending invitation whether the phone connected, and only there", () => {
    for (const phoneConnected of [true, false])
      expect(
        pairingInspectResultSchema.safeParse({ kind: "pending", operationId, phoneConnected })
          .success,
      ).toBe(true);
    expect(pairingInspectResultSchema.safeParse({ kind: "pending", operationId }).success).toBe(
      false,
    );
    expect(
      pairingInspectResultSchema.safeParse({
        kind: "completed",
        operationId,
        phoneConnected: true,
      }).success,
    ).toBe(false);
  });

  it("answers a cancel after the commit point with a distinct already_added refusal", () => {
    expect(pairingCancelResultSchema.parse({ kind: "cancelled" })).toEqual({ kind: "cancelled" });
    expect(pairingCancelResultSchema.parse({ kind: "refused", code: "already_added" })).toEqual({
      kind: "refused",
      code: "already_added",
    });
    expect(pairingCancelResultSchema.safeParse({ kind: "refused" }).success).toBe(true);
    expect(
      pairingCancelResultSchema.safeParse({ kind: "cancelled", code: "already_added" }).success,
    ).toBe(false);
    expect(pairingCancelResultSchema.safeParse({ kind: "refused", code: "busy" }).success).toBe(
      false,
    );
  });
});
