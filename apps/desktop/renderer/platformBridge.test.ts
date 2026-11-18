import { afterEach, describe, expect, it, vi } from "vitest";
import { shellPlatform } from "./platformBridge.js";

afterEach(() => vi.unstubAllGlobals());

describe("shell platform", () => {
  it("reads the preload's process.platform", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      vi.stubGlobal("window", { cashuPlatform: platform });
      expect(shellPlatform()).toBe(platform);
    }
  });

  it("is undefined outside the shell and for anything that is not a platform name", () => {
    vi.stubGlobal("window", {});
    expect(shellPlatform()).toBeUndefined();
    for (const cashuPlatform of [1, null, "", "Win32", "win32; rm", "x".repeat(17)]) {
      vi.stubGlobal("window", { cashuPlatform });
      expect(shellPlatform()).toBeUndefined();
    }
  });
});
