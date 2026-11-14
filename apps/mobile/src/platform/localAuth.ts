// The app lock's `Authenticator` over expo-local-authentication (the only importer of the package):
// Face ID or Touch ID with the passcode as the system's own fallback (`deviceOwnerAuthentication` on
// iOS). The usage text for Face ID is the Info.plist's (app.json plugin + locales/pl.json).
import {
  AuthenticationType,
  authenticateAsync,
  getEnrolledLevelAsync,
  hasHardwareAsync,
  isEnrolledAsync,
  SecurityLevel,
  supportedAuthenticationTypesAsync,
} from "expo-local-authentication";
import type { Authenticator, AuthResult, LockCapability } from "../shell/auth";

const CANCELLED = new Set(["user_cancel", "app_cancel", "system_cancel"]);
const UNAVAILABLE = new Set(["not_enrolled", "not_available", "passcode_not_set"]);

/** Never rejects (the port's contract): any error of the module reads as nothing set up. */
async function capability(): Promise<LockCapability> {
  try {
    const [hardware, enrolled, types, level] = await Promise.all([
      hasHardwareAsync(),
      isEnrolledAsync(),
      supportedAuthenticationTypesAsync(),
      getEnrolledLevelAsync(),
    ]);
    if (hardware && enrolled) {
      if (types.includes(AuthenticationType.FACIAL_RECOGNITION)) return "face";
      if (types.includes(AuthenticationType.FINGERPRINT)) return "fingerprint";
    }
    return level === SecurityLevel.NONE ? "none" : "passcode";
  } catch {
    return "none";
  }
}

export const localAuthenticator: Authenticator = {
  capability,
  async authenticate(prompt): Promise<AuthResult> {
    try {
      const result = await authenticateAsync({
        promptMessage: prompt.message,
        cancelLabel: prompt.cancel,
        fallbackLabel: prompt.fallback,
        disableDeviceFallback: false,
      });
      if (result.success) return "ok";
      if (CANCELLED.has(result.error)) return "cancelled";
      if (UNAVAILABLE.has(result.error)) return "unavailable";
      return "failed";
    } catch {
      return "failed";
    }
  },
};
