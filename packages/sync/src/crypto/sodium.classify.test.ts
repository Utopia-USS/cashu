// How an authenticated open's failure is classified: by its kind and the verify paths, never by the
// message. Fake backends reproduce react-native-libsodium's iOS shape (its plain message), its Android
// shape (the message wrapped by JSI as "Exception in HostFunction: ..." with a stack) and unknown
// shapes; a planted unknown shape must never become auth_failed.

import { describe, expect, it } from "vitest";
import { CryptoError } from "./errors.js";
import { fromLibsodium, type LibsodiumLike, type SodiumOptions } from "./sodium.js";
import { code, fakeReactNativeLibsodium, sodium } from "./testkit.js";
import { aeadAuthentic, sealAuthentic } from "./verify.js";

type Decrypt = NonNullable<LibsodiumLike["crypto_aead_xchacha20poly1305_ietf_decrypt"]>;
type Shape = (fn: string) => unknown;

const { default: wrappers } = (await import("libsodium-wrappers")) as unknown as {
  default: Required<LibsodiumLike>;
};
const rn = (await fakeReactNativeLibsodium()).namespace;

const RN_PREFIX = (fn: string) => `[react-native-libsodium][${fn}] ${fn} failed`;
const ios: Shape = (fn) => new Error(RN_PREFIX(fn));
const android: Shape = (fn) =>
  new Error(
    `Exception in HostFunction: ${RN_PREFIX(fn)}\n\nError: ${RN_PREFIX(fn)}\n    at seal (native)`,
  );

class BindingError extends Error {}
const UNKNOWN: [string, Shape][] = [
  ["TypeError", () => new TypeError("Cannot read properties of undefined")],
  ["RangeError", () => new RangeError("offset out of bounds")],
  ["an Error subclass", (fn) => new BindingError(RN_PREFIX(fn))],
  ["a string", (fn) => RN_PREFIX(fn)],
  ["a plain object with a code", () => ({ code: "EAUTH", message: "authentication failed" })],
  ["undefined", () => undefined],
  ["null", () => null],
];

/**
 * A backend whose seal_open and AEAD decrypt throw `shape(...)` instead of the real error whenever
 * `planted()` holds; otherwise they behave as react-native-libsodium (iOS wording).
 */
function shaped(shape: Shape, planted: () => boolean = () => true): LibsodiumLike {
  const decrypt = wrappers.crypto_aead_xchacha20poly1305_ietf_decrypt as Decrypt;
  return {
    ...rn,
    crypto_aead_xchacha20poly1305_ietf_encrypt: wrappers.crypto_aead_xchacha20poly1305_ietf_encrypt,
    crypto_aead_xchacha20poly1305_ietf_decrypt: (sn, c, ad, pn, k) => {
      try {
        return decrypt(sn, c, ad, pn, k);
      } catch (e) {
        throw planted() ? shape("crypto_aead_xchacha20poly1305_ietf_decrypt") : e;
      }
    },
    crypto_box_seal_open: (c, pk, sk) => {
      try {
        return wrappers.crypto_box_seal_open(c, pk, sk);
      } catch {
        throw planted() ? shape("crypto_box_seal_open") : ios("crypto_box_seal_open");
      }
    },
  };
}

function startup(lib: LibsodiumLike, options?: SodiumOptions): string {
  try {
    fromLibsodium(lib, options);
    return "no error";
  } catch (e) {
    return e instanceof CryptoError ? e.code : `other: ${String(e)}`;
  }
}

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const NONCE = Uint8Array.from({ length: 24 }, (_, i) => 0x30 + i);
const AAD = Uint8Array.of(0x00, 0xff, 0x10);
const PLAIN = new TextEncoder().encode("SYNTHETIC classify test");

function tamper(bytes: Uint8Array, at = 0): Uint8Array {
  const out = bytes.slice();
  out[at] = (out[at] ?? 0) ^ 1;
  return out;
}

const OPTIONS: [string, SodiumOptions][] = [
  ["libsodium AEAD", {}],
  ["noble AEAD", { aead: "noble" }],
];

