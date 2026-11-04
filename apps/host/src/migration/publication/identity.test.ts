import { crypto } from "@cashu/sync";
import { describe, expect, it } from "vitest";
import { createMigrationIdentitySet } from "./identity.js";

describe("production migration identity set", () => {
  it("pins one recovery root to separate vaults and matching genesis devices", async () => {
    const sodium = await crypto.loadNodeSodium();
    const set = createMigrationIdentitySet(sodium, ["synthetic-one", "synthetic-two"]);
    try {
      const words = set.takeWords();
      expect(words.split(" ")).toHaveLength(24);
      expect(() => set.takeWords()).toThrow("identity_invalid");
      expect(set.vaults).toHaveLength(2);
      expect(new Set(set.vaults.map((vault) => vault.created.ring.vaultId)).size).toBe(2);
      expect(new Set(set.vaults.map((vault) => vault.creator.deviceId)).size).toBe(2);
      for (const vault of set.vaults) {
        expect(vault.created.ring.recovery.signPublicKey).toEqual(set.recovery.signPublicKey);
        expect(vault.genesis.identity.deviceId).not.toBe(vault.creator.deviceId);
        expect(vault.created.creatorCertificate).toHaveLength(crypto.CERT_BYTES);
        expect(vault.genesis.certificate).toHaveLength(crypto.CERT_BYTES);
        expect(vault.created.recoveryWrap.length).toBeGreaterThan(100);
      }
      const keys = set.genesisKeys();
      expect(keys.size).toBe(2);
      const recreated = crypto.recoveryIdentity(sodium, words);
      try {
        expect(recreated.signPublicKey).toEqual(set.recovery.signPublicKey);
      } finally {
        recreated.wipe();
      }
    } finally {
      set.wipe();
    }
  });

  it("refuses ambiguous profile keys before minting", async () => {
    const sodium = await crypto.loadNodeSodium();
    expect(() => createMigrationIdentitySet(sodium, ["one", "one"])).toThrow("mapping_invalid");
  });
});
