// The platform-free half of a device's authority over one vault: load the keyring and the device
// identity from the key store, prove the identity is certified and every held key has durable
// provenance, and build the registry fold and the frame gate. Where the vault lives on disk is the
// app's concern (the desktop host validates its inventory before calling this).
import { crypto, devices } from "@cashu/sync";
import { ProvenanceRefusal, type SqlProvenanceStore } from "./provenance.js";

export type DeviceAuthorityRefusalCode =
  | "missing_authority"
  | "invalid_authority"
  | "untrusted_identity"
  | "incomplete_history"
  | "profile_mismatch";

export class DeviceAuthorityRefusal extends Error {
  readonly code: DeviceAuthorityRefusalCode;
  constructor(code: DeviceAuthorityRefusalCode) {
    super(code);
    this.code = code;
  }
}

export interface DeviceAuthorityInput {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly keyStore: crypto.KeyStore;
  readonly sodium: crypto.Sodium;
  readonly provenance: SqlProvenanceStore;
  readonly clock: () => number;
  /** Verified certificate chain from creation or a SAS-authenticated pairing welcome. */
  readonly bootstrapCertificates: readonly Uint8Array[];
}

/** This is a replay candidate, not a ready session or permission to write. */
export interface DeviceAuthorityCandidate {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly ring: crypto.Keyring;
  readonly identity: crypto.DeviceIdentity;
  readonly devices: devices.VaultDevices;
  readonly gate: devices.DeviceFrameGate;
  close(): void;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function loadDeviceAuthority(
  input: DeviceAuthorityInput,
): Promise<DeviceAuthorityCandidate> {
  // Copied before the first await, so a caller mutating its input cannot change what is checked.
  const { vaultId, deviceId } = input;
  const bootstrapCertificates = input.bootstrapCertificates.map((certificate) =>
    certificate.slice(),
  );
  let ring: crypto.Keyring | null = null;
  let identity: crypto.DeviceIdentity | null = null;
  try {
    ring = await crypto.loadKeyring(input.keyStore, input.sodium, vaultId);
    identity = await crypto.loadDeviceIdentity(input.keyStore, deviceId);
    if (!ring || !identity) throw new DeviceAuthorityRefusal("missing_authority");
    if (ring.vaultId !== vaultId || identity.deviceId !== deviceId) {
      throw new DeviceAuthorityRefusal("invalid_authority");
    }
    input.provenance.assertRing(ring);
    const certs = crypto.verifyCertificates(
      input.sodium,
      vaultId,
      ring.recovery.signPublicKey,
      bootstrapCertificates,
      new Set(),
    );
    const certified = certs.devices.get(deviceId);
    if (
      !certified ||
      certs.conflicts.includes(deviceId) ||
      !same(certified.signPublicKey, identity.signPublicKey) ||
      !same(certified.boxPublicKey, identity.box.publicKey)
    )
      throw new DeviceAuthorityRefusal("untrusted_identity");
    // The store's constructor proves every key held by the ring has durable provenance.
    for (const key of ring.entries()) {
      if (input.provenance.get(key.kid) === undefined) {
        throw new DeviceAuthorityRefusal("invalid_authority");
      }
    }
    const vaultDevices = new devices.VaultDevices({
      sodium: input.sodium,
      identity,
      ring,
      provenance: input.provenance,
      clock: input.clock,
      bootstrapCertificates,
    });
    const gate = new devices.DeviceFrameGate(vaultDevices, { sodium: input.sodium });
    return {
      vaultId,
      deviceId,
      ring,
      identity,
      devices: vaultDevices,
      gate,
      close: () => {
        identity?.wipe();
        ring?.wipe();
      },
    };
  } catch (error) {
    identity?.wipe();
    ring?.wipe();
    if (error instanceof DeviceAuthorityRefusal || error instanceof ProvenanceRefusal) throw error;
    throw new DeviceAuthorityRefusal("invalid_authority");
  }
}

/** Call only after local encrypted-log recovery and the profile query both completed. */
export function assertReplayedDeviceAuthority(
  candidate: DeviceAuthorityCandidate,
  recovery: {
    readonly complete: boolean;
    readonly requiresViewRebuild: boolean;
    readonly rolledBack: boolean;
  },
  profileGid: string | undefined,
): void {
  if (!recovery.complete || recovery.requiresViewRebuild || recovery.rolledBack) {
    throw new DeviceAuthorityRefusal("incomplete_history");
  }
  if (profileGid !== candidate.vaultId) throw new DeviceAuthorityRefusal("profile_mismatch");
  const registry = candidate.devices.registry;
  const local = registry.trusted.get(candidate.deviceId);
  if (
    !local ||
    !registry.devices.has(candidate.deviceId) ||
    registry.revoked.has(candidate.deviceId) ||
    registry.conflicts.includes(candidate.deviceId) ||
    !same(local.signPublicKey, candidate.identity.signPublicKey) ||
    !same(local.boxPublicKey, candidate.identity.box.publicKey)
  )
    throw new DeviceAuthorityRefusal("untrusted_identity");
}
