/** Portable Python-source projection primitives of `migrate verify`. */

export {
  bool,
  type CanonRow,
  compareUtf8,
  DANGLING,
  dumps,
  int,
  json,
  type OutValue,
  PyFloat,
  pyFloat,
  sortRows,
  text,
  timestamp,
} from "./canonical.js";
export { ROUNDTRIP_COLUMNS } from "./columns.js";
export { GidKeys, type GidSource, type KeyLookup, type VaultKeyMap } from "./keys.js";
export { claimedLegs, type GidRow, projectView } from "./project.js";
export { assertSourceSchemaCoverage, VerificationSchemaError } from "./source.js";
export {
  assertSourceCacheSchema,
  captureSourceCacheReceipt,
  type SourceCacheProof,
  type SourceCacheReceipt,
  verifySourceCacheReceipt,
} from "./sourceCache.js";
export { auditSourceSuccessCounters, type SourceCounterEvidence } from "./sourceCounters.js";
export { verifyDeviceLocalSource } from "./sourceDeviceLocal.js";
export { auditGlobalInstruments } from "./sourceGlobal.js";
export {
  auditSourceInvHashes,
  verifyReplayInvHashes,
  verifySourceInvGids,
} from "./sourceInvHashes.js";
export { assertCompleteSourcePartition } from "./sourcePartition.js";
export {
  projectSourceEntries,
  projectSourceTable,
  type SourceId,
  SourceProjectionError,
} from "./sourceProject.js";
