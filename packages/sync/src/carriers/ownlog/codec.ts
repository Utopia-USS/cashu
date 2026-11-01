// The production `FrameCodec` of the own log: envelope (compression, envelope.ts) sealed into an
// S27 frame v3 (XChaCha20-Poly1305, Padme, position-bound AAD, the writer's signed head) with the
// vault's keyring.
//
// - Sealing always uses the ring's active key; the ring is shared and mutable (`rotateKeyring`,
//   `Keyring.merge` from S29 wraps), so a rotation shows up in the next frame without a new codec and a
//   log holds frames under several key generations. Opening picks the frame's key by its key id.
// - Ids: vault and device ids are the S27 ones (32 lowercase hex, events.md 2); the frame AAD binds
//   the writer's device id and the frame's segment and offset, the head binds the writer's chain.
// - Signing: `signer` is this device's identity; it signs only its own frames. A codec without a
//   signer opens only (a read-only tool). Head signatures are checked by the `FrameGate`
//   (devices/gate.ts), never here: only the registry knows which keys a writer has. The per-writer
//   key floor of S28b is gone (S29c D6): a revoked device can no longer sign another writer's frames,
//   whatever key epoch it seals under.
import type { FrameCodec, FramePosition } from "../../carrier.js";
import { frameChain, openFrame, sealFrame } from "../../crypto/frame.js";
import { genesisChain } from "../../crypto/head.js";
import type { DeviceIdentity } from "../../crypto/identity.js";
import type { Keyring } from "../../crypto/keys.js";
import type { Sodium } from "../../crypto/sodium.js";
import { SyncError } from "../../errors.js";
import {
  type CompressionLevel,
  decodeEnvelope,
  encodeEnvelope,
  MAX_ENVELOPE_BODY,
} from "./envelope.js";

export interface OwnLogCodecOptions {
  readonly sodium: Sodium;
  /** The vault's keyring on this device (mutable: rotations and merged wraps apply at once). */
  readonly ring: Keyring;
  /** This device's identity: signs the heads of its own frames (absent: a read-only codec). */
  readonly signer?: DeviceIdentity;
  /** DEFLATE level, or `false` to store frames uncompressed (default 6). */
  readonly compression?: CompressionLevel | false;
  /** Cap on a frame's decompressed payload (default and maximum 64 MiB, the S27 frame limit). */
  readonly maxPayloadBytes?: number;
}

export function createOwnLogCodec(options: OwnLogCodecOptions): FrameCodec {
  const { sodium, ring, signer } = options;
  const maxPayload = Math.min(options.maxPayloadBytes ?? MAX_ENVELOPE_BODY, MAX_ENVELOPE_BODY);
  const envelopeOptions = { compression: options.compression ?? 6 } as const;
  const context = (at: FramePosition, prev: Uint8Array) => ({
    vaultId: at.vault,
    deviceId: at.device,
    segment: at.seg,
    offset: at.offset,
    prev,
  });

  return {
    seal(plain, at, prev) {
      if (!signer) throw new SyncError("invalid-config", "this codec has no signer (read only)");
      const sealed = sealFrame(
        sodium,
        ring,
        encodeEnvelope(plain, envelopeOptions),
        context(at, prev),
        signer,
      );
      return { sealed: sealed.bytes, head: sealed.head };
    },
    open(sealed, at, prev) {
      const opened = openFrame(sodium, ring, sealed, context(at, prev));
      return { plain: decodeEnvelope(opened.plain, maxPayload), head: opened.head };
    },
    link: (sealed, at, prev) => frameChain(sealed, context(at, prev)),
    genesis: (vault, device, stream) => genesisChain({ vaultId: vault, deviceId: device, stream }),
  };
}
