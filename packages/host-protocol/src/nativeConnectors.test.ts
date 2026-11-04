import { describe, expect, it } from "vitest";
import { clientFrameSchema } from "./messages.js";
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
