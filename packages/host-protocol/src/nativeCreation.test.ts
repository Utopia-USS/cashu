import { describe, expect, it } from "vitest";
import { clientFrameSchema } from "./messages.js";
import {
  nativeCreationCommitParamsSchema,
  nativeCreationCommitResultSchema,
  nativeCreationCurrentResultSchema,
  nativeCreationInspectResultSchema,
  nativeCreationPrepareParamsSchema,
  nativeCreationPrepareResultSchema,
} from "./nativeCreation.js";
import { NATIVE_CREATION_FEATURE, roleAllows, uiCreationAllowed } from "./roles.js";

const id = "a".repeat(32);
const session = "b".repeat(32);
const input = {
  name: "Test",
  slug: "test",
  baseCurrency: "PLN",
  modules: ["budget"],
  mcpPrivacy: "strict",
};

describe("native.creation.v1 wire vectors", () => {
  it("accepts exact UI method names only with the 1.3 feature", () => {
    for (const method of ["prepare", "commit", "inspect", "current"]) {
      const full = `native.creation.${method}`;
      const frame = clientFrameSchema.parse({ t: "req", id: 1, method: full, params: {} });
      expect(roleAllows("ui", frame)).toBe(true);
      expect(uiCreationAllowed(full, 3, [NATIVE_CREATION_FEATURE])).toBe(true);
      expect(uiCreationAllowed(full, 2, [NATIVE_CREATION_FEATURE])).toBe(false);
      expect(uiCreationAllowed(full, 3, [])).toBe(false);
    }
    for (const method of [
      "native.creation.delete",
      "native.creation.prepare.extra",
      "admin.stop",
    ]) {
      const frame = clientFrameSchema.parse({ t: "req", id: 2, method, params: {} });
      expect(roleAllows("ui", frame)).toBe(false);
      expect(uiCreationAllowed(method, 3, [NATIVE_CREATION_FEATURE])).toBe(false);
    }
    expect(roleAllows("ui", clientFrameSchema.parse({ t: "cancel", id: 1 }))).toBe(false);
  });

  it("validates bounded exact requests and secret-bearing prepare response", () => {
    expect(nativeCreationPrepareParamsSchema.safeParse(input).success).toBe(true);
    expect(
      nativeCreationPrepareParamsSchema.safeParse({ ...input, name: "x".repeat(41) }).success,
    ).toBe(false);
    expect(nativeCreationPrepareParamsSchema.safeParse({ ...input, path: "/tmp/x" }).success).toBe(
      false,
    );
    expect(
      nativeCreationPrepareParamsSchema.safeParse({ ...input, modules: ["unknown"] }).success,
    ).toBe(false);
    expect(
      nativeCreationCommitParamsSchema.safeParse({ operationId: id, phraseSession: session })
        .success,
    ).toBe(true);
    expect(
      nativeCreationCommitParamsSchema.safeParse({
        operationId: id,
        phraseSession: session,
        words: "secret",
      }).success,
    ).toBe(false);
    expect(
      nativeCreationPrepareResultSchema.safeParse({
        kind: "prepared",
        operationId: id,
        phraseSession: session,
        words: "word ".repeat(24).trim(),
        expiresAt: "2026-11-03T12:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("accepts only fixed status fields, never a phrase or input", () => {
    const ready = {
      kind: "ready",
      operationId: id,
      vaultId: session,
      profileSlug: "test",
      reconnectRequired: true,
    };
    expect(nativeCreationCommitResultSchema.safeParse(ready).success).toBe(true);
    expect(nativeCreationInspectResultSchema.safeParse(ready).success).toBe(true);
    expect(nativeCreationCurrentResultSchema.safeParse({ kind: "none" }).success).toBe(true);
    expect(
      nativeCreationCurrentResultSchema.safeParse({
        kind: "pending",
        operationId: id,
        stage: "keys",
      }).success,
    ).toBe(true);
    expect(
      nativeCreationCurrentResultSchema.safeParse({
        kind: "pending",
        operationId: id,
        stage: "keys",
        words: "secret",
      }).success,
    ).toBe(false);
    expect(
      nativeCreationCommitResultSchema.safeParse({
        kind: "ready",
        operationId: id,
        vaultId: session,
        profileSlug: "test",
        reconnectRequired: false,
      }).success,
    ).toBe(false);
    expect(
      nativeCreationCurrentResultSchema.safeParse({ kind: "not_found", operationId: id }).success,
    ).toBe(false);
    expect(nativeCreationInspectResultSchema.safeParse({ kind: "none" }).success).toBe(false);
  });
});
