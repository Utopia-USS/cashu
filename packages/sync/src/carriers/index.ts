// Carriers: the own log (spike-result.md winner) = envelope + S27 codec + the manifest-gated
// transport decorator. Formats: carriers/README.md.
export {
  createOwnLogCarrier,
  type HoldReason,
  OwnLogCarrier,
  type OwnLogCarrierOptions,
  type SnapshotMarker,
  type StreamStatus,
} from "./ownlog/carrier.js";
export { createOwnLogCodec, type OwnLogCodecOptions } from "./ownlog/codec.js";
export {
  type CompressionLevel,
  decodeEnvelope,
  encodeEnvelope,
  MAX_ENVELOPE_BODY,
} from "./ownlog/envelope.js";
export { WriterKeyFloor, type WriterKeyFloorState } from "./ownlog/floor.js";
export { MANIFEST_SEG, SNAPSHOT_REF_RE } from "./ownlog/manifest.js";
