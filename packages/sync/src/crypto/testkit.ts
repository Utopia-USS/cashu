// Test helpers (synthetic data only). Not exported from the package.

import { utf8 } from "./encoding.js";
import { CryptoError, type CryptoErrorCode } from "./errors.js";
import type { FrameContext } from "./frame.js";
import { createKeyring, type Keyring } from "./keys.js";
import { createRecoveryKey } from "./recovery.js";
import { loadNodeSodium, type Sodium } from "./sodium.js";

export const sodium: Sodium = await loadNodeSodium();

export const PLAINTEXT_MARKER = "SYNTHETIC-CANARY-merchant-7f3a";

/** Synthetic device ids. */
export const DEVICE_A = "a1".repeat(16);
export const DEVICE_B = "b2".repeat(16);

/** A fixed synthetic gid salt for rings built from raw keys. */
export const GID_SALT = range(0x40, 0x5f);

/** One recovery key shared by the tests that do not need its words. */
export const testRecovery = createRecoveryKey(sodium);

export function newRing(s: Sodium = sodium, vaultId?: string): Keyring {
  return createKeyring(s, testRecovery.publicKeys, vaultId);
}

export function samplePlain(): Uint8Array {
  return utf8(JSON.stringify([{ t: "merchant.category.set", v: 1, merchant: PLAINTEXT_MARKER }]));
}

export function ctx(vaultId: string, over: Partial<FrameContext> = {}): FrameContext {
  return { vaultId, deviceId: DEVICE_A, segment: 3, offset: 4096, ...over };
}

export function range(from: number, to: number): Uint8Array {
  return Uint8Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** The CryptoError code `fn` throws, or "no error"; any other exception propagates. */
export function code(fn: () => unknown): CryptoErrorCode | "no error" {
  try {
    fn();
    return "no error";
  } catch (e) {
    if (e instanceof CryptoError) return e.code;
    throw e;
  }
}
