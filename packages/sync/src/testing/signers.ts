// Signing identities for carrier tests over the production codec (`createOwnLogCodec`): one device
// identity per device id, created on first use, and a gate that verifies heads with exactly those
// keys. It stands in for the device registry in tests about transports and carriers, which need
// signed frames but not pairing (devices/gate.ts is the production gate). Tests only.
import type { DeviceId, FrameCodec, FrameGate } from "../carrier.js";
import { createOwnLogCodec } from "../carriers/ownlog/codec.js";
import {
  createDeviceIdentity,
  type DeviceIdentity,
  type Keyring,
  type Sodium,
  verifyHeadSignature,
} from "../crypto/index.js";

export interface TestSigners {
  /** The codec of `device`: the shared ring (or `ring`, a device's own copy), signing as `device`. */
  codecFor(device: DeviceId, ring?: Keyring): FrameCodec;
  /** A gate that knows every identity this object created; other writers wait. */
  gateFor(device: DeviceId): FrameGate;
  identityOf(device: DeviceId): DeviceIdentity;
}

export function testSigners(sodium: Sodium, ring: Keyring): TestSigners {
  const identities = new Map<DeviceId, DeviceIdentity>();
  const codecs = new Map<DeviceId, FrameCodec>();
  const identityOf = (device: DeviceId): DeviceIdentity => {
    let identity = identities.get(device);
    if (!identity) {
      identity = createDeviceIdentity(sodium, device);
      identities.set(device, identity);
    }
    return identity;
  };
  const gate: FrameGate = {
    authenticate(head) {
      const identity = identities.get(head.device);
      if (!identity) return { ok: false, wait: true, code: "writer-unknown" };
      return verifyHeadSignature(ring.vaultId, head, identity.signPublicKey)
        ? { ok: true }
        : { ok: false, wait: false, code: "bad_head_signature" };
    },
    accept: () => ({ verdict: { ok: true }, changed: false }),
    observe() {},
    needsReplay: () => false,
    takeRebuild: () => false,
    reset() {},
  };
  return {
    codecFor(device, own) {
      if (own) return createOwnLogCodec({ sodium, ring: own, signer: identityOf(device) });
      let codec = codecs.get(device);
      if (!codec) {
        codec = createOwnLogCodec({ sodium, ring, signer: identityOf(device) });
        codecs.set(device, codec);
      }
      return codec;
    },
    gateFor: () => gate,
    identityOf,
  };
}
