// The native Ed25519 port against the @noble reference, with libsodium-wrappers (the same C libsodium the
// phone's react-native-libsodium runs) as the native stand-in. The oracle of every vector is @noble strict
// (`zip215: false`), the verifier the hosts have always used; the native port must give its answer on
// valid, tampered, non-canonical, small-order and mixed-order inputs.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindEd25519Verifier,
  ed25519Verifier,
  type LibsodiumSignLike,
  libsodiumEd25519Verifier,
  nobleEd25519Verifier,
} from "./ed25519.js";
import { CryptoError } from "./errors.js";
import { verifySignature } from "./identity.js";

const { default: wrappers } = (await import("libsodium-wrappers")) as unknown as {
  default: LibsodiumSignLike & { ready: Promise<void> };
};
await wrappers.ready;

const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const P = 2n ** 255n - 19n;
const Point = ed25519.Point;
const toNum = (b: Uint8Array): bigint => {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i] ?? 0);
  return n;
};
const toBytes = (n: bigint, length = 32): Uint8Array => {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
/** A signature over `message` for secret scalar `a` (public point `pk`) with nonce `r`, raw. */
function rawSign(a: bigint, pk: Uint8Array, r: bigint, message: Uint8Array): Uint8Array {
  const R = Point.BASE.multiply(r).toBytes();
  const k = toNum(sha512(join(R, pk, message))) % L;
  return join(R, toBytes((r + k * a) % L));
}
function challenge(sig: Uint8Array, pk: Uint8Array, message: Uint8Array): bigint {
  return toNum(sha512(join(sig.subarray(0, 32), pk, message))) % L;
}

interface Vector {
  readonly name: string;
  readonly signature: Uint8Array;
  readonly message: Uint8Array;
  readonly publicKey: Uint8Array;
}

function vectors(): Vector[] {
  const out: Vector[] = [];
  for (let i = 0; i < 6; i++) {
    const seed = Uint8Array.from({ length: 32 }, (_, j) => (i * 31 + j * 7 + 1) & 0xff);
    const publicKey = ed25519.getPublicKey(seed);
    const message = utf8(`synthetic message ${i}`);
    const signature = ed25519.sign(message, seed);
    out.push({ name: `valid ${i}`, signature, message, publicKey });
    const r = signature.slice();
    r[3] = (r[3] ?? 0) ^ 0x10;
    out.push({ name: `tampered R ${i}`, signature: r, message, publicKey });
    const s = signature.slice();
    s[45] = (s[45] ?? 0) ^ 0x01;
    out.push({ name: `tampered S ${i}`, signature: s, message, publicKey });
    out.push({ name: `tampered message ${i}`, signature, message: utf8(`other ${i}`), publicKey });
    const pk = publicKey.slice();
    pk[7] = (pk[7] ?? 0) ^ 0x04;
    out.push({ name: `tampered key ${i}`, signature, message, publicKey: pk });
    const big = signature.slice();
    big.set(toBytes(toNum(signature.subarray(32)) + L), 32);
    out.push({ name: `non-canonical S ${i}`, signature: big, message, publicKey });
  }
  const message = utf8("synthetic edge case");
  const seed = new Uint8Array(32).fill(9);
  const publicKey = ed25519.getPublicKey(seed);
  const signature = ed25519.sign(message, seed);
  out.push({
    name: "non-canonical public key (y = p + 1)",
    signature,
    message,
    publicKey: toBytes(P + 1n),
  });
  const identity = toBytes(1n);
  const forged = join(Point.BASE.multiply(5n).toBytes(), toBytes(5n));
  out.push({ name: "small-order public key", signature: forged, message, publicKey: identity });
  out.push({
    name: "small-order R, S = 0",
    signature: join(identity, new Uint8Array(32)),
    message,
    publicKey,
  });
  out.push({
    name: "non-canonical R (y = p + 1)",
    signature: join(toBytes(P + 1n), signature.subarray(32)),
    message,
    publicKey,
  });
  // A mixed-order key: a prime-order key plus an 8-torsion point (never produced by honest keygen).
  const torsion = Point.fromHex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a");
  const a = 123456789012345678901234567890n % L;
  const mixed = Point.BASE.multiply(a).add(torsion).toBytes();
  let multipleOf8 = 0;
  let other = 0;
  for (let i = 0; i < 400 && (multipleOf8 < 2 || other < 2); i++) {
    const m = utf8(`mixed ${i}`);
    const sig = rawSign(a, mixed, 1000n + BigInt(i), m);
    const k8 = challenge(sig, mixed, m) % 8n === 0n;
    if (k8 && multipleOf8 < 2) {
      multipleOf8 += 1;
      out.push({
        name: `mixed-order key, k = 0 mod 8 (${i})`,
        signature: sig,
        message: m,
        publicKey: mixed,
      });
    } else if (!k8 && other < 2) {
      other += 1;
      out.push({
        name: `mixed-order key, k != 0 mod 8 (${i})`,
        signature: sig,
        message: m,
        publicKey: mixed,
      });
    }
  }
  return out;
}

const raw = (v: Vector) =>
  wrappers.crypto_sign_verify_detached(v.signature, v.message, v.publicKey);
const noble = (v: Vector) => nobleEd25519Verifier.verify(v.signature, v.message, v.publicKey);

afterEach(() => {
  bindEd25519Verifier(nobleEd25519Verifier);
});

describe("Ed25519 verification port", () => {
  it("the native verifier gives @noble's answer on every vector class", () => {
    const native = libsodiumEd25519Verifier(wrappers);
    expect(native.kind).toBe("native");
    const all = vectors();
    expect(all.filter((v) => v.name.startsWith("mixed-order")).length).toBe(4);
    for (const v of all) {
      expect({ name: v.name, verdict: native.verify(v.signature, v.message, v.publicKey) }).toEqual(
        {
          name: v.name,
          verdict: noble(v),
        },
      );
    }
    // The classes hold what they claim (the oracle is not trivially true or false).
    expect(all.filter((v) => v.name.startsWith("valid")).every(noble)).toBe(true);
    expect(all.filter((v) => /tampered|non-canonical|small-order/.test(v.name)).some(noble)).toBe(
      false,
    );
  });

  it("raw libsodium never accepts what @noble refuses, and refuses mixed-order keys @noble accepts", () => {
    const all = vectors();
    for (const v of all)
      if (raw(v)) expect({ name: v.name, noble: noble(v) }).toEqual({ name: v.name, noble: true });
    // The documented divergence the fallback exists for: cofactorless (libsodium) vs cofactored (@noble).
    const divergent = all.filter((v) => noble(v) && !raw(v)).map((v) => v.name);
    expect(divergent.length).toBeGreaterThan(0);
    expect(divergent.every((name) => name.startsWith("mixed-order key, k != 0 mod 8"))).toBe(true);
  });

  it("verifySignature goes through the bound verifier, and back to @noble when restored", () => {
    const [valid] = vectors();
    if (!valid) throw new Error("no vector");
    let calls = 0;
    const counting = libsodiumEd25519Verifier({
      crypto_sign_verify_detached: (s, m, p) => {
        calls += 1;
        return wrappers.crypto_sign_verify_detached(s, m, p);
      },
    });
    const before = calls;
    const previous = bindEd25519Verifier(counting);
    expect(previous.kind).toBe("noble");
    expect(ed25519Verifier()).toBe(counting);
    expect(verifySignature(valid.signature, valid.message, valid.publicKey)).toBe(true);
    expect(calls).toBe(before + 1);
    // Wrong lengths never reach the implementation (the native call reads fixed sizes).
    expect(verifySignature(valid.signature.subarray(1), valid.message, valid.publicKey)).toBe(
      false,
    );
    expect(verifySignature(valid.signature, valid.message, valid.publicKey.subarray(1))).toBe(
      false,
    );
    expect(calls).toBe(before + 1);
    bindEd25519Verifier(previous);
    expect(verifySignature(valid.signature, valid.message, valid.publicKey)).toBe(true);
    expect(calls).toBe(before + 1);
  });

  it("refuses a library without the function or with wrong known answers, a small-order key included", () => {
    const refused = (lib: unknown) => {
      try {
        libsodiumEd25519Verifier(lib as LibsodiumSignLike);
        return "accepted";
      } catch (e) {
        return e instanceof CryptoError ? e.code : "other";
      }
    };
    expect(refused({})).toBe("unsupported_runtime");
    expect(refused({ crypto_sign_verify_detached: () => true })).toBe("unsupported_runtime");
    expect(refused({ crypto_sign_verify_detached: () => false })).toBe("unsupported_runtime");
    expect(
      refused({
        crypto_sign_verify_detached: () => {
          throw new Error("boom");
        },
      }),
    ).toBe("unsupported_runtime");
    // A library right on every other class that skips the small-order key check.
    const identityKey = toBytes(1n);
    const lax = {
      crypto_sign_verify_detached: (s: Uint8Array, m: Uint8Array, p: Uint8Array) =>
        p.every((b, i) => b === identityKey[i]) || wrappers.crypto_sign_verify_detached(s, m, p),
    };
    expect(refused(lax)).toBe("unsupported_runtime");
    expect(refused(wrappers)).toBe("accepted");
  });

  it("checks lengths itself, and answers a native throw like @noble (a forged frame is false)", () => {
    const [valid, tamperedR] = vectors();
    if (!valid || !tamperedR) throw new Error("no vector");
    let calls = 0;
    let broken = false;
    const native = libsodiumEd25519Verifier({
      crypto_sign_verify_detached: (s, m, p) => {
        calls += 1;
        if (broken) throw new Error("native fault");
        return wrappers.crypto_sign_verify_detached(s, m, p);
      },
    });
    const before = calls;
    expect(native.verify(valid.signature.subarray(1), valid.message, valid.publicKey)).toBe(false);
    expect(native.verify(valid.signature, valid.message, valid.publicKey.subarray(1))).toBe(false);
    expect(
      native.verify(join(valid.signature, Uint8Array.of(0)), valid.message, valid.publicKey),
    ).toBe(false);
    expect(calls).toBe(before);
    bindEd25519Verifier(native);
    broken = true;
    expect(verifySignature(valid.signature, valid.message, valid.publicKey)).toBe(true);
    expect(verifySignature(tamperedR.signature, tamperedR.message, tamperedR.publicKey)).toBe(
      false,
    );
    expect(calls).toBe(before + 2);
  });
});
