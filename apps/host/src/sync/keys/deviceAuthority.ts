import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  loadDeviceAuthority as loadPortableDeviceAuthority,
  type DeviceAuthorityCandidate as PortableDeviceAuthorityCandidate,
  type DeviceAuthorityInput as PortableDeviceAuthorityInput,
} from "@cashu/store/sync";

const ID = /^[0-9a-f]{32}$/;

export interface NativeVaultInventoryEntry {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly vaultRoot: string;
  readonly state: "ready" | "provisioning" | "pairing" | "recovery";
  /** Workflow origin hint; admission comes from keys, certificates and authenticated history. */
  readonly enrollment: "creator" | "pairing" | "recovery";
}

/** The host's own refusal: an inventory entry that does not locate a vault under the data dir. */
class InventoryRefusal extends Error {
  readonly code = "invalid_inventory";
  constructor() {
    super("invalid_inventory");
  }
}

/** Locator validation only. The inventory itself is not a cryptographic trust root. */
function validateNativeVaultInventory(entry: NativeVaultInventoryEntry, dataDir: string): void {
  if (!ID.test(entry.vaultId) || !ID.test(entry.deviceId) || entry.state !== "ready") {
    throw new InventoryRefusal();
  }
  if (
    entry.enrollment !== "creator" &&
    entry.enrollment !== "pairing" &&
    entry.enrollment !== "recovery"
  )
    throw new InventoryRefusal();
  if (!isAbsolute(dataDir) || !isAbsolute(entry.vaultRoot)) {
    throw new InventoryRefusal();
  }
  const dir = resolve(dataDir);
  const root = resolve(entry.vaultRoot);
  if (dir !== dataDir || root !== entry.vaultRoot) throw new InventoryRefusal();
  const fromDir = relative(dir, root);
  if (!fromDir || fromDir.startsWith(`..${sep}`) || fromDir === ".." || isAbsolute(fromDir)) {
    throw new InventoryRefusal();
  }
  try {
    if (realpathSync(dir) !== dir || realpathSync(root) !== root) {
      throw new InventoryRefusal();
    }
    if (!lstatSync(root).isDirectory()) throw new InventoryRefusal();
    let at = root;
    while (at !== dir) {
      if (lstatSync(at).isSymbolicLink()) throw new InventoryRefusal();
      at = resolve(at, "..");
    }
  } catch {
    throw new InventoryRefusal();
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
      throw new InventoryRefusal();
    }
    const legacy = relative(legacyStoreRoot, root);
    if (
      legacy === "" ||
      (!legacy.startsWith(`..${sep}`) && legacy !== ".." && !isAbsolute(legacy))
    ) {
      throw new InventoryRefusal();
    }
    ids.add(entry.vaultId);
    roots.add(root);
  }
}

export interface DeviceAuthorityInput
  extends Omit<PortableDeviceAuthorityInput, "vaultId" | "deviceId"> {
  readonly entry: NativeVaultInventoryEntry;
  readonly dataDir: string;
}

/** The portable replay candidate plus the inventory entry it was loaded for. */
export interface DeviceAuthorityCandidate extends PortableDeviceAuthorityCandidate {
  readonly entry: NativeVaultInventoryEntry;
}

/** Validate the inventory locator, then load the platform-free authority for its vault and device. */
export async function loadDeviceAuthority(
  input: DeviceAuthorityInput,
): Promise<DeviceAuthorityCandidate> {
  const entry: NativeVaultInventoryEntry = Object.freeze({ ...input.entry });
  validateNativeVaultInventory(entry, input.dataDir);
  const candidate = await loadPortableDeviceAuthority({
    vaultId: entry.vaultId,
    deviceId: entry.deviceId,
    keyStore: input.keyStore,
    sodium: input.sodium,
    provenance: input.provenance,
    clock: input.clock,
    bootstrapCertificates: input.bootstrapCertificates,
  });
  return { ...candidate, entry };
}
