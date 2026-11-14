// The device-owner check behind the app lock (Face ID, Touch ID or the passcode). The port the lock
// gate and the profile sheet use; `platform/localAuth.ts` implements it over expo-local-authentication
// and `shell/testing/auth.ts` scripts it for tests.

/** What the phone can check: Face ID, Touch ID, only the passcode, or nothing set up. */
export type LockCapability = "face" | "fingerprint" | "passcode" | "none";

/** `unavailable`: nothing to check with (no Face ID, Touch ID or passcode set up). */
export type AuthResult = "ok" | "cancelled" | "failed" | "unavailable";

/** Translated texts of the system prompt. */
export interface AuthPrompt {
  readonly message: string;
  readonly cancel: string;
  /** The passcode button of a biometric prompt. */
  readonly fallback: string;
}

export interface Authenticator {
  /** Resolves with what the phone can check with; never rejects (an error reads as `none`). */
  capability(): Promise<LockCapability>;
  /** Resolves with the outcome; never rejects. */
  authenticate(prompt: AuthPrompt): Promise<AuthResult>;
}
