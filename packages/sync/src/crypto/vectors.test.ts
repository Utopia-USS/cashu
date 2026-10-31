import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { describe, expect, it } from "vitest";
import { certifyDevice } from "./cert.js";
import { fromHex, toHex, utf8 } from "./encoding.js";
import { FRAME_HEADER_BYTES, openFrame, sealFrameWithNonce } from "./frame.js";
import { createDeviceIdentity, DeviceIdentity } from "./identity.js";
import { encodeKeyPayload, Keyring, KID_BYTES } from "./keys.js";
import { recoveryIdentity } from "./recovery.js";
import { Secret } from "./secret.js";
import { keyringFromKeys } from "./testing.js";
import { ctx, DEVICE_A, GID_SALT, range, sodium, trustedTo } from "./testkit.js";
import { wrapKeys } from "./wrap.js";

describe("published test vectors", () => {
  it("XChaCha20-Poly1305 matches draft-irtf-cfrg-xchacha A.3.1", () => {
    const plain = utf8(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    );
    const cipher = sodium.aeadEncrypt(
      plain,
      fromHex("50515253c0c1c2c3c4c5c6c7"),
      range(0x40, 0x57),
      range(0x80, 0x9f),
    );
    expect(toHex(cipher)).toBe(
      "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39" +
        "ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9" +
        "21f9664c97637da9768812f615c68b13b52e" +
        "c0875924c1c7987947deafd8780acf49",
    );
  });

  it("HKDF-SHA256 matches RFC 5869 test case 1", () => {
    const okm = hkdf(
      sha256,
      new Uint8Array(22).fill(0x0b),
      range(0x00, 0x0c),
      range(0xf0, 0xf9),
      42,
    );
    expect(toHex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  it("BIP39 24-word vectors (all-zero and all-ones entropy)", () => {
    const zero = entropyToMnemonic(new Uint8Array(32), wordlist);
    expect(zero).toBe(`${"abandon ".repeat(23)}art`);
    expect(entropyToMnemonic(new Uint8Array(32).fill(0xff), wordlist)).toBe(
      `${"zoo ".repeat(23)}vote`,
    );
    expect(mnemonicToEntropy(zero, wordlist)).toEqual(new Uint8Array(32));
  });
});

// Frozen outputs of our own formats: a change here is a wire-format break and needs a new version.
describe("cashU format golden vectors", () => {
  const vaultId = "00112233445566778899aabbccddeeff";
  const keyBytes = range(0x00, 0x1f);
  const recovery = recoveryIdentity(sodium, `${"abandon ".repeat(23)}art`);
  const ring = () =>
    keyringFromKeys(sodium, { vaultId, recovery: recovery.publicKeys, gidSalt: GID_SALT }, [
      { generation: 1, epoch: 0, key: keyBytes.slice() },
    ]);
  const frameCtx = ctx(vaultId, { deviceId: DEVICE_A, segment: 7, offset: 128 });
  const nonce = range(0xa0, 0xb7);
  const lp = (text: string) => [0, 0, 0, text.length, ...utf8(text)];

  // Subkeys and kid recomputed with an independent BLAKE2b (@noble/hashes), straight from the spec.
  const frameKey = blake2b(utf8("cashu/subkey/frame/v2"), { key: keyBytes, dkLen: 32 });
  const kidKey = blake2b(utf8("cashu/subkey/kid/v2"), { key: keyBytes, dkLen: 32 });

  it("key id binds key, vault, generation and epoch", () => {
    expect(ring().active.kid).toBe("7bd6215fabb945b83e9fe5c54e25bd1d");
    const message = new Uint8Array([
      ...utf8("cashu/kid/v2"),
      ...lp(vaultId),
      ...[0, 0, 0, 1],
      ...[0, 0, 0, 0],
    ]);
    expect(toHex(blake2b(message, { key: kidKey, dkLen: 16 }))).toBe(ring().active.kid);
  });

  it("key payload v3", () => {
    expect(toHex(encodeKeyPayload(ring()))).toBe(
      toHex(
        new Uint8Array([
          ...utf8("cashu/keys/v3"),
          ...lp(vaultId),
          ...recovery.box.publicKey,
          ...recovery.signPublicKey,
          ...GID_SALT,
          ...[0, 0, 0, 1],
          ...[0, 0, 0, 1],
          ...[0, 0, 0, 0],
          ...keyBytes,
        ]),
      ),
    );
  });

  it("frame", () => {
    const frame = sealFrameWithNonce(sodium, ring(), utf8("hello frame"), frameCtx, nonce);
    expect(toHex(frame)).toBe(
      "027bd6215fabb945b83e9fe5c54e25bd1d" +
        "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7" +
        "305fbd31db6286351d93b9be644b2e26" +
        "3b20b134d1674ab17236387ff34b1c43",
    );
    expect(openFrame(sodium, ring(), frame, frameCtx)).toEqual(utf8("hello frame"));
  });

  it("an independent implementation (@noble/ciphers + @noble/hashes) opens and unpads the frame", () => {
    const frame = sealFrameWithNonce(sodium, ring(), utf8("hello frame"), frameCtx, nonce);
    const kid = frame.subarray(1, 1 + KID_BYTES);
    // AAD spelled out byte by byte from the format comment in frame.ts.
    const aad = new Uint8Array([
      ...utf8("cashu/frame/v2"),
      2,
      ...kid,
      ...lp(vaultId),
      ...lp(DEVICE_A),
      ...[0, 0, 0, 7],
      ...[0, 0, 0, 0, 0, 0, 0, 128],
    ]);
    const plain = xchacha20poly1305(frameKey, nonce, aad).decrypt(
      frame.subarray(FRAME_HEADER_BYTES),
    );
    // u32 length 11 | "hello frame" | zero padding up to Padme(15) = 16.
    expect(plain).toEqual(new Uint8Array([0, 0, 0, 11, ...utf8("hello frame"), 0]));
  });

  it("recovery public keys for the all-zero phrase", () => {
    expect(toHex(recovery.box.publicKey)).toBe(
      "3995c11245ef09988fc498c3e4217994f247cae53caa25d135426b2afea92112",
    );
    expect(toHex(recovery.signPublicKey)).toBe(
      "2fe7005580ffa0bd2297e199d4bbcea847178e26f908dada33397f26a33b932a",
    );
    // Independent derivation: HKDF-SHA256 -> Ed25519 seed (@noble/curves).
    const entropy = new Uint8Array(32);
    const seed = hkdf(sha256, entropy, utf8("cashu/recovery/v2"), utf8("ed25519-seed"), 32);
    expect(ed25519.getPublicKey(seed)).toEqual(recovery.signPublicKey);
  });

  it("device certificate (deterministic Ed25519), checked with @noble/curves", () => {
    const device = new DeviceIdentity(
      DEVICE_A,
      new Secret(range(0x20, 0x3f)),
      new Secret(range(0x60, 0x7f)),
    );
    expect(toHex(device.box.publicKey)).toBe(toHex(x25519.getPublicKey(range(0x20, 0x3f))));
    expect(toHex(device.signPublicKey)).toBe(toHex(ed25519.getPublicKey(range(0x60, 0x7f))));
    const subject = {
      deviceId: device.deviceId,
      signPublicKey: device.signPublicKey,
      boxPublicKey: device.box.publicKey,
    };
    const cert = certifyDevice(sodium, recovery, subject, vaultId);
    expect(toHex(cert)).toBe(
      "01" +
        "00000000000000000000000000000000" +
        "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1" +
        "174553b456dddfc6908ecab1c101fe6ab21e2baa0617795b7d43a63482993fd5" +
        "358072d6365880d1aeea329adf9121383851ed21a28e3b75e965d0d2cd166254" +
        "c18ebd3bc96125700ff5dc2f8415b52d65dbd8d231c433ddf568660ebbec130e" +
        "8b6f102d2341fc31ff6c0d73f0ba0f3b60ee818e27d6b20fb4baad13774e9006",
    );
    const signed = new Uint8Array([
      ...utf8("cashu/cert/v1"),
      ...lp(vaultId),
      ...cert.subarray(1, 1 + 16 + 16 + 32 + 32),
    ]);
    expect(
      ed25519.verify(cert.subarray(97), signed, recovery.signPublicKey, { zip215: false }),
    ).toBe(true);
  });

  it("signed wrap layout, verified with @noble/curves from the README format", () => {
    const sender = new DeviceIdentity(
      DEVICE_A,
      new Secret(range(0x20, 0x3f)),
      new Secret(range(0x60, 0x7f)),
    );
    const phone = createDeviceIdentity(sodium);
    const wire = wrapKeys(sodium, ring(), sender, trustedTo(phone, vaultId, recovery));
    expect(wire[0]).toBe(3);
    expect(toHex(wire.subarray(1, 17))).toBe(DEVICE_A);
    const signature = wire.subarray(17, 81);
    expect(toHex(wire.subarray(81, 83 + 16))).toBe(`0001${phone.deviceId}`);
    const sealed = wire.subarray(83 + 16);
    const message = new Uint8Array([
      ...utf8("cashu/wrap/v3"),
      ...lp(vaultId),
      ...fromHex(DEVICE_A),
      ...fromHex(phone.deviceId),
      ...phone.box.publicKey,
      0,
      1,
      ...fromHex(phone.deviceId),
      ...sealed,
    ]);
    expect(ed25519.verify(signature, message, sender.signPublicKey, { zip215: false })).toBe(true);
  });
});
