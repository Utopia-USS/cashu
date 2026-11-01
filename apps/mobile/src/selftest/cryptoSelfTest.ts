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

/**
 * Which of the library's primitives are missing or throw on valid input (names only), so a failed
 * known-answer test says where the runtime breaks. Random inputs, never reported.
 */
function brokenPrimitives(lib: crypto.LibsodiumLike): string[] {
  const out: string[] = [];
  const probe = (name: string, fn: () => unknown) => {
    try {
      const v = fn();
      if (!(v instanceof Uint8Array) && !(typeof v === "object" && v !== null))
        out.push(`${name} (bad result)`);
    } catch (e) {
      out.push(`${name} (${e instanceof Error ? e.name : typeof e})`);
    }
  };
  const probeValue = (name: string, expected: string, fn: () => string) => {
    try {
      if (fn() !== expected) out.push(`${name} (wrong value)`);
    } catch (e) {
      out.push(`${name} (${e instanceof Error ? e.name : typeof e})`);
    }
  };
  const seed = new Uint8Array(32).fill(7);
  probe("randombytes_buf", () => lib.randombytes_buf(32));
  probe("crypto_box_keypair", () => lib.crypto_box_keypair());
  probe("crypto_box_seed_keypair", () => lib.crypto_box_seed_keypair(seed));
  probe("crypto_generichash", () => lib.crypto_generichash(32, seed, null));
  probe("crypto_generichash (keyed)", () => lib.crypto_generichash(32, seed, seed));
  probe("crypto_box_seal", () =>
    lib.crypto_box_seal(seed, lib.crypto_box_seed_keypair(seed).publicKey),
  );
  probe("crypto_box_seal_open", () => {
    const kp = lib.crypto_box_seed_keypair(seed);
    return lib.crypto_box_seal_open(
      lib.crypto_box_seal(seed, kp.publicKey),
      kp.publicKey,
      kp.privateKey,
    );
  });
  try {
    const a = lib.randombytes_buf(32);
    const b = lib.randombytes_buf(32);
    if (a.length !== 32 || b.length !== 32) out.push("randombytes_buf (wrong length)");
    else if (a.every((x, i) => x === b[i])) out.push("randombytes_buf (two draws equal)");
    else if (a.every((x) => x === 0) || b.every((x) => x === 0)) out.push("randombytes_buf (zero)");
  } catch (e) {
    out.push(`randombytes_buf (${e instanceof Error ? e.name : typeof e})`);
  }
  // Known answers the library must reproduce (public test values, the same as the Sodium self-test).
  const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const zeroSeedPublic = "5bf55c73b82ebe22be80f3430667af570fae2556a6415e6b30d4065300aa947d";
  probeValue("crypto_box_seed_keypair (zero seed)", zeroSeedPublic, () =>
    hexOf(lib.crypto_box_seed_keypair(new Uint8Array(32)).publicKey),
  );
  const keyedHash = "0a77bc9f206ab9767fc28bd7b79e0336c6a006df046573a09c0b208225a6c19f";
  probeValue("crypto_generichash (known answer)", keyedHash, () =>
    hexOf(
      lib.crypto_generichash(
        32,
        new TextEncoder().encode("cashu/selftest"),
        Uint8Array.from({ length: 32 }, (_, i) => i),
      ),
    ),
  );
  try {
    const kp = lib.crypto_box_seed_keypair(seed);
    const box = lib.crypto_box_seal(seed, kp.publicKey);
    box[box.length - 1] = (box[box.length - 1] ?? 0) ^ 1;
    lib.crypto_box_seal_open(box, kp.publicKey, kp.privateKey);
    out.push("crypto_box_seal_open (opened a tampered box)");
  } catch (e) {
    if (!KNOWN_SEAL_FAILURES.has(e instanceof Error ? e.message : String(e))) {
      out.push(`tampered seal_open failure "${firstLine(e)}"`);
    }
  }
  // The self-test maps the library's exact "does not authenticate" message to auth_failed; report a
  // message it does not know (library text only, no data).
  try {
    const kp = lib.crypto_box_seed_keypair(seed);
    const other = lib.crypto_box_seed_keypair(new Uint8Array(32).fill(9));
    lib.crypto_box_seal_open(
      lib.crypto_box_seal(seed, kp.publicKey),
      other.publicKey,
      other.privateKey,
    );
    out.push("crypto_box_seal_open (opened with the wrong key)");
  } catch (e) {
    if (!KNOWN_SEAL_FAILURES.has(e instanceof Error ? e.message : String(e))) {
      out.push(`crypto_box_seal_open failure "${firstLine(e)}"`);
    }
  }
  return out;
}

/** The first line of an error message (JSI wraps host errors with a stack; never data). */
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";

const KNOWN_SEAL_FAILURES = new Set([
  "incorrect key pair for the given ciphertext",
  "[react-native-libsodium][crypto_box_seal_open] crypto_box_seal_open failed",
]);

export async function runCryptoSelfTest(deps: CryptoSelfTestDeps): Promise<CryptoSelfTest> {
  const checks: CryptoCheck[] = [];
  const add = (name: CryptoCheckName, failure: string | undefined) =>
    checks.push(failure === undefined ? { name, ok: true } : { name, ok: false, code: failure });

  let sodium: crypto.Sodium;
  try {
    sodium = crypto.fromLibsodium(deps.lib, { aead: "noble" });
    add("knownAnswer", undefined);
  } catch (e) {
    const broken = brokenPrimitives(deps.lib);
    add("knownAnswer", broken.length ? `${codeOf(e)}: ${broken.join(", ")}` : codeOf(e));
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
