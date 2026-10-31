import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { describe, expect, it } from "vitest";
import { fromHex, toHex, utf8 } from "./encoding.js";
import { FRAME_HEADER_BYTES, openFrame, sealFrameWithNonce } from "./frame.js";
import { Keyring, KID_BYTES, keyId } from "./keys.js";
import { recoveryKeyPair } from "./recovery.js";
import { Secret } from "./secret.js";
import { ctx, range, sodium } from "./testkit.js";

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
  const ring = () =>
    new Keyring(vaultId, [
      {
        kid: keyId(sodium, new Secret(keyBytes.slice())),
        generation: 1,
        key: new Secret(keyBytes.slice()),
      },
    ]);
  const frameCtx = ctx(vaultId, { deviceId: "device-a", segment: 7, offset: 128 });
  const nonce = range(0xa0, 0xb7);

  it("key id", () => {
    expect(ring().active.kid).toBe("899723a0e010c01f493a2cd684f8e9bd");
    // Same value from an independent BLAKE2b: keyed by the data key, over the fixed context.
    expect(toHex(blake2b(utf8("cashu/kid/v1"), { key: keyBytes, dkLen: 16 }))).toBe(
      ring().active.kid,
    );
  });

  it("frame", () => {
    const frame = sealFrameWithNonce(sodium, ring(), utf8("hello frame"), frameCtx, nonce);
    expect(toHex(frame)).toBe(
      "01899723a0e010c01f493a2cd684f8e9bd" +
        "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7" +
        "2d896671d87dc2de000248c307e4445af9846e0321849ae14257f2",
    );
    expect(openFrame(sodium, ring(), frame, frameCtx)).toEqual(utf8("hello frame"));
  });

  it("an independent implementation (@noble/ciphers, Hermes-safe) opens the frame", () => {
    const frame = sealFrameWithNonce(sodium, ring(), utf8("hello frame"), frameCtx, nonce);
    const kid = frame.subarray(1, 1 + KID_BYTES);
    // AAD spelled out byte by byte from the format comment in frame.ts.
    const aad = new Uint8Array([
      ...utf8("cashu/frame/v1"),
      1,
      ...kid,
      ...[0, 0, 0, 32],
      ...utf8(vaultId),
      ...[0, 0, 0, 8],
      ...utf8("device-a"),
      ...[0, 0, 0, 7],
      ...[0, 0, 0, 0, 0, 0, 0, 128],
    ]);
    const plain = xchacha20poly1305(keyBytes, nonce, aad).decrypt(
      frame.subarray(FRAME_HEADER_BYTES),
    );
    expect(plain).toEqual(utf8("hello frame"));
  });

  it("recovery public key for the all-zero phrase", () => {
    const pair = recoveryKeyPair(sodium, `${"abandon ".repeat(23)}art`);
    expect(toHex(pair.publicKey)).toBe(
      "da2d476f72ff4d7f8288cda2798d64425d089c6dc6f5ca4b8febe473ef17363a",
    );
  });
});
