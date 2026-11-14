import { describe, expect, it } from "vitest";
import {
  anyEpoch,
  ctx,
  fakeReactNativeLibsodium,
  mobileSodium,
  newRing,
  samplePlain,
  sodium,
  trustedTo,
  writerOf,
} from "../testing/crypto/testkit.js";
import { CryptoError } from "./errors.js";
import { openFrame, sealFrame } from "./frame.js";
import { createDeviceIdentity } from "./identity.js";
import { fromLibsodium, type LibsodiumLike, loadNodeSodium } from "./sodium.js";
import { unwrapKeys, wrapKeys } from "./wrap.js";

function runtimeCode(fn: () => unknown): string {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof CryptoError ? e.code : `other: ${String(e)}`;
  }
}

describe("runtimes", () => {
  it("react-native-libsodium's default export lacks the sealed box: unsupported_runtime", async () => {
    const fake = await fakeReactNativeLibsodium();
    expect(runtimeCode(() => fromLibsodium(fake.defaultExport as LibsodiumLike))).toBe(
      "unsupported_runtime",
    );
  });

  it("its AEAD rejects binary AAD: the self-test refuses it instead of reporting tampering later", async () => {
    const fake = await fakeReactNativeLibsodium();
    expect(runtimeCode(() => fromLibsodium(fake.namespace))).toBe("unsupported_runtime");
    expect(runtimeCode(() => fromLibsodium(fake.namespace, { aead: "noble" }))).toBe("no error");
  });

  it("frames and wraps interoperate both ways between the Node and the mobile backend", () => {
    const ring = newRing();
    const c = ctx(ring.vaultId);
    expect(
      openFrame(mobileSodium, ring, sealFrame(sodium, ring, samplePlain(), c, writerOf(c)).bytes, c)
        .plain,
    ).toEqual(samplePlain());
    expect(
      openFrame(sodium, ring, sealFrame(mobileSodium, ring, samplePlain(), c, writerOf(c)).bytes, c)
        .plain,
    ).toEqual(samplePlain());
    const desktop = createDeviceIdentity(sodium);
    const phone = createDeviceIdentity(mobileSodium);
    const phoneRing = ring.clone(mobileSodium);
    const wire = wrapKeys(sodium, ring, desktop, trustedTo(phone, ring.vaultId));
    const trust = () => desktop.signPublicKey;
    expect(unwrapKeys(mobileSodium, wire, phone, phoneRing, trust, anyEpoch).senderDeviceId).toBe(
      desktop.deviceId,
    );
    const back = wrapKeys(mobileSodium, phoneRing, phone, trustedTo(desktop, phoneRing.vaultId));
    expect(
      unwrapKeys(sodium, back, desktop, ring, () => phone.signPublicKey, anyEpoch).ring.size,
    ).toBe(1);
  });

  it("the Node loader with the noble AEAD passes the self-test", async () => {
    const noble = await loadNodeSodium({ aead: "noble" });
    const ring = newRing();
    const c = ctx(ring.vaultId);
    expect(
      openFrame(noble, ring, sealFrame(sodium, ring, samplePlain(), c, writerOf(c)).bytes, c).plain,
    ).toEqual(samplePlain());
  });

  it("F7: a zero or repeating RNG fails the self-test", async () => {
    const fake = await fakeReactNativeLibsodium();
    const zero = { ...fake.namespace, randombytes_buf: (n: number) => new Uint8Array(n) };
    const fixed = sodium.randomBytes(32);
    const repeating = { ...fake.namespace, randombytes_buf: (n: number) => fixed.slice(0, n) };
    for (const lib of [zero, repeating]) {
      expect(runtimeCode(() => fromLibsodium(lib, { aead: "noble" }))).toBe("unsupported_runtime");
    }
  });

  // Failure classification by kind (iOS / Android / unknown shapes, a runtime broken after startup):
  // sodium.classify.test.ts.

  it("a primitive that returns wrong answers fails the self-test", async () => {
    const fake = await fakeReactNativeLibsodium();
    const broken: [string, Partial<LibsodiumLike>][] = [
      ["seed keypair", { crypto_box_seed_keypair: () => fake.namespace.crypto_box_keypair() }],
      [
        "unkeyed hash",
        { crypto_generichash: (n, m) => fake.namespace.crypto_generichash(n, m, null) },
      ],
      ["seal open that never fails", { crypto_box_seal_open: () => new Uint8Array(0) }],
    ];
    for (const [, patch] of broken) {
      expect(
        runtimeCode(() => fromLibsodium({ ...fake.namespace, ...patch }, { aead: "noble" })),
      ).toBe("unsupported_runtime");
    }
  });
});
