// The AEAD failure path computes only the tag (S29c-B3): `aeadAuthentic` must agree with a reference
// XChaCha20-Poly1305 open on every input, and must never run the cipher over the frame body (a
// tampered 64 MiB frame used to cost a full decrypt plus a re-encrypt and two body-sized buffers).
// The classification semantics and fail-closed behaviour of `sodium.ts` are unchanged (its own tests).

import { describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ streamLengths: [] as number[], aeadCalls: 0 }));

vi.mock("@noble/ciphers/chacha.js", async (load) => {
  const real = await load<typeof import("@noble/ciphers/chacha.js")>();
  return {
    ...real,
    xchacha20: ((...args: Parameters<typeof real.xchacha20>) => {
      seen.streamLengths.push(args[2].length);
      return real.xchacha20(...args);
    }) as typeof real.xchacha20,
    xchacha20poly1305: ((...args: Parameters<typeof real.xchacha20poly1305>) => {
      seen.aeadCalls += 1;
      return real.xchacha20poly1305(...args);
    }) as typeof real.xchacha20poly1305,
  };
});

const { xchacha20poly1305 } = await import("@noble/ciphers/chacha.js");
const { aeadAuthentic } = await import("./verify.js");
const { openFrame, sealFrame } = await import("./frame.js");
const { CryptoError } = await import("./errors.js");
const { backends, ctx, newRing, writerOf } = await import("./testkit.js");

function bytes(n: number, seed: number): Uint8Array {
  let x = seed >>> 0 || 1;
  return Uint8Array.from({ length: n }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x & 0xff;
  });
}

function reference(cipher: Uint8Array, aad: Uint8Array, nonce: Uint8Array, key: Uint8Array) {
  try {
    xchacha20poly1305(key, nonce, aad).decrypt(cipher);
    return true;
  } catch {
    return false;
  }
}

describe("tag-only AEAD verify path", () => {
  it("agrees with a reference open on valid, tampered and misbound inputs", () => {
    for (const [i, size] of [0, 1, 15, 16, 17, 63, 64, 65, 255, 1000].entries()) {
      for (const aadSize of [0, 5, 16, 40]) {
        const key = bytes(32, 7 + i);
        const nonce = bytes(24, 11 + i);
        const aad = bytes(aadSize, 13 + i);
        const cipher = xchacha20poly1305(key, nonce, aad).encrypt(bytes(size, 17 + i));
        expect(aeadAuthentic(cipher, aad, nonce, key)).toBe(true);
        for (const at of [0, Math.floor(cipher.length / 2), cipher.length - 1]) {
          const tampered = cipher.slice();
          tampered[at] = (tampered[at] ?? 0) ^ 0x40;
          expect(aeadAuthentic(tampered, aad, nonce, key)).toBe(
            reference(tampered, aad, nonce, key),
          );
          expect(aeadAuthentic(tampered, aad, nonce, key)).toBe(false);
        }
        const otherAad = aad.length > 0 ? aad.slice(1) : Uint8Array.of(1);
        expect(aeadAuthentic(cipher, otherAad, nonce, key)).toBe(false);
        expect(aeadAuthentic(cipher, aad, bytes(24, 99), key)).toBe(false);
        expect(aeadAuthentic(cipher, aad, nonce, bytes(32, 98))).toBe(false);
      }
    }
  });

  it("never runs the cipher over the body of a tampered frame", () => {
    const key = bytes(32, 1);
    const nonce = bytes(24, 2);
    const aad = bytes(30, 3);
    const cipher = xchacha20poly1305(key, nonce, aad).encrypt(bytes(1024 * 1024, 4));
    cipher[100] = (cipher[100] ?? 0) ^ 1;
    seen.streamLengths.length = 0;
    seen.aeadCalls = 0;
    expect(aeadAuthentic(cipher, aad, nonce, key)).toBe(false);
    expect(seen.aeadCalls).toBe(0);
    expect(Math.max(0, ...seen.streamLengths)).toBeLessThanOrEqual(32);
  });

  it.each(backends)("a tampered frame still fails closed as auth_failed (%s)", (_name, sodium) => {
    const ring = newRing(sodium);
    const c = ctx(ring.vaultId);
    const sealed = sealFrame(sodium, ring, bytes(256 * 1024, 5), c, writerOf(c));
    const tampered = sealed.bytes.slice();
    const at = Math.floor(tampered.length / 2);
    tampered[at] = (tampered[at] ?? 0) ^ 1;
    let error: unknown;
    try {
      openFrame(sodium, ring, tampered, c);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as InstanceType<typeof CryptoError>).code).toBe("auth_failed");
  });
});
