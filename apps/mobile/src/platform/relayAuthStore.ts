// The phone's relay identity (anonymous Firebase uid + refresh token) in the KeyStore under
// `cashu.relay.auth`: the refresh token is a secret, so it is sealed like the keyrings and wiped with
// them. One identity per phone, shared by every paired vault.
import { type AuthRecord, type AuthStore, crypto } from "@cashu/sync/engine";
import { z } from "zod";

export const RELAY_AUTH_ITEM = "cashu.relay.auth";

const recordSchema = z.object({
  uid: z.string().min(1).max(128),
  refreshToken: z.string().min(1).max(4096),
});

/**
 * An `AuthStore` over `keyStore`. A value that does not decode, and a sealed value the KeyStore cannot
 * open (its key is gone, as after a restore from a backup onto another phone), reads as absent: the
 * relay signs up again and the new identity overwrites it. Any other failure (the Keychain did not
 * answer) is thrown, so a passing problem never replaces the phone's relay identity.
 */
export function keyStoreAuthStore(keyStore: crypto.KeyStore): AuthStore {
  return {
    async load(): Promise<AuthRecord | undefined> {
      let bytes: Uint8Array | null;
      try {
        bytes = await keyStore.get(RELAY_AUTH_ITEM);
      } catch (error) {
        if (!(error instanceof crypto.CryptoError)) throw error;
        await keyStore.delete(RELAY_AUTH_ITEM);
        return undefined;
      }
      if (bytes === null) return undefined;
      try {
        const parsed = recordSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },
    async save(record: AuthRecord): Promise<void> {
      const value = { uid: record.uid, refreshToken: record.refreshToken };
      await keyStore.set(RELAY_AUTH_ITEM, new TextEncoder().encode(JSON.stringify(value)));
    },
    async clear(): Promise<void> {
      await keyStore.delete(RELAY_AUTH_ITEM);
    },
  };
}
