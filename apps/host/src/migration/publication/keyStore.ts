import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { type HostLock, hostRunPaths } from "@cashu/node-host";
import { createProductionKeyStore } from "@cashu/node-host/keyring";
import { crypto } from "@cashu/sync";
import { MigrationError } from "../contract.js";
import type { MigrationIdentitySet } from "./identity.js";

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new MigrationError("identity_invalid");
  }
}

/**
 * Persists new ring and creator identities through the normal production KeyStore in a fresh
 * target directory. A partial provision is never silently retried or overwritten.
 */
export async function provisionMigrationKeyStore(input: {
  readonly dataDir: string;
  readonly identities: MigrationIdentitySet;
  readonly lock: HostLock;
  readonly sodium: crypto.Sodium;
  /** Strict synthetic OS namespace only in tests; production omits this. */
  readonly makeKeyStore?: typeof createProductionKeyStore;
}): Promise<void> {
  const { dataDir, identities, lock, sodium } = input;
  if (resolve(dataDir) !== dataDir || !lock.held || lock.path !== hostRunPaths(dataDir).lockPath)
    throw new MigrationError("identity_invalid");
  const names = new Set<string>();
  for (const vault of identities.vaults) {
    names.add(crypto.keyringName(vault.created.ring.vaultId));
    names.add(crypto.deviceIdentityName(vault.creator.deviceId));
  }
  if (names.size !== identities.vaults.length * 2) throw new MigrationError("identity_invalid");
  const secrets = join(dataDir, "vault-secrets", "v1");
  for (const name of names)
    if (exists(join(secrets, `${name}.bin`))) throw new MigrationError("identity_invalid");
  const make = input.makeKeyStore ?? createProductionKeyStore;
  const open = make({ dataDir, purpose: "open", authorizedNames: names, sodium });
  for (const name of names)
    if ((await open.get(name)) !== null) throw new MigrationError("identity_invalid");
  const assertPending = () => {
    if (!lock.held || lock.path !== hostRunPaths(dataDir).lockPath) {
      throw new MigrationError("identity_invalid");
    }
  };
  const provision = make({
    dataDir,
    purpose: "provision",
    authorizedNames: names,
    sodium,
    provision: { lock, assertPending },
  });
  for (const vault of identities.vaults) {
    assertPending();
    const ringName = crypto.keyringName(vault.created.ring.vaultId);
    if (exists(join(secrets, `${ringName}.bin`))) throw new MigrationError("identity_invalid");
    await crypto.saveKeyring(provision, vault.created.ring);
    assertPending();
    const deviceName = crypto.deviceIdentityName(vault.creator.deviceId);
    if (exists(join(secrets, `${deviceName}.bin`))) throw new MigrationError("identity_invalid");
    await crypto.saveDeviceIdentity(provision, vault.creator);
  }
  assertPending();
  for (const vault of identities.vaults) {
    const ring = await crypto.loadKeyring(open, sodium, vault.created.ring.vaultId);
    const creator = await crypto.loadDeviceIdentity(open, vault.creator.deviceId);
    try {
      if (
        !ring ||
        !creator ||
        ring.vaultId !== vault.created.ring.vaultId ||
        creator.deviceId !== vault.creator.deviceId ||
        !Buffer.from(ring.recovery.signPublicKey).equals(
          Buffer.from(identities.recovery.signPublicKey),
        ) ||
        !Buffer.from(creator.signPublicKey).equals(Buffer.from(vault.creator.signPublicKey))
      )
        throw new MigrationError("identity_invalid");
    } finally {
      ring?.wipe();
      creator?.wipe();
    }
  }
}
