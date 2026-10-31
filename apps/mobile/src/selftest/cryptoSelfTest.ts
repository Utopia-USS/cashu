// The runtime crypto self-test of the phone (S27 follow-up "confirm react-native-libsodium's failure
// strings on a device build"). Runs the real @cashu/sync code on the running engine: the Sodium
// known-answer test, a vault with recovery, a frame seal / open plus tamper detection (noble AEAD), a
// sealed box plus the wrong-key failure string of the native library (sealOpen must say `auth_failed`,
// not `unsupported_runtime`), and a KeyStore round trip through the injected secure store and files.
// No key or plaintext is reported, only check names and pass / fail with an error code.
import { crypto } from "@cashu/sync";

interface CryptoCheck {
  readonly name: CryptoCheckName;
  readonly ok: boolean;
  /** CryptoError code or error name when the check failed (never a value). */
  readonly code?: string;
}

type CryptoCheckName =
  | "knownAnswer"
  | "vault"
  | "frame"
  | "frameTamper"
  | "sealedBox"
  | "sealedBoxWrongKey"
  | "keyStore";

export interface CryptoSelfTest {
  readonly checks: readonly CryptoCheck[];
  /** Every check passed. */
  readonly ok: boolean;
  /**
   * Informational: building the Sodium with the native library's own AEAD. README: react-native-
   * libsodium 1.7 rejects binary additional data (`unsupported_runtime`), which is why the noble AEAD
   * is wired; "supported" would mean a newer library could drop @noble/ciphers.
   */
  readonly nativeAead: "supported" | string;
}

export interface CryptoSelfTestDeps {
  readonly lib: crypto.LibsodiumLike;
  readonly keyStore: (sodium: crypto.Sodium) => crypto.KeyStore;
}

const codeOf = (e: unknown): string =>
  e instanceof crypto.CryptoError ? e.code : e instanceof Error ? e.name : "unknown";

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Expect `fn` to throw CryptoError(`code`). */
function throwsCode(fn: () => unknown, code: string): string | undefined {
  try {
    fn();
    return "no_error";
  } catch (e) {
    return codeOf(e) === code ? undefined : codeOf(e);
  }
}

const SELFTEST_ITEM = "cashu.selftest.probe";

export async function runCryptoSelfTest(deps: CryptoSelfTestDeps): Promise<CryptoSelfTest> {
  const checks: CryptoCheck[] = [];
  const add = (name: CryptoCheckName, failure: string | undefined) =>
    checks.push(failure === undefined ? { name, ok: true } : { name, ok: false, code: failure });

  let sodium: crypto.Sodium;
  try {
    sodium = crypto.fromLibsodium(deps.lib, { aead: "noble" });
    add("knownAnswer", undefined);
  } catch (e) {
    add("knownAnswer", codeOf(e));
    return { checks, ok: false, nativeAead: "not_run" };
  }

  let ring: crypto.Keyring | undefined;
  let device: crypto.DeviceIdentity | undefined;
  try {
    const recovery = crypto.createRecoveryKey(sodium);
    device = crypto.createDeviceIdentity(sodium);
    const vault = crypto.createVaultWithRecovery(
      sodium,
      crypto.recoveryIdentity(sodium, recovery.phrase),
      device,
    );
    ring = vault.ring;
    add("vault", undefined);
  } catch (e) {
    add("vault", codeOf(e));
  }

  if (ring && device) {
    const ctx = { vaultId: ring.vaultId, deviceId: device.deviceId, segment: 0, offset: 0 };
    const plain = sodium.randomBytes(300);
    try {
      const frame = crypto.sealFrame(sodium, ring, plain, ctx);
      add(
        "frame",
        equal(crypto.openFrame(sodium, ring, frame, ctx), plain) ? undefined : "mismatch",
      );
      const tampered = frame.slice();
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
      add(
        "frameTamper",
        throwsCode(() => crypto.openFrame(sodium, ring, tampered, ctx), "auth_failed"),
      );
    } catch (e) {
      add("frame", codeOf(e));
    }
  }

  try {
    const pair = sodium.boxKeyPair();
    const other = sodium.boxKeyPair();
    const message = sodium.randomBytes(64);
    const box = sodium.seal(message, pair.publicKey);
    add(
      "sealedBox",
      equal(sodium.sealOpen(box, pair.publicKey, pair.privateKey), message)
        ? undefined
        : "mismatch",
    );
    add(
      "sealedBoxWrongKey",
      throwsCode(() => sodium.sealOpen(box, other.publicKey, other.privateKey), "auth_failed"),
    );
  } catch (e) {
    add("sealedBox", codeOf(e));
  }

  try {
    const store = deps.keyStore(sodium);
    const value = sodium.randomBytes(48);
    await store.set(SELFTEST_ITEM, value);
    const back = await store.get(SELFTEST_ITEM);
    await store.delete(SELFTEST_ITEM);
    const gone = await store.get(SELFTEST_ITEM);
    add("keyStore", back && equal(back, value) && gone === null ? undefined : "mismatch");
  } catch (e) {
    add("keyStore", codeOf(e));
  }

  let nativeAead = "supported";
  try {
    crypto.fromLibsodium(deps.lib);
  } catch (e) {
    nativeAead = codeOf(e);
  }
  return { checks, ok: checks.every((c) => c.ok), nativeAead };
}