describe.each([
  ["iOS shape (plain message)", ios],
  ["Android shape (HostFunction-wrapped message)", android],
])("react-native-libsodium, %s", (_name, shape) => {
  it.each(OPTIONS)("passes the self-test (%s)", (_o, options) => {
    expect(startup(shaped(shape), options)).toBe("no error");
  });

  it.each(OPTIONS)("a tampered or wrong-key decrypt is auth_failed (%s)", (_o, options) => {
    const s = fromLibsodium(shaped(shape), options);
    const cipher = s.aeadEncrypt(PLAIN, AAD, NONCE, KEY);
    expect(s.aeadDecrypt(cipher, AAD, NONCE, KEY)).toEqual(PLAIN);
    expect(code(() => s.aeadDecrypt(tamper(cipher), AAD, NONCE, KEY))).toBe("auth_failed");
    expect(code(() => s.aeadDecrypt(tamper(cipher, cipher.length - 1), AAD, NONCE, KEY))).toBe(
      "auth_failed",
    );
    expect(code(() => s.aeadDecrypt(cipher, tamper(AAD), NONCE, KEY))).toBe("auth_failed");
    expect(code(() => s.aeadDecrypt(cipher, AAD, NONCE, tamper(KEY)))).toBe("auth_failed");
  });

  it("a tampered box or the wrong key pair is auth_failed from sealOpen", () => {
    const s = fromLibsodium(shaped(shape), { aead: "noble" });
    const me = s.boxKeyPair();
    const other = s.boxKeyPair();
    const box = s.seal(PLAIN, me.publicKey);
    expect(s.sealOpen(box, me.publicKey, me.privateKey)).toEqual(PLAIN);
    for (const at of [0, 31, 32, 47, box.length - 1]) {
      expect(code(() => s.sealOpen(tamper(box, at), me.publicKey, me.privateKey))).toBe(
        "auth_failed",
      );
    }
    expect(code(() => s.sealOpen(box, other.publicKey, other.privateKey))).toBe("auth_failed");
    expect(code(() => s.sealOpen(box, other.publicKey, me.privateKey))).toBe("auth_failed");
  });
});

describe("unknown error shapes never become auth_failed", () => {
  it.each(UNKNOWN)("%s fails the self-test closed, on both AEAD paths", (_name, shape) => {
    for (const [, options] of OPTIONS) {
      expect(startup(shaped(shape), options)).toBe("unsupported_runtime");
    }
  });

  it.each(UNKNOWN)(
    "%s planted after startup: tampered decrypt and wrong-key sealOpen are unsupported_runtime",
    (_name, shape) => {
      let planted = false;
      const s = fromLibsodium(
        shaped(shape, () => planted),
        {},
      );
      const me = s.boxKeyPair();
      const cipher = s.aeadEncrypt(PLAIN, AAD, NONCE, KEY);
      const box = s.seal(PLAIN, me.publicKey);
      planted = true;
      expect(code(() => s.aeadDecrypt(tamper(cipher), AAD, NONCE, KEY))).toBe(
        "unsupported_runtime",
      );
      expect(code(() => s.sealOpen(tamper(box), me.publicKey, me.privateKey))).toBe(
        "unsupported_runtime",
      );
      expect(code(() => s.sealOpen(box, s.boxKeyPair().publicKey, me.privateKey))).toBe(
        "unsupported_runtime",
      );
    },
  );
});

describe("a plain Error from a broken runtime is never auth_failed", () => {
  it("a runtime that throws for every open (even known-good input) is unsupported_runtime", () => {
    let broken = false;
    const lib: LibsodiumLike = {
      ...shaped(android),
      crypto_aead_xchacha20poly1305_ietf_decrypt: (sn, c, ad, pn, k) => {
        if (broken) throw android("crypto_aead_xchacha20poly1305_ietf_decrypt");
        return (wrappers.crypto_aead_xchacha20poly1305_ietf_decrypt as Decrypt)(sn, c, ad, pn, k);
      },
      crypto_box_seal_open: (c, pk, sk) => {
        if (broken) throw new Error("input type not yet implemented");
        return wrappers.crypto_box_seal_open(c, pk, sk);
      },
    };
    const s = fromLibsodium(lib);
    const me = s.boxKeyPair();
    const cipher = s.aeadEncrypt(PLAIN, AAD, NONCE, KEY);
    const box = s.seal(PLAIN, me.publicKey);
    broken = true;
    expect(code(() => s.aeadDecrypt(tamper(cipher), AAD, NONCE, KEY))).toBe("unsupported_runtime");
    expect(code(() => s.sealOpen(tamper(box), me.publicKey, me.privateKey))).toBe(
      "unsupported_runtime",
    );
  });

  it("a runtime that throws on authentic input is unsupported_runtime (the verify path says authentic)", () => {
    const victim: { cipher: Uint8Array; box: Uint8Array } = {
      cipher: new Uint8Array(0),
      box: new Uint8Array(0),
    };
    const lib: LibsodiumLike = {
      ...shaped(android),
      crypto_aead_xchacha20poly1305_ietf_decrypt: (sn, c, ad, pn, k) => {
        if (c.length === victim.cipher.length && c.every((b, i) => b === victim.cipher[i])) {
          throw new Error("ciphertext cannot be decrypted using that key");
        }
        return (wrappers.crypto_aead_xchacha20poly1305_ietf_decrypt as Decrypt)(sn, c, ad, pn, k);
      },
      crypto_box_seal_open: (c, pk, sk) => {
        if (c.length === victim.box.length && c.every((b, i) => b === victim.box[i])) {
          throw android("crypto_box_seal_open");
        }
        return wrappers.crypto_box_seal_open(c, pk, sk);
      },
    };
    const s = fromLibsodium(lib);
    const me = s.boxKeyPair();
    victim.cipher = s.aeadEncrypt(PLAIN, AAD, NONCE, KEY);
    victim.box = s.seal(PLAIN, me.publicKey);
    expect(code(() => s.aeadDecrypt(victim.cipher, AAD, NONCE, KEY))).toBe("unsupported_runtime");
    expect(code(() => s.sealOpen(victim.box, me.publicKey, me.privateKey))).toBe(
      "unsupported_runtime",
    );
  });

  it("malformed keys or nonces are unsupported_runtime, not auth_failed", () => {
    const s = fromLibsodium(shaped(android));
    const cipher = s.aeadEncrypt(PLAIN, AAD, NONCE, KEY);
    expect(code(() => s.aeadDecrypt(cipher, AAD, NONCE, KEY.subarray(1)))).toBe(
      "unsupported_runtime",
    );
    expect(code(() => s.aeadDecrypt(cipher, AAD, NONCE.subarray(1), KEY))).toBe(
      "unsupported_runtime",
    );
    const me = s.boxKeyPair();
    const box = s.seal(PLAIN, me.publicKey);
    expect(code(() => s.sealOpen(box, me.publicKey.subarray(1), me.privateKey))).toBe(
      "unsupported_runtime",
    );
  });
});

