import { type VaultSalt, vaultSalt } from "@cashu/store";
import * as genesis from "@cashu/store/genesis";
import { crypto, devices } from "@cashu/sync";
import { MigrationError } from "../contract.js";

export interface MigrationVaultIdentity {
  readonly ordinal: number;
  readonly slug: string;
  readonly creator: crypto.DeviceIdentity;
  readonly created: crypto.NewVault;
  readonly genesis: devices.GenesisDevice;
  readonly salt: VaultSalt;
}

export interface MigrationIdentitySet {
  readonly recovery: crypto.RecoveryIdentity;
  readonly vaults: readonly MigrationVaultIdentity[];
  /** Returns the recovery words at most once, for explicit owner backup acknowledgement. */
  takeWords(): string;
  genesisKeys(): ReadonlyMap<string, genesis.VaultKeys>;
  wipe(): void;
}

/**
 * Genuine production identity material for a single import into a fresh target.
 */
export function createMigrationIdentitySet(
  sodium: crypto.Sodium,
  orderedSlugs: readonly string[],
): MigrationIdentitySet {
  if (
    orderedSlugs.length < 1 ||
    orderedSlugs.length > 64 ||
    new Set(orderedSlugs).size !== orderedSlugs.length ||
    orderedSlugs.some((slug) => !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug))
  )
    throw new MigrationError("mapping_invalid");
  const key = crypto.createRecoveryKey(sodium);
  const recovery = crypto.recoveryIdentity(sodium, key.phrase);
  let words: string | null = key.phrase.reveal();
  const vaults: MigrationVaultIdentity[] = [];
  try {
    for (const [index, slug] of orderedSlugs.entries()) {
      const creator = crypto.createDeviceIdentity(sodium);
      try {
        const created = crypto.createVaultWithRecovery(sodium, recovery, creator);
        try {
          const saltKey = created.ring.gidSalt();
          let salt: VaultSalt;
          try {
            salt = vaultSalt(saltKey.expose());
          } finally {
            saltKey.wipe();
          }
          const genesisId = genesis.genesisDevice(salt);
          const genesisIdentity = devices.createGenesisDevice(
            sodium,
            recovery,
            created.ring.vaultId,
            genesisId,
          );
          vaults.push({
            ordinal: index,
            slug,
            creator,
            created,
            genesis: genesisIdentity,
            salt,
          });
        } catch (error) {
          created.ring.wipe();
          throw error;
        }
      } catch (error) {
        creator.wipe();
        throw error;
      }
    }
    return {
      recovery,
      vaults,
      takeWords() {
        if (words === null) throw new MigrationError("identity_invalid");
        const result = words;
        words = null;
        return result;
      },
      genesisKeys() {
        return new Map(
          vaults.map((vault) => [
            vault.slug,
            { vault: vault.created.ring.vaultId, salt: vault.salt },
          ]),
        );
      },
      wipe() {
        words = null;
        recovery.wipe();
        for (const vault of vaults) {
          vault.creator.wipe();
          vault.genesis.identity.wipe();
          vault.created.ring.wipe();
          vault.salt.bytes.fill(0);
        }
      },
    };
  } catch (error) {
    words = null;
    recovery.wipe();
    for (const vault of vaults) {
      vault.creator.wipe();
      vault.genesis.identity.wipe();
      vault.created.ring.wipe();
      vault.salt.bytes.fill(0);
    }
    throw error;
  }
}
