// `@cashu/store/sync`: the platform-free sync plumbing of a vault (clock and gate meta stores, durable
// commands and their attempt journal, the clock guard, the SQLite-backed own-log transport, the device
// authority). It imports only leaf modules, never the root barrel, so the phone can take it alone.

export { type CommandAttemptTable, SqlCommandAttemptJournal } from "../command-attempt-sql.js";
export {
  type AttemptLookup,
  type AttemptRecord,
  type CommandAttemptPort,
  commandFingerprint,
  type DurableCommandResult,
  type DurableCommandSession,
  executeDurableCommand,
  toUnstampedEvent,
  type VaultCommandQueue,
} from "../command-durable.js";
export { mintUlid } from "../gid.js";
export {
  type MetaClockStore,
  type MetaGateStateStore,
  metaClockStore,
  metaGateStateStore,
} from "../hlc.js";
export { initializeMetaClockGuard, metaClockGuardStore } from "./clockGuard.js";
export {
  assertReplayedDeviceAuthority,
  type DeviceAuthorityCandidate,
  type DeviceAuthorityInput,
  DeviceAuthorityRefusal,
  type DeviceAuthorityRefusalCode,
  loadDeviceAuthority,
} from "./deviceAuthority.js";
export { SqlLogTransport, type SqlLogTransportOptions } from "./logTransport.js";
export { ProvenanceRefusal, SqlProvenanceStore } from "./provenance.js";
