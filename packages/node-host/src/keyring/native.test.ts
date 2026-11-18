// The OS keyring port's platform rules: which platforms have a native keyring, and the Windows
// Credential Manager's 2560-byte limit, refused before any native call. Never touches a real
// keychain on macOS or Linux; the Windows-only case is refused before the native store is reached.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hasNativeOsKeyring,
  nativeOsKeyring,
  osKeyringFits,
  WINDOWS_CREDENTIAL_MAX_BYTES,
} from "./native.js";

describe("native OS keyring", () => {
  it("drives the Keychain, the Secret Service and the Credential Manager only", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(hasNativeOsKeyring(platform)).toBe(true);
    }
    for (const platform of ["freebsd", "openbsd", "aix", "android"] as const) {
      expect(hasNativeOsKeyring(platform)).toBe(false);
    }
  });

  it("fits a secret into one Windows credential up to 2560 bytes, elsewhere any size", () => {
    expect(WINDOWS_CREDENTIAL_MAX_BYTES).toBe(2560);
    expect(osKeyringFits(32, "win32")).toBe(true);
    expect(osKeyringFits(2560, "win32")).toBe(true);
    expect(osKeyringFits(2561, "win32")).toBe(false);
    expect(osKeyringFits(64 * 1024, "darwin")).toBe(true);
    expect(osKeyringFits(64 * 1024, "linux")).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "refuses an oversize secret as keystore_unavailable before the Credential Manager",
    async () => {
      const service = `cashu-next-test.${randomBytes(16).toString("hex")}`;
      await expect(
        nativeOsKeyring().set(
          service,
          "oversize",
          new Uint8Array(WINDOWS_CREDENTIAL_MAX_BYTES + 1),
        ),
      ).rejects.toMatchObject({ code: "keystore_unavailable" });
    },
  );
});
