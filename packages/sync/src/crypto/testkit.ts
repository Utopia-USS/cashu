// Test helpers (synthetic data only). Not exported from the package.

import { certifyDevice, type TrustedDevice, verifyCertificates } from "./cert.js";
import { utf8 } from "./encoding.js";
import { CryptoError, type CryptoErrorCode } from "./errors.js";
import type { FrameContext } from "./frame.js";
import type { DeviceIdentity } from "./identity.js";
import { createKeyring, type Keyring } from "./keys.js";
import { createRecoveryKey, recoveryIdentity } from "./recovery.js";
import { fromLibsodium, type LibsodiumLike, loadNodeSodium, type Sodium } from "./sodium.js";

export const sodium: Sodium = await loadNodeSodium();

/**
 * A stand-in for react-native-libsodium 1.7 built from libsodium-wrappers: the same function names
 * as named exports, an AEAD that throws "input type not yet implemented" unless the additional
 * data is a string, react-native-libsodium's failure message for seal_open, and a default export
 * object that lacks crypto_box_seal / crypto_box_seal_open.
 */
export async function fakeReactNativeLibsodium(): Promise<{
  namespace: LibsodiumLike;
  defaultExport: Partial<LibsodiumLike>;
}> {
  const { default: lib } = await import("libsodium-wrappers");
  await lib.ready;
  const real = lib as unknown as Required<LibsodiumLike>;
  const notImplemented = (name: string) => new Error(`${name}: input type not yet implemented`);
  const namespace: Required<LibsodiumLike> = {
    randombytes_buf: (n) => real.randombytes_buf(n),
    crypto_box_keypair: () => real.crypto_box_keypair(),
    crypto_box_seed_keypair: (seed) => real.crypto_box_seed_keypair(seed),
    crypto_box_seal: (m, pk) => real.crypto_box_seal(m, pk),
    crypto_box_seal_open: (c, pk, sk) => {
      try {
        return real.crypto_box_seal_open(c, pk, sk);
      } catch {
        throw new Error(
          "[react-native-libsodium][crypto_box_seal_open] crypto_box_seal_open failed",
        );
      }
    },
    crypto_generichash: (n, m, k) => real.crypto_generichash(n, m, k),
    crypto_aead_xchacha20poly1305_ietf_encrypt: (m, ad, sn, pn, k) => {
      if (typeof ad !== "string")
        throw notImplemented("crypto_aead_xchacha20poly1305_ietf_encrypt");
      return real.crypto_aead_xchacha20poly1305_ietf_encrypt(m, ad, sn, pn, k);
    },
    crypto_aead_xchacha20poly1305_ietf_decrypt: (sn, c, ad, pn, k) => {
      if (typeof ad !== "string")
        throw notImplemented("crypto_aead_xchacha20poly1305_ietf_decrypt");
      return real.crypto_aead_xchacha20poly1305_ietf_decrypt(sn, c, ad, pn, k);
    },
  };
  const { crypto_box_seal: _s, crypto_box_seal_open: _o, ...defaultExport } = namespace;
  return { namespace, defaultExport };
}

/** The mobile wiring: react-native-libsodium (faked) with the @noble/ciphers AEAD. */
export const mobileSodium: Sodium = fromLibsodium((await fakeReactNativeLibsodium()).namespace, {
  aead: "noble",
});

export const PLAINTEXT_MARKER = "SYNTHETIC-CANARY-merchant-7f3a";

/** Every Sodium backend the frame / wrap / recovery suites run against (`describe.each`). */
export const backends: [string, Sodium][] = [
  ["libsodium-wrappers", sodium],
  ["react-native-libsodium + noble AEAD", mobileSodium],
];

/** Synthetic device ids. */
export const DEVICE_A = "a1".repeat(16);
export const DEVICE_B = "b2".repeat(16);

/** A fixed synthetic gid salt for rings built from raw keys. */
export const GID_SALT = range(0x40, 0x5f);

/** One recovery key shared by the tests that do not need its words. */
export const testRecovery = createRecoveryKey(sodium);

/** The recovery identity behind `testRecovery`: the certificate root for test devices. */
export const testRoot = recoveryIdentity(sodium, testRecovery.phrase);

export function subjectOf(d: DeviceIdentity) {
  return { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.box.publicKey };
}

/** `d` as a wrap recipient: certified by `root` and verified, as S29 will do from stored certificates. */
export function trustedTo(
  d: DeviceIdentity,
  vaultId: string,
  root: { deviceId: string; signPublicKey: Uint8Array } & Parameters<
    typeof certifyDevice
  >[1] = testRoot,
): TrustedDevice {
  const cert = certifyDevice(sodium, root, subjectOf(d), vaultId);
  const device = verifyCertificates(sodium, vaultId, root.signPublicKey, [cert]).devices.get(
    d.deviceId,
  );
  if (!device) throw new Error("certificate did not verify");
  return device;
}

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
