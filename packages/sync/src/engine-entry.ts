// `@cashu/sync/engine`: the phone-safe subset of `@cashu/sync`. The engine, its own-log frame codec, the
// Firestore relay transport, the hybrid clock, the errors, the crypto core without the recovery phrase,
// and the device pieces a joining device needs. Metro bundles whole files and does not tree-shake, so the
// root barrel would add the folder transport, the own-log carrier (manifest, snapshots), the BIP39
// wordlist and every inviter / revocation module to the phone; the hosts keep the root. Every name is
// the same binding as in the root.

export { ownBatchDigest } from "./batchProof.js";
export * from "./carrier.js";
export { createOwnLogCodec, type OwnLogCodecOptions } from "./carriers/ownlog/codec.js";
export * as crypto from "./crypto/core.js";
export * as devices from "./devices/engine.js";
export {
  createSyncEngine,
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_BATCH_EVENTS,
  type SyncEngineOptions,
  VAULT_RE,
} from "./engine.js";
export * from "./errors.js";
export * from "./hlc.js";
export * from "./transports/firestore/index.js";
