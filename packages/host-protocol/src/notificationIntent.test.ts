import { expect, it } from "vitest";
import {
  clientFrameSchema,
  NOTIFICATION_INTENT_METHOD,
  notificationResolveParamsSchema,
  notificationResolveResultSchema,
  roleAllows,
} from "./index.js";

const params = {
  requestId: "12345678-1234-4234-8234-123456789abc",
  intentToken: "a".repeat(64),
};

it("allows only the exact authenticated UI resolution method", () => {
  const frame = clientFrameSchema.parse({
    t: "req",
    id: 1,
    method: NOTIFICATION_INTENT_METHOD,
    params,
  });
  expect(roleAllows("ui", frame)).toBe(true);
  expect(roleAllows("cli", frame)).toBe(false);
  expect(roleAllows("mcp", frame)).toBe(false);
  expect(roleAllows("admin", frame)).toBe(false);
  expect(notificationResolveParamsSchema.safeParse(params).success).toBe(true);
  expect(notificationResolveParamsSchema.safeParse({ ...params, vaultId: "other" }).success).toBe(
    false,
  );
  expect(
    notificationResolveParamsSchema.safeParse({ ...params, intentToken: [params.intentToken] })
      .success,
  ).toBe(false);
});

it("accepts only typed target or neutral unavailable results", () => {
  expect(notificationResolveResultSchema.safeParse({ kind: "unavailable" }).success).toBe(true);
  expect(
    notificationResolveResultSchema.safeParse({
      kind: "target",
      vaultId: "vault",
      target: "signal",
      signalId: "signal",
    }).success,
  ).toBe(true);
  expect(
    notificationResolveResultSchema.safeParse({
      kind: "target",
      vaultId: "vault",
      target: "signal",
    }).success,
  ).toBe(false);
  expect(
    notificationResolveResultSchema.safeParse({
      kind: "target",
      vaultId: "vault",
      target: "generic",
      signalId: "signal",
    }).success,
  ).toBe(false);
});
