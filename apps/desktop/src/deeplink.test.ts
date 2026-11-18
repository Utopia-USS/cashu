import { describe, expect, it } from "vitest";
import { shouldRegisterProtocol } from "./deeplink.js";

describe("URL scheme registration is dev-safe", () => {
  it("never registers in a development run, even when asked", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(shouldRegisterProtocol({ isPackaged: false, env: {}, platform })).toBe(false);
      expect(
        shouldRegisterProtocol({
          isPackaged: false,
          env: { CASHU_DESKTOP_REGISTER_PROTOCOL: "1" },
          platform,
        }),
      ).toBe(false);
    }
  });

  it("registers a packaged macOS app only when asked to (its Info.plist declares the scheme)", () => {
    expect(shouldRegisterProtocol({ isPackaged: true, env: {}, platform: "darwin" })).toBe(false);
    expect(
      shouldRegisterProtocol({
        isPackaged: true,
        env: { CASHU_DESKTOP_REGISTER_PROTOCOL: "1" },
        platform: "darwin",
      }),
    ).toBe(true);
  });

  it("registers a packaged Windows app itself (the installer registers no scheme)", () => {
    expect(shouldRegisterProtocol({ isPackaged: true, env: {}, platform: "win32" })).toBe(true);
  });
});
