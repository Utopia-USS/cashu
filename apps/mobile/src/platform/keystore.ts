// The phone's KeyStore (S27): expo-secure-store holds one key-encryption key in the Keychain, values
// are sealed under it and kept as files in the app's private documents directory (`keys/`).
import * as crypto from "@cashu/sync/crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

/** One file per name under documents/keys; names are `[A-Za-z0-9._-]` (checked by the KeyStore). */
function documentBlobFiles(folder = "keys"): crypto.BlobFiles {
  const dir = new Directory(Paths.document, folder);
  const file = (name: string) => new File(dir, `${name}.bin`);
  return {
    async read(name) {
      const f = file(name);
      return f.exists ? f.bytes() : null;
    },
    async write(name, value) {
      if (!dir.exists) dir.create({ intermediates: true });
      const f = file(name);
      if (!f.exists) f.create();
      await f.write(value);
    },
    async remove(name) {
      const f = file(name);
      if (f.exists) f.delete();
    },
  };
}

export function createMobileKeyStore(sodium: crypto.Sodium): crypto.KeyStore {
  return crypto.createSecureStoreKeyStore(sodium, SecureStore, documentBlobFiles());
}
