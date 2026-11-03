import { crypto } from "@cashu/sync";

export interface OsKeyringPort {
  get(service: string, account: string): Promise<Uint8Array | null>;
  set(service: string, account: string, value: Uint8Array): Promise<void>;
}

/** Exact binary N-API Keychain/Secret Service access. Native errors never leave this boundary. */
export function nativeOsKeyring(): OsKeyringPort {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new crypto.CryptoError("keystore_unavailable");
  }
  const entry = async (service: string, account: string) => {
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry(
        service,
        account,
        process.platform === "linux" ? { linux: { store: "secret-service" } } : undefined,
      );
    } catch {
      throw new crypto.CryptoError("keystore_unavailable");
    }
  };
  return {
    async get(service, account) {
      const item = await entry(service, account);
      try {
        const bytes = await item.getSecret();
        return bytes === null ? null : Uint8Array.from(bytes);
      } catch {
        throw new crypto.CryptoError("keystore_unavailable");
      }
    },
    async set(service, account, value) {
      const item = await entry(service, account);
      try {
        await item.setSecret(value);
      } catch {
        throw new crypto.CryptoError("keystore_unavailable");
      }
    },
  };
}
