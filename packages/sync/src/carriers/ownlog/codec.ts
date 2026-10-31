// The production `FrameCodec` of the own log: envelope (compression, envelope.ts) sealed into an
// S27 frame (XChaCha20-Poly1305, Padme, position-bound AAD) with the vault's keyring.
//
// - Sealing always uses the ring's active key; the ring is shared and mutable (`rotateKeyring`,
//   `Keyring.merge` from S29 wraps), so a rotation shows up in the next frame without a new codec and a
//   log holds frames under several key generations. Opening picks the frame's key by its key id.
// - Ids: vault and device ids are the S27 ones (32 lowercase hex, events.md 2); the frame AAD binds
//   the writer's device id and the frame's segment and offset.
// - Key acceptance per writer (revocation, crypto README "S28b"): `floor` refuses frames under a
//   generation below the revocation key from every writer that has already written at or above it,
//   checked before decrypting; `policy` lets S29 add its own `FramePolicy` per frame.
import type { FrameCodec, FramePosition } from "../../carrier.js";
import { type FramePolicy, openFrame, sealFrame } from "../../crypto/frame.js";
import type { KeyEntry, Keyring } from "../../crypto/keys.js";
import type { Sodium } from "../../crypto/sodium.js";
import {
  type CompressionLevel,
  decodeEnvelope,
  encodeEnvelope,
  MAX_ENVELOPE_BODY,
} from "./envelope.js";
import type { WriterKeyFloor } from "./floor.js";

export interface OwnLogCodecOptions {
  readonly sodium: Sodium;
  /** The vault's keyring on this device (mutable: rotations and merged wraps apply at once). */
  readonly ring: Keyring;
  /** DEFLATE level, or `false` to store frames uncompressed (default 6). */
  readonly compression?: CompressionLevel | false;
  /** Cap on a frame's decompressed payload (default and maximum 64 MiB, the S27 frame limit). */
  readonly maxPayloadBytes?: number;
  /** Per-writer generation floor after a revocation (see floor.ts). */
  readonly floor?: WriterKeyFloor;
  /** Extra S27 key policy per frame (S29), checked before decrypting. */
  readonly policy?: (at: FramePosition) => FramePolicy | undefined;
}

export function createOwnLogCodec(options: OwnLogCodecOptions): FrameCodec {
  const { sodium, ring, floor, policy } = options;
  const maxPayload = Math.min(options.maxPayloadBytes ?? MAX_ENVELOPE_BODY, MAX_ENVELOPE_BODY);
  const envelopeOptions = { compression: options.compression ?? 6 } as const;
  const context = (at: FramePosition) => ({
    vaultId: at.vault,
    deviceId: at.device,
    segment: at.seg,
    offset: at.offset,
  });

  return {
    seal(plain, at) {
      return sealFrame(sodium, ring, encodeEnvelope(plain, envelopeOptions), context(at));
    },
    open(sealed, at) {
      const ctx = context(at);
      const extra = policy?.(at);
      const seen: { entry?: KeyEntry } = {};
      const accept = (e: KeyEntry): boolean => {
        seen.entry = e;
        if (floor && !floor.allows(at, e)) return false;
        return extra?.acceptKid ? extra.acceptKid(e) : true;
      };
      const framePolicy: FramePolicy = {
        acceptKid: accept,
        ...(extra?.minGeneration === undefined ? {} : { minGeneration: extra.minGeneration }),
      };
      const envelope = openFrame(sodium, ring, sealed, ctx, framePolicy);
      if (floor && seen.entry) floor.record(at, seen.entry);
      return decodeEnvelope(envelope, maxPayload);
    },
  };
}
