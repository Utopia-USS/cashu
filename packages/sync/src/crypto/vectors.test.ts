import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { ctx, DEVICE_A, GID_SALT, range, sodium, trustedTo } from "../testing/crypto/testkit.js";
import { certifyDevice } from "./cert.js";
import { fromHex, toHex, utf8 } from "./encoding.js";
import { openFrame, sealFrameWithNonce } from "./frame.js";
import { createDeviceIdentity, DeviceIdentity } from "./identity.js";
import { encodeKeyPayload } from "./keys.js";
import { recoveryIdentity } from "./recovery.js";
import { Secret } from "./secret.js";
import { keyringFromKeys } from "./testing.js";
import { wrapKeys } from "./wrap.js";

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

  // Subkey and kid recomputed with an independent BLAKE2b (@noble/hashes), straight from the spec.
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

  // The writer of the vector frame: fixed seeds, so its Ed25519 signatures are fixed too.
  const writer = () =>
    new DeviceIdentity(DEVICE_A, new Secret(range(0x10, 0x2f)), new Secret(range(0x30, 0x4f)));
  it("chain genesis (data stream)", () => {
    expect(toHex(frameCtx.prev)).toBe(
      "d0cbaf449fc4e5df4f83c13ca9a25a9bf075a29cb8b7453cc33eeb48475085ae",
    );
    // Spelled out from head.ts with an independent BLAKE2b.
    const genesis = blake2b(
      new Uint8Array([...utf8("cashu/chain/v1/genesis"), ...lp(vaultId), ...lp(DEVICE_A), 1]),
      { dkLen: 32 },
    );
    expect(toHex(genesis)).toBe(toHex(frameCtx.prev));
  });

  it("frame v3", () => {
    const sealed = sealFrameWithNonce(
      sodium,
      ring(),
      utf8("hello frame"),
      frameCtx,
      writer(),
      nonce,
    );
    expect(toHex(sealed.bytes)).toBe(
      "037bd6215fabb945b83e9fe5c54e25bd1d" +
        "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7" +
        "305fbd31db6286351d93b9be644b2e26" +
        "00b0471a5c719e34910c5963a67f65f2" +
        "2b658677417a3a9469938b728262ecef4d7f6df46fcb349ff273967a3b794f72393ba0a0e632d089fe47f2db923ec0f59879de70f300076e2a2e9ca939761005",
    );
    expect(toHex(sealed.head.chain)).toBe(
      "2889ba2527caea771a56edc4ea96f7dbf02ceb79d9388c00a9a2efa746405c6e",
    );
    const opened = openFrame(sodium, ring(), sealed.bytes, frameCtx);
    expect(opened.plain).toEqual(utf8("hello frame"));
    expect(toHex(opened.head.chain)).toBe(toHex(sealed.head.chain));
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
