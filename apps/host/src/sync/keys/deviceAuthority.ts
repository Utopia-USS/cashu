import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { crypto, devices } from "@cashu/sync";
import { ProvenanceRefusal, type SqlProvenanceStore } from "./sqlProvenance.js";

const ID = /^[0-9a-f]{32}$/;

export interface NativeVaultInventoryEntry {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly vaultRoot: string;
  readonly state: "ready" | "provisioning" | "pairing" | "recovery";
  /** Workflow origin hint; admission comes from keys, certificates and authenticated history. */
  readonly enrollment: "creator" | "pairing" | "recovery";
}

class AuthorityRefusal extends Error {
  readonly code:
    | "invalid_inventory"
    | "missing_authority"
    | "invalid_authority"
    | "untrusted_identity"
    | "incomplete_history"
    | "profile_mismatch";
  constructor(
    code:
      | "invalid_inventory"
      | "missing_authority"
      | "invalid_authority"
      | "untrusted_identity"
      | "incomplete_history"
      | "profile_mismatch",
  ) {
    super(code);
    this.code = code;
  }
}

/** Locator validation only. The inventory itself is not a cryptographic trust root. */
function validateNativeVaultInventory(entry: NativeVaultInventoryEntry, dataDir: string): void {
  if (!ID.test(entry.vaultId) || !ID.test(entry.deviceId) || entry.state !== "ready") {
    throw new AuthorityRefusal("invalid_inventory");
  }
  if (
    entry.enrollment !== "creator" &&
    entry.enrollment !== "pairing" &&
    entry.enrollment !== "recovery"
  )
    throw new AuthorityRefusal("invalid_inventory");
  if (!isAbsolute(dataDir) || !isAbsolute(entry.vaultRoot)) {
    throw new AuthorityRefusal("invalid_inventory");
  }
  const dir = resolve(dataDir);
  const root = resolve(entry.vaultRoot);
  if (dir !== dataDir || root !== entry.vaultRoot) throw new AuthorityRefusal("invalid_inventory");
  const fromDir = relative(dir, root);
  if (!fromDir || fromDir.startsWith(`..${sep}`) || fromDir === ".." || isAbsolute(fromDir)) {
    throw new AuthorityRefusal("invalid_inventory");
  }
  try {
    if (realpathSync(dir) !== dir || realpathSync(root) !== root) {
      throw new AuthorityRefusal("invalid_inventory");
    }
    if (!lstatSync(root).isDirectory()) throw new AuthorityRefusal("invalid_inventory");
    let at = root;
    while (at !== dir) {
      if (lstatSync(at).isSymbolicLink()) throw new AuthorityRefusal("invalid_inventory");
      at = resolve(at, "..");
    }
  } catch {
    throw new AuthorityRefusal("invalid_inventory");
  }
}

/** Validate the whole candidate inventory before any vault or metadata DB is opened. */
export function validateNativeVaultInventorySet(
  entries: readonly NativeVaultInventoryEntry[],
  dataDir: string,
): void {
  const ids = new Set<string>();
  const roots = new Set<string>();
  const legacyStoreRoot = resolve(dataDir, "stores");
  for (const entry of entries) {
    validateNativeVaultInventory(entry, dataDir);
    const root = realpathSync(entry.vaultRoot);
    if (ids.has(entry.vaultId) || roots.has(root)) {
      throw new AuthorityRefusal("invalid_inventory");
    }
    const legacy = relative(legacyStoreRoot, root);
    if (
      legacy === "" ||
      (!legacy.startsWith(`..${sep}`) && legacy !== ".." && !isAbsolute(legacy))
    ) {
      throw new AuthorityRefusal("invalid_inventory");
    }
    ids.add(entry.vaultId);
    roots.add(root);
  }
}

export interface DeviceAuthorityInput {
  readonly entry: NativeVaultInventoryEntry;
  readonly dataDir: string;
  readonly keyStore: crypto.KeyStore;
  readonly sodium: crypto.Sodium;
  readonly provenance: SqlProvenanceStore;
  readonly clock: () => number;
  /** Verified certificate chain from creation or a SAS-authenticated pairing welcome. */
  readonly bootstrapCertificates: readonly Uint8Array[];
}

/** This is a replay candidate, not a ready session or permission to write. */
export interface DeviceAuthorityCandidate {
  readonly entry: NativeVaultInventoryEntry;
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
  const entry: NativeVaultInventoryEntry = Object.freeze({ ...input.entry });
  const bootstrapCertificates = input.bootstrapCertificates.map((certificate) =>
    certificate.slice(),
  );
  validateNativeVaultInventory(entry, input.dataDir);
  let ring: crypto.Keyring | null = null;
  let identity: crypto.DeviceIdentity | null = null;
  try {
    ring = await crypto.loadKeyring(input.keyStore, input.sodium, entry.vaultId);
    identity = await crypto.loadDeviceIdentity(input.keyStore, entry.deviceId);
    if (!ring || !identity) throw new AuthorityRefusal("missing_authority");
    if (ring.vaultId !== entry.vaultId || identity.deviceId !== entry.deviceId) {
      throw new AuthorityRefusal("invalid_authority");
    }
    input.provenance.assertRing(ring);
    const certs = crypto.verifyCertificates(
      input.sodium,
      entry.vaultId,
      ring.recovery.signPublicKey,
      bootstrapCertificates,
      new Set(),
    );
    const certified = certs.devices.get(entry.deviceId);
    if (
      !certified ||
      certs.conflicts.includes(entry.deviceId) ||
      !same(certified.signPublicKey, identity.signPublicKey) ||
      !same(certified.boxPublicKey, identity.box.publicKey)
    )
      throw new AuthorityRefusal("untrusted_identity");
    // The store's constructor proves every key held by the ring has durable provenance.
    for (const key of ring.entries()) {
      if (input.provenance.get(key.kid) === undefined) {
        throw new AuthorityRefusal("invalid_authority");
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
      entry,
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
    if (error instanceof AuthorityRefusal || error instanceof ProvenanceRefusal) throw error;
    throw new AuthorityRefusal("invalid_authority");
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
    throw new AuthorityRefusal("incomplete_history");
  }
  if (profileGid !== candidate.entry.vaultId) throw new AuthorityRefusal("profile_mismatch");
  const registry = candidate.devices.registry;
  const local = registry.trusted.get(candidate.entry.deviceId);
  if (
    !local ||
    !registry.devices.has(candidate.entry.deviceId) ||
    registry.revoked.has(candidate.entry.deviceId) ||
    registry.conflicts.includes(candidate.entry.deviceId) ||
    !same(local.signPublicKey, candidate.identity.signPublicKey) ||
    !same(local.boxPublicKey, candidate.identity.box.publicKey)
  )
    throw new AuthorityRefusal("untrusted_identity");
}
