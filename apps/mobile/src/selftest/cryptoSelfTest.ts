// The runtime crypto self-test of the phone. Runs the real @cashu/sync code on the running engine: the Sodium
// known-answer test, a vault with recovery, a frame seal / open plus tamper detection (noble AEAD), a
// sealed box plus the classified wrong-key failure of the native library (sealOpen must say `auth_failed`,
// not `unsupported_runtime`), a KeyStore round trip through the injected secure store and files, and the
// native Ed25519 verification against @noble (`nativeVerify`: the same answer on valid, tampered and
// non-canonical signatures; the vault open verifies every frame head through it).
// No key or plaintext is reported, only check names and pass / fail with an error code.
import { crypto } from "@cashu/sync/engine";

interface CryptoCheck {
  readonly name: CryptoCheckName;
  readonly ok: boolean;
  /** Classified CryptoError code or a fixed self-test outcome (never backend text or a value). */
  readonly code?: string;
}

type CryptoCheckName =
  | "knownAnswer"
  | "vault"
  | "frame"
  | "frameTamper"
  | "sealedBox"
  | "sealedBoxWrongKey"
  | "keyStore"
  | "nativeVerify";

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
  /** The native library's Ed25519 verification (the phone binds it); absent: `nativeVerify` not run. */
  readonly signLib?: crypto.LibsodiumSignLike;
  readonly keyStore: (sodium: crypto.Sodium) => crypto.KeyStore;
}

const codeOf = (
  e: unknown,
  fallback: "unsupported_runtime" | "keystore_unavailable" = "unsupported_runtime",
): string => (e instanceof crypto.CryptoError ? e.code : fallback);

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
    // The phone never shows or reads recovery words: a phrase-free recovery identity (same derivation).
    const recovery = crypto.createRecoveryIdentity(sodium);
    device = crypto.createDeviceIdentity(sodium);
    try {
      ring = crypto.createVaultWithRecovery(sodium, recovery, device).ring;
    } finally {
      recovery.wipe();
    }
    add("vault", undefined);
  } catch (e) {
    add("vault", codeOf(e));
  }

  if (ring && device) {
    const prev = crypto.genesisChain({
      vaultId: ring.vaultId,
      deviceId: device.deviceId,
      stream: 0,
    });
    const ctx = { vaultId: ring.vaultId, deviceId: device.deviceId, segment: 0, offset: 0, prev };
    const plain = sodium.randomBytes(300);
    try {
      const sealed = crypto.sealFrame(sodium, ring, plain, ctx, device);
      const opened = crypto.openFrame(sodium, ring, sealed.bytes, ctx);
      const signed = crypto.verifyHeadSignature(ring.vaultId, opened.head, device.signPublicKey);
      add("frame", equal(opened.plain, plain) && signed ? undefined : "mismatch");
      const tampered = sealed.bytes.slice();
      // The AEAD tag (the last 64 bytes are the head signature).
      tampered[tampered.length - 65] = (tampered[tampered.length - 65] ?? 0) ^ 1;
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
    add("keyStore", codeOf(e, "keystore_unavailable"));
  }

  if (deps.signLib !== undefined) add("nativeVerify", nativeVerifyCheck(deps.signLib, sodium));

  let nativeAead = "supported";
  try {
    crypto.fromLibsodium(deps.lib);
  } catch (e) {
    nativeAead = codeOf(e);
  }
  return { checks, ok: checks.every((c) => c.ok), nativeAead };
}

// The group order L, little endian (S + L is a non-canonical S both implementations must refuse).
const ORDER = Uint8Array.from(
  "edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010".match(/../g) ?? [],
  (b) => Number.parseInt(b, 16),
);

function nonCanonicalS(signature: Uint8Array): Uint8Array {
  const out = signature.slice();
  let carry = 0;
  for (let i = 0; i < 32; i++) {
    const sum = (signature[32 + i] ?? 0) + (ORDER[i] ?? 0) + carry;
    out[32 + i] = sum & 0xff;
    carry = sum >> 8;
  }
  return out;
}

/**
 * The native verifier's known answers (`libsodiumEd25519Verifier`), then the RAW native verify against
 * @noble over fresh signatures: valid, signature changed, message changed, non-canonical S, and a
 * small-order public key (the identity point, R = identity, S = 0: true under the bare cofactorless
 * equation for any message). Any disagreement or throw fails the check (the vault open would then
 * verify differently from the Mac).
 */
function nativeVerifyCheck(
  lib: crypto.LibsodiumSignLike,
  sodium: crypto.Sodium,
): string | undefined {
  let signer: crypto.DeviceIdentity | undefined;
  try {
    crypto.libsodiumEd25519Verifier(lib);
    signer = crypto.createDeviceIdentity(sodium);
    const context = new TextEncoder().encode("cashu/head/v1");
    for (let i = 0; i < 4; i++) {
      const body = sodium.randomBytes(40 + i * 50);
      const message = new Uint8Array(context.length + body.length);
      message.set(context);
      message.set(body, context.length);
      const signature = signer.sign("cashu/head/v1", body);
      const changed = signature.slice();
      changed[i * 9] = (changed[i * 9] ?? 0) ^ 1;
      const otherMessage = message.slice();
      otherMessage[context.length] = (otherMessage[context.length] ?? 0) ^ 1;
      const cases: readonly [Uint8Array, Uint8Array, boolean][] = [
        [signature, message, true],
        [changed, message, false],
        [signature, otherMessage, false],
        [nonCanonicalS(signature), message, false],
      ];
      for (const [sig, msg, expected] of cases) {
        const native = lib.crypto_sign_verify_detached(sig, msg, signer.signPublicKey) === true;
        const noble = crypto.nobleEd25519Verifier.verify(sig, msg, signer.signPublicKey);
        if (native !== noble || noble !== expected) return "mismatch";
      }
      const identityPoint = new Uint8Array(32);
      identityPoint[0] = 1;
      const smallOrderSig = new Uint8Array(64);
      smallOrderSig[0] = 1;
      if (
        lib.crypto_sign_verify_detached(smallOrderSig, message, identityPoint) === true ||
        crypto.nobleEd25519Verifier.verify(smallOrderSig, message, identityPoint)
      )
        return "mismatch";
    }
    return undefined;
  } catch (e) {
    return codeOf(e);
  } finally {
    signer?.wipe();
  }
}
