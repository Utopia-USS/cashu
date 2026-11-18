// Secrets that can outgrow one Windows credential (2560 bytes, `native.ts`): banking credentials with
// an RSA-3072 / 4096 key or a long session list, and connector secrets (up to 16 KiB, e.g. a client
// certificate). On Windows they are kept the way the vault keys are kept on every platform: a random
// 32-byte key-encryption key in the OS keyring (the kind's own service, account `cashu.sealed.kek`)
// and each value sealed under it (sealed-v1 of @cashu/sync, the blob name as AAD) in a private file
// `<data dir>/<root>/v1/s.<sha256(service, account)>.bin` (`PrivateBlobFiles`). macOS and Linux keep
// each value in its own Keychain / Secret Service item, unchanged; `largeSecretKeyring` is the one
// place that chooses. A blob whose key is gone is refused (`keystore_unavailable`), never re-keyed,
// and an empty value (a store's `clear`) removes the blob.
import { createHash, timingSafeEqual } from "node:crypto";
import { crypto } from "@cashu/sync";
import { PrivateBlobFiles, type PrivateBlobRoot } from "./files.js";
import { nativeOsKeyring, type OsKeyringPort } from "./native.js";
import { serializeNamespace } from "./serial.js";

/** The account of the key-encryption key, in the service of the secret kind it seals. */
export const SEALED_KEK_ACCOUNT = "cashu.sealed.kek";
const KEK_BYTES = 32;

const unavailable = () => new crypto.CryptoError("keystore_unavailable");

/** The blob a (service, account) pair is sealed into (a valid key store name, 66 characters). */
export const sealedBlobName = (service: string, account: string): string =>
  `s.${createHash("sha256").update(`${service}\0${account}`, "utf8").digest("hex")}`;

/**
 * An `OsKeyringPort` over sealed files under `dataDir` (canonical and private) with the key in
 * `keyring`. Values of any size the files take (1 MiB); the OS keyring only ever holds the 32-byte key.
 */
function sealedFileKeyring(
  dataDir: string,
  root: PrivateBlobRoot,
  keyring: OsKeyringPort,
): OsKeyringPort {
  // Built per call: the data dir checks then fail inside the caller's error mapping.
  const files = () => new PrivateBlobFiles(dataDir, true, root);
  const readKek = async (service: string): Promise<Uint8Array | null> => {
    const key = await keyring.get(service, SEALED_KEK_ACCOUNT);
    if (key && key.length !== KEK_BYTES) {
      key.fill(0);
      throw new crypto.CryptoError("keystore_corrupt");
    }
    return key;
  };
  /** The service's key, created on the first write (refused when blobs exist without one). */
  const kekForWrite = async (service: string, blobs: PrivateBlobFiles): Promise<Uint8Array> => {
    const existing = await readKek(service);
    if (existing) return existing;
    if (blobs.hasAnyBlob()) throw unavailable();
    const sodium = await crypto.loadNodeSodium();
    const fresh = sodium.randomBytes(KEK_BYTES);
    try {
      await keyring.set(service, SEALED_KEK_ACCOUNT, fresh);
      const stored = await readKek(service);
      if (!stored) throw unavailable();
      if (!timingSafeEqual(stored, fresh)) {
        stored.fill(0);
        throw new crypto.CryptoError("keystore_corrupt");
      }
      return stored;
    } finally {
      fresh.fill(0);
    }
  };
  return {
    async get(service, account) {
      const name = sealedBlobName(service, account);
      const blob = await files().read(name);
      if (!blob) return null;
      try {
        const kek = await readKek(service);
        if (!kek) throw unavailable();
        try {
          return crypto.openKeyStoreValue(await crypto.loadNodeSodium(), kek, name, blob);
        } finally {
          kek.fill(0);
        }
      } finally {
        blob.fill(0);
      }
    },
    set(service, account, value) {
      const name = sealedBlobName(service, account);
      const detached = Uint8Array.from(value);
      return serializeNamespace(`sealed\0${dataDir}\0${root}\0${service}`, async () => {
        try {
          const blobs = files();
          if (detached.length === 0) {
            await blobs.remove(name);
            return;
          }
          const kek = await kekForWrite(service, blobs);
          try {
            const sealed = crypto.sealKeyStoreValue(
              await crypto.loadNodeSodium(),
              kek,
              name,
              detached,
            );
            try {
              await blobs.write(name, sealed);
            } finally {
              sealed.fill(0);
            }
          } finally {
            kek.fill(0);
          }
        } finally {
          detached.fill(0);
        }
      });
    },
  };
}

export interface LargeSecretKeyringOptions {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** The OS keyring (tests: a synthetic one); defaults to `nativeOsKeyring()`. */
  readonly keyring?: OsKeyringPort;
}

/**
 * The keyring port of a secret kind whose values can outgrow one Windows credential: sealed files
 * under `<dataDir>/<root>/` with the key in the OS keyring on Windows, the OS keyring itself (one item
 * per value, as before) everywhere else.
 */
export function largeSecretKeyring(
  dataDir: string,
  root: Exclude<PrivateBlobRoot, "vault-secrets">,
  options: LargeSecretKeyringOptions = {},
): OsKeyringPort {
  const keyring = options.keyring ?? nativeOsKeyring();
  return (options.platform ?? process.platform) === "win32"
    ? sealedFileKeyring(dataDir, root, keyring)
    : keyring;
}
