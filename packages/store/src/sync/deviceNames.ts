// The names a device shows about its own vault, read from the registry fold of its authority (the
// `device.added` events of the vault's log): its own registry name and pairing day, and the device that
// paired it (the Mac whose name the phone's freshness line carries). Pure over the candidate; the caller
// reads it again after each pass that replayed the authority (a rename or a revocation arrives as a
// frame like any other event).
import type { devices } from "@cashu/sync/engine";
import { parseHlc } from "@cashu/sync/hlc";

export interface VaultDeviceNames {
  /** This device as the registry knows it; undefined until its `device.added` is folded. */
  readonly self?: {
    readonly name: string;
    /** When the device was added: the wall time of its `device.added` stamp (epoch ms). */
    readonly addedAt: number;
  };
  /** The device that added this one (its pairing inviter); undefined for the vault's creator. */
  readonly pairedBy?: { readonly deviceId: string; readonly name: string };
}

/** What the reader needs of a `DeviceAuthorityCandidate`. */
interface RegistryHolder {
  readonly deviceId: string;
  readonly devices: {
    readonly registry: { readonly devices: ReadonlyMap<string, devices.DeviceRecord> };
  };
}

export function vaultDeviceNames(candidate: RegistryHolder): VaultDeviceNames {
  const records = candidate.devices.registry.devices;
  const own = records.get(candidate.deviceId);
  if (own === undefined) return {};
  const inviter = own.pairedBy === candidate.deviceId ? undefined : records.get(own.pairedBy);
  return {
    self: { name: own.name, addedAt: parseHlc(own.pairedAt.hlc).wall },
    ...(inviter === undefined
      ? {}
      : { pairedBy: { deviceId: inviter.deviceId, name: inviter.name } }),
  };
}
