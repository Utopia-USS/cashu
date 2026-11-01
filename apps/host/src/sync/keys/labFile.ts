// TRANSITIONAL(S56e): the lab key store of the host's outbox bridge (S31a spec 2.3, D3a). The
// production KeyStore is the host's OS keyring adapter (S56e); this file store exists for the lab
// and refuses any path outside the lab root (`config.ts`). Format `{format: 1, entries: {<name>: <base64>}}`, mode 0600, replaced atomically.
//
// Python's gid salt goes to the lab `FileKeyring` backend (parity/python/lab_keyring.py) in its own
// file: `{format: 1, entries: {<service>: {<account>: <password>}}}`.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
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

/**
 * Writes `text` to `path` durably: temp file 0600, fsync, atomic rename, fsync of the directory (a
 * crash right after `init` must not lose the only copy of a vault ring; review F8). The directory is
 * kept private (0700).
 */
function writePrivate(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  const dfd = openSync(dir, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
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
