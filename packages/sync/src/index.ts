// @cashu/sync: the own-log sync carrier (spike-result.md). Public API for store (S23) and the carrier
// adapters (S28b folder + crypto codec, S28d relay); the contract suite lives in `@cashu/sync/testing`.
export const PACKAGE_NAME = "@cashu/sync";

export * from "./carrier.js";
export * as crypto from "./crypto/index.js";
export { createSyncEngine, type SyncEngineOptions, VAULT_RE } from "./engine.js";
export * from "./errors.js";
export * from "./hlc.js";
export { MemoryClockStore, MemoryTransport } from "./memory.js";
export {
  decodePayload,
  encodePayload,
  FRAME_FORMAT,
  type FramePayload,
  frameBytes,
  LENGTH_BYTES,
  MAX_SEALED_FRAME_BYTES,
  type ScannedFrame,
  type ScanResult,
  scanFrames,
} from "./segment.js";
