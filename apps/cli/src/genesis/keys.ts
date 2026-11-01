// The lab / dev keys file of `cashu-next genesis` (S26 spec 6.1, impl notes change 1):
// `{format: 1, vaults: {<slug>: {vault: <32 hex>, salt: <64 hex>}}}`, mode 0600, created once by
// `--init-keys` and read by every later run (the same keys give byte-identical logs). The vault ids
// and salts are secrets of the vault: never printed, logged or put in an error message.
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { newVaultSalt, vaultSalt } from "@cashu/store";
import type * as genesis from "@cashu/store/genesis";
import { z } from "zod";

const keysFileSchema = z.strictObject({
  format: z.literal(1),
  vaults: z.record(
    z.string().min(1),
    z.strictObject({
      vault: z.string().regex(/^[0-9a-f]{32}$/),
      salt: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

type KeysFile = z.infer<typeof keysFileSchema>;

/** A keys file that cannot be read or does not validate (exit 64); the message carries no content. */
export class KeysFileError extends Error {
  readonly exitCode = 64;

  constructor(message: string) {
    super(message);
    this.name = "KeysFileError";
  }
}

const toKeys = (file: KeysFile): ReadonlyMap<string, genesis.VaultKeys> =>
  new Map(
    Object.entries(file.vaults).map(([slug, k]) => [
      slug,
      { vault: k.vault, salt: vaultSalt(Buffer.from(k.salt, "hex")) },
    ]),
  );

/**
 * The `VaultKeys` of every profile slug in the keys file at `path`. A file readable or writable by
 * group or others (mode wider than 0600) is refused before it is read.
 */
export function readKeys(path: string): ReadonlyMap<string, genesis.VaultKeys> {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new KeysFileError("the keys file is not readable JSON");
  }
  if ((mode & 0o077) !== 0) {
    throw new KeysFileError("the keys file is open to group or others; chmod 600 it");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new KeysFileError("the keys file is not readable JSON");
  }
  const parsed = keysFileSchema.safeParse(raw);
  if (!parsed.success) throw new KeysFileError("the keys file is not a format 1 keys file");
  return toKeys(parsed.data);
}

/** A fresh vault id (16 random bytes, 32 hex, as S27 `createVaultId`) that is not all zeros. */
function newVaultId(): string {
  for (;;) {
    const id = randomBytes(16).toString("hex");
    if (!/^0+$/.test(id)) return id;
  }
}

/**
 * Mints keys for `slugs` and writes them to a NEW file at `path` (mode 0600; an existing file is
 * never overwritten). Returns them as `readKeys` would.
 */
export function initKeys(
  path: string,
  slugs: readonly string[],
): ReadonlyMap<string, genesis.VaultKeys> {
  const vaults: KeysFile["vaults"] = Object.fromEntries(
    [...slugs]
      .sort()
      .map((slug) => [
        slug,
        { vault: newVaultId(), salt: Buffer.from(newVaultSalt().bytes).toString("hex") },
      ]),
  );
  const file: KeysFile = { format: 1, vaults };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return toKeys(file);
}
