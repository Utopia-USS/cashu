import { describe, expect, it } from "vitest";
import { clientFrameSchema } from "./messages.js";
import {
  nativeConnectorsCommitResultSchema,
  nativeConnectorsPrepareResultSchema,
} from "./nativeConnectors.js";
import { NATIVE_CONNECTORS_METHODS, roleAllows } from "./roles.js";

describe("native connector picker wire", () => {
  it("admits only the two exact owner UI methods", () => {
    for (const method of NATIVE_CONNECTORS_METHODS) {
      const frame = clientFrameSchema.parse({ t: "req", id: 1, method, params: {} });
      expect(roleAllows("ui", frame)).toBe(true);
      expect(roleAllows("mcp", frame)).toBe(false);
      expect(roleAllows("cli", frame)).toBe(false);
    }
    const extra = clientFrameSchema.parse({
      t: "req",
      id: 2,
      method: "native.connectors.commitInstall.extra",
      params: {},
    });
    expect(roleAllows("ui", extra)).toBe(false);
  });
});

describe("native connector picker replies", () => {
  it("accepts the host's token and install replies", () => {
    expect(nativeConnectorsPrepareResultSchema.parse({ token: "a".repeat(64) })).toEqual({
      token: "a".repeat(64),
    });
    expect(
      nativeConnectorsCommitResultSchema.parse({ id: "sample", name: "Sample", digest: "d" }),
    ).toMatchObject({ id: "sample", digest: "d" });
  });

  it("refuses a reply without the expected string fields", () => {
    for (const value of [null, "token", [], {}, { token: 1 }])
      expect(nativeConnectorsPrepareResultSchema.safeParse(value).success).toBe(false);
    for (const value of [null, {}, { id: "sample" }, { digest: "d" }, { id: 1, digest: "d" }])
      expect(nativeConnectorsCommitResultSchema.safeParse(value).success).toBe(false);
  });
});
