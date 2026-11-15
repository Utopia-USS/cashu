// The native dev demo's own key files (devDemo.ts `native`): the synthetic vault keys, device identity,
// relay identity and the vaults' relay recovery secrets of a demo data dir live in `<data dir>/demo-keys/`
// (0700, files 0600, plain), never in the OS keychain. Only for synthetic demo data: every constructor refuses a data dir outside the
// lab root (`~/cashu-lab` for the CLI, a temp dir in tests).
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ProductionKeyStoreInput } from "@cashu/node-host/keyring";
import type { RelayRecoveryRecord, RelayRecoverySecrets } from "@cashu/node-host/relay-auth";
import type { AuthRecord, AuthStore, crypto } from "@cashu/sync";

const DIR = "demo-keys";
const NAME = /^[A-Za-z0-9._-]{1,128}$/;
const RELAY_AUTH = "relay-auth.json";
const VAULT = /^[0-9a-f]{32}$/;
const RECOVERY_BYTES = 32;
const RECOVERY_FORMAT = 1;

/** The canonical `dataDir` when it lies strictly inside `labRoot` (both resolved), else throws. */
export function insideLab(dataDir: string, labRoot: string): string {
  const root = realpathSync(resolve(labRoot));
  const target = resolve(dataDir);
  const canonical = existsSync(target)
    ? realpathSync(target)
    : join(realpathSync(dirname(target)), basename(target));
  if (!canonical.startsWith(`${root}${sep}`))
    throw new Error("the native demo runs only under the lab root (~/cashu-lab)");
  return canonical;
}

function keyDir(dataDir: string): string {
  const dir = join(dataDir, DIR);
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error("the demo key dir is not private");
  return dir;
}

function writeAtomic(path: string, bytes: Uint8Array): void {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

/** A file-backed `crypto.KeyStore` in the demo's key dir. */
function demoKeyStore(dataDir: string): crypto.KeyStore {
  const dir = keyDir(dataDir);
  const path = (name: string) => {
    if (!NAME.test(name) || name === RELAY_AUTH) throw new Error("bad_key_name");
    return join(dir, `${name}.key`);
  };
  return {
    async get(name) {
      const file = path(name);
      return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
    },
    async set(name, value) {
      writeAtomic(path(name), value);
    },
    async delete(name) {
      rmSync(path(name), { force: true });
    },
  };
}

/** The `ProductionVaultSourceFactory` key store seam bound to one demo data dir. */
export function demoKeyStoreFactory(
  dataDir: string,
): (input: ProductionKeyStoreInput) => crypto.KeyStore {
  return (input) => {
    if (realpathSync(input.dataDir) !== dataDir) throw new Error("keystore_unavailable");
    return demoKeyStore(dataDir);
  };
}

/** The demo's relay identity (uid + refresh token at the configured relay) in its key dir. */
export function demoRelayAuthStore(dataDir: string): AuthStore {
  const file = join(keyDir(dataDir), RELAY_AUTH);
  return {
    load(): AuthRecord | undefined {
      if (!existsSync(file)) return undefined;
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AuthRecord>;
        return typeof raw.uid === "string" && typeof raw.refreshToken === "string"
          ? { uid: raw.uid, refreshToken: raw.refreshToken }
          : undefined;
      } catch {
        return undefined;
      }
    },
    save(record) {
      writeAtomic(file, Buffer.from(JSON.stringify(record), "utf8"));
    },
    clear() {
      rmSync(file, { force: true });
    },
  };
}

/** A vault's recovery file: `relay-recovery.<vault>` (never a `.key` name of the key store). */
function recoveryFile(dataDir: string, vault: string): string {
  if (!VAULT.test(vault)) throw new Error("bad_vault_id");
  return join(keyDir(dataDir), `relay-recovery.${vault}`);
}

/**
 * The demo's relay recovery secrets (one file per vault in its key dir), the same contract as the
 * keychain store of production (`@cashu/node-host/relay-auth`): a value that does not decode reads as
 * absent, so the demo exercises the real enable path (secret kept before the commit of its hash).
 */
export function demoRelayRecoverySecrets(dataDir: string): RelayRecoverySecrets {
  return {
    async get(vault) {
      const file = recoveryFile(dataDir, vault);
      if (!existsSync(file)) return null;
      const bytes = new Uint8Array(readFileSync(file));
      const one = 1 + RECOVERY_BYTES;
      if (bytes[0] !== RECOVERY_FORMAT || (bytes.length !== one && bytes.length !== one * 2 - 1))
        return null;
      const current = bytes.slice(1, one);
      return bytes.length === one ? { current } : { current, next: bytes.slice(one) };
    },
    async set(vault, record: RelayRecoveryRecord) {
      const parts = record.next === undefined ? [record.current] : [record.current, record.next];
      if (parts.some((part) => part.length !== RECOVERY_BYTES))
        throw new Error("bad_recovery_secret");
      const out = new Uint8Array(1 + parts.length * RECOVERY_BYTES);
      out[0] = RECOVERY_FORMAT;
      parts.forEach((part, i) => {
        out.set(part, 1 + i * RECOVERY_BYTES);
      });
      writeAtomic(recoveryFile(dataDir, vault), out);
    },
    async clear(vault) {
      rmSync(recoveryFile(dataDir, vault), { force: true });
    },
  };
}
