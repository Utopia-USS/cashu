// The device pieces a syncing device that never invites needs (`devices` of `@cashu/sync/engine`): the
// registry fold and the frame gate a vault's authority is built from, the events the engine writes for
// its own device, the joiner side of QR pairing and the provenance of a paired keyring. The inviter,
// revocation, rotation planning, the lease writers and the leader liveness stay in `./index.ts` for the
// hosts. Re-exports only: every name here is the same binding as in `./index.ts`.

export {
  buildDeviceAdded,
  DEVICE_ADDED,
  DEVICE_REVOKED,
  type DeviceAddedData,
  type DeviceRevokedData,
  isDeviceName,
  KEYS_ROTATED,
  type LogEvent,
} from "./events.js";
export { DeviceFrameGate, type DeviceFrameGateOptions } from "./gate.js";
export { creatorPin } from "./lease.js";
export {
  decodeInvite,
  type Invite,
  type JoinerOptions,
  type JoinerProgress,
  type JoinerWelcome,
  type PairingFailed,
  type PairingFailure,
  PairingJoiner,
  type PairingStep,
  SAS_ATTEMPTS,
  SAS_TTL_MS,
  shortAuthenticationString,
} from "./pairing.js";
export { type JoinerDriver, type PairingLink, runJoiner } from "./pairingLink.js";
export type { KeyProvenance, KeySource, ProvenanceStore } from "./provenance.js";
export { type DeviceRecord, foldRegistry, Registry, type Revocation } from "./registry.js";
export { recordPairingProvenance } from "./rotation.js";
export { type IngestReport, VaultDevices, type VaultDevicesOptions } from "./vaultDevices.js";
