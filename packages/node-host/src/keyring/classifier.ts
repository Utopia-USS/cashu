import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { keychainService, processFlavor } from "../flavor.js";
import type { HostLock } from "../host/lock.js";
import { hostRunPaths } from "../host/paths.js";
import { nativeOsKeyring, type OsKeyringPort } from "./native.js";

const VAULT = /^[a-f0-9]{32}$/;
const TEST_SERVICE = /^cashu-next-classifier-test\.[a-f0-9]{32}$/;

function unavailable(): never {
  throw new Error("classifier_credential_unavailable");
}

function privateDir(path: string): string {
  try {
    const canonical = realpathSync.native(path);
    const stat = lstatSync(canonical);
    if (
      canonical !== resolve(path) ||
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      unavailable();
    return canonical;
  } catch {
    return unavailable();
  }
}

export interface ClassifierSecretAuthority {
  readonly dataDir: string;
  readonly lock: HostLock;
  readonly vault: string;
  isCurrent(vault: string): boolean;
  isOwnerAction(): boolean;
}

export interface ClassifierSecretStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

function make(
  authority: ClassifierSecretAuthority,
  service: string,
  keyring: OsKeyringPort,
): ClassifierSecretStore {
  const dir = privateDir(authority.dataDir);
  const vault = authority.vault;
  if (!VAULT.test(vault)) unavailable();
  const account = `api.${createHash("sha256").update(`${dir}\0${vault}`).digest("hex")}`;
  function check(owner: boolean): void {
    if (
      privateDir(authority.dataDir) !== dir ||
      !authority.lock.held ||
      authority.lock.path !== hostRunPaths(dir).lockPath ||
      !authority.isCurrent(vault) ||
      (owner && !authority.isOwnerAction())
    )
      unavailable();
  }
  return {
    async get() {
      check(false);
      let bytes: Uint8Array | null = null;
      try {
        bytes = await keyring.get(service, account);
        check(false);
        if (!bytes?.length) return null;
        if (bytes.length > 16 * 1024) unavailable();
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return unavailable();
      } finally {
        bytes?.fill(0);
      }
    },
    async set(value) {
      const bytes = new TextEncoder().encode(value);
      if (!bytes.length || bytes.length > 16 * 1024) unavailable();
      try {
        check(true);
        await keyring.set(service, account, bytes);
        check(true);
      } catch {
        return unavailable();
      } finally {
        bytes.fill(0);
      }
    },
    async clear() {
      check(true);
      try {
        await keyring.set(service, account, new Uint8Array());
        check(true);
      } catch {
        return unavailable();
      }
    },
  };
}

/** Dedicated OS service. A classifier key never enters the vault, banking or connector keyrings. */
export function createProductionClassifierSecrets(
  authority: ClassifierSecretAuthority,
): ClassifierSecretStore {
  const hash = createHash("sha256").update(privateDir(authority.dataDir)).digest("hex");
  return make(authority, keychainService(processFlavor(), "classifier", hash), nativeOsKeyring());
}

/** Strict synthetic keyring; cannot address production OS credentials. */
export function createTestClassifierSecrets(
  authority: ClassifierSecretAuthority,
  service: string,
  keyring: OsKeyringPort,
): ClassifierSecretStore {
  if (
    !TEST_SERVICE.test(service) ||
    !privateDir(authority.dataDir).startsWith(
      `${realpathSync.native(process.env.TMPDIR || "/private/tmp")}/`,
    )
  )
    unavailable();
  return make(authority, service, keyring);
}