describe("verify paths agree with libsodium", () => {
  it("aeadAuthentic: true for libsodium's ciphertext, false for any flipped byte or wrong input", () => {
    const cipher = sodium.aeadEncrypt(PLAIN, AAD, NONCE, KEY);
    expect(aeadAuthentic(cipher, AAD, NONCE, KEY)).toBe(true);
    for (let at = 0; at < cipher.length; at += 5) {
      expect(aeadAuthentic(tamper(cipher, at), AAD, NONCE, KEY)).toBe(false);
    }
    expect(aeadAuthentic(cipher, tamper(AAD), NONCE, KEY)).toBe(false);
    expect(aeadAuthentic(cipher, AAD, tamper(NONCE), KEY)).toBe(false);
    expect(aeadAuthentic(cipher, AAD, NONCE, tamper(KEY))).toBe(false);
    const empty = sodium.aeadEncrypt(new Uint8Array(0), new Uint8Array(0), NONCE, KEY);
    expect(aeadAuthentic(empty, new Uint8Array(0), NONCE, KEY)).toBe(true);
  });

  it("sealAuthentic: true for libsodium's sealed box, false when tampered or for another key pair", () => {
    const me = sodium.boxKeyPair();
    const other = sodium.boxKeyPair();
    const box = sodium.seal(PLAIN, me.publicKey);
    expect(sealAuthentic(box, me.publicKey, me.privateKey)).toBe(true);
    for (let at = 0; at < box.length; at += 7) {
      expect(sealAuthentic(tamper(box, at), me.publicKey, me.privateKey)).toBe(false);
    }
    expect(sealAuthentic(box, other.publicKey, other.privateKey)).toBe(false);
    const empty = sodium.seal(new Uint8Array(0), me.publicKey);
    expect(sealAuthentic(empty, me.publicKey, me.privateKey)).toBe(true);
  });

  it("a low-order ephemeral key: libsodium refuses it, the verify path says false, sealOpen is auth_failed", () => {
    const me = sodium.boxKeyPair();
    const s = fromLibsodium(shaped(android), { aead: "noble" });
    const order8 = Uint8Array.from(
      "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800".match(/../g) ?? [],
      (b) => Number.parseInt(b, 16),
    );
    const p = new Uint8Array(32).fill(0xff);
    p[0] = 0xed;
    p[31] = 0x7f;
    for (const ephemeral of [new Uint8Array(32), order8, p]) {
      const box = new Uint8Array(48 + PLAIN.length);
      box.set(ephemeral);
      expect(() => wrappers.crypto_box_seal_open(box, me.publicKey, me.privateKey)).toThrow();
      expect(sealAuthentic(box, me.publicKey, me.privateKey)).toBe(false);
      expect(code(() => s.sealOpen(box, me.publicKey, me.privateKey))).toBe("auth_failed");
    }
  });
});
