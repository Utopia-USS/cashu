// TRANSITIONAL(S47): the lab key store of the sync daemon (S31a spec 2.3, D3a). The production
// KeyStore lives only in Electron (`safeStorage`), so the production daemon runs in the desktop
// utility process; this file store exists for the lab host and refuses any path outside the lab root
// (`config.ts`). Format `{format: 1, entries: {<name>: <base64>}}`, mode 0600, replaced atomically.
//
// Python's gid salt goes to the lab `FileKeyring` backend (parity/python/lab_keyring.py) in its own
// file: `{format: 1, entries: {<service>: {<account>: <password>}}}`.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { crypto } from "@cashu/sync";
import { z } from "zod";

const fileSchema = z.strictObject({
  format: z.literal(1),
  entries: z.record(z.string(), z.string()),
});

const keyringSchema = z.strictObject({
  format: z.literal(1),
  entries: z.record(z.string(), z.record(z.string(), z.string())),
});

function writePrivate(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** A `KeyStore` over one 0600 JSON file. */
export function labFileKeyStore(path: string): crypto.KeyStore {
  const read = (): Record<string, string> => {
    if (!existsSync(path)) return {};
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw new Error("the lab key file does not validate");
    return { ...parsed.data.entries };
  };
  const write = (entries: Record<string, string>) =>
    writePrivate(path, `${JSON.stringify({ format: 1, entries })}\n`);
  return {
    get: async (name) => {
      const v = read()[name];
      return v === undefined ? null : new Uint8Array(Buffer.from(v, "base64"));
    },
    set: async (name, value) => {
      const entries = read();
      entries[name] = Buffer.from(value).toString("base64");
      write(entries);
    },
    delete: async (name) => {
      const entries = read();
      delete entries[name];
      write(entries);
    },
  };
}

/** Python's keychain entry of a vault's gid salt (S30 contract): service `cashu`. */
const gidSaltAccount = (vaultId: string) => `cashu.vault.${vaultId}.gidsalt`;

/** Writes the gid salt (64 lower-case hex) into the lab Python keyring file. */
export function writePythonGidSalt(path: string, vaultId: string, saltHex: string): void {
  let data: z.infer<typeof keyringSchema> = { format: 1, entries: {} };
  if (existsSync(path)) {
    const parsed = keyringSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw new Error("the lab Python keyring file does not validate");
    data = parsed.data;
  }
  const service = { ...(data.entries.cashu ?? {}), [gidSaltAccount(vaultId)]: saltHex };
  writePrivate(
    path,
    `${JSON.stringify({ format: 1, entries: { ...data.entries, cashu: service } })}\n`,
  );
}
