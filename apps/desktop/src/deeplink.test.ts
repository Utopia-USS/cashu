import { describe, expect, it } from "vitest";
import { shouldRegisterProtocol } from "./deeplink.js";

describe("URL scheme registration is dev-safe", () => {
  it("never registers in a development run, even when asked", () => {
    expect(shouldRegisterProtocol({ isPackaged: false, env: {} })).toBe(false);
    expect(
      shouldRegisterProtocol({ isPackaged: false, env: { CASHU_DESKTOP_REGISTER_PROTOCOL: "1" } }),
    ).toBe(false);
  });

  it("registers only for a packaged app that was asked to", () => {
    expect(shouldRegisterProtocol({ isPackaged: true, env: {} })).toBe(false);
    expect(
      shouldRegisterProtocol({ isPackaged: true, env: { CASHU_DESKTOP_REGISTER_PROTOCOL: "1" } }),
    ).toBe(true);
  });
});
