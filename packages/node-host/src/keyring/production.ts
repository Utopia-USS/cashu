import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { crypto } from "@cashu/sync";
import { MIGRATION_STAGING_PREFIX } from "../admissionGuard.js";
import { keychainService, processFlavor } from "../flavor.js";
import type { HostLock } from "../host/lock.js";
import { hostRunPaths } from "../host/paths.js";
import { PrivateBlobFiles } from "./files.js";
import { nativeOsKeyring, type OsKeyringDeletePort, type OsKeyringPort } from "./native.js";

export { enterTestBuildKeyringNamespace } from "./native.js";

const ACCOUNT = "cashu.keystore.kek";
const NAME = /^cashu\.(?:vault\.[0-9a-f]{32}\.keys|device\.[0-9a-f]{32}\.identity)$/;
const TEST_SERVICE = /^cashu-next-test\.[0-9a-f]{32}$/;
const mutationQueues = new Map<string, Promise<unknown>>();

function serializeNamespace<T>(service: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(service) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  const settled = next.catch(() => undefined);
  mutationQueues.set(service, settled);
  void settled.then(() => {
    if (mutationQueues.get(service) === settled) mutationQueues.delete(service);
  });
  return next;
}

export interface ProvisionEvidence {
  /** The held per-data-dir host lock, acquired through acquireHostLock. */
  readonly lock: HostLock;
  /** Host-side assertion of the pending record and empty target, based on authenticated inventory. */
  assertPending(): void;
}
export interface ProductionKeyStoreInput {
  readonly dataDir: string;
  /**
   * In-place migration only: the data dir whose OS key store namespace the KEK belongs to while
   * `dataDir` is the import's staging tree inside it (`<scopeDir>/.migration-<time>/native`), so the
   * tree opens unchanged once moved into `scopeDir`. Canonical and absolute; it names the namespace
   * only, every file and lock check stays on `dataDir`.
   */
  readonly scopeDir?: string;
  readonly purpose: "open" | "provision";
  readonly authorizedNames: ReadonlySet<string>;
  readonly sodium: crypto.Sodium;
  readonly provision?: ProvisionEvidence;
}
export interface TestKeyStoreInput extends ProductionKeyStoreInput {
  readonly service: string;
  readonly keyring: OsKeyringPort;
}

function snapshot(input: ProductionKeyStoreInput): {
  dataDir: string;
  names: ReadonlySet<string>;
  files: PrivateBlobFiles;
} {
  let canonical: string;
  try {
    canonical = realpathSync(input.dataDir);
  } catch {
    throw new crypto.CryptoError("keystore_unavailable");
  }
  if (resolve(input.dataDir) !== input.dataDir || canonical !== input.dataDir)
    throw new crypto.CryptoError("keystore_unavailable");
  const names = new Set(input.authorizedNames);
  if (!names.size || [...names].some((name) => !NAME.test(name)))
    throw new crypto.CryptoError("bad_key_name");
  if (input.purpose === "provision") {
    const lock = input.provision?.lock;
    if (!lock?.held || lock.path !== hostRunPaths(input.dataDir).lockPath)
      throw new crypto.CryptoError("keystore_unavailable");
    try {
      input.provision?.assertPending();
    } catch {
      throw new crypto.CryptoError("keystore_unavailable");
    }
  } else if (input.provision) throw new crypto.CryptoError("keystore_unavailable");
  return {
    dataDir: input.dataDir,
    names,
    files: new PrivateBlobFiles(input.dataDir, input.purpose === "provision"),
  };
}
function make(
  input: ProductionKeyStoreInput,
  service: string,
  keyring: OsKeyringPort,
): crypto.KeyStore {
  const { dataDir, names, files } = snapshot(input);
  const purpose = input.purpose;
  const sodium = input.sodium;
  const provisionLock = input.provision?.lock;
  const assertPending = input.provision?.assertPending.bind(input.provision);
  const admit = (name: string) => {
    crypto.checkName(name);
    if (!names.has(name)) throw new crypto.CryptoError("bad_key_name");
  };
  const assertState = () => {
    let canonical: string;
    try {
      canonical = realpathSync(dataDir);
    } catch {
      throw new crypto.CryptoError("keystore_unavailable");
    }
    if (canonical !== dataDir) throw new crypto.CryptoError("keystore_unavailable");
    if (purpose === "provision") {
      if (!provisionLock?.held || provisionLock.path !== hostRunPaths(dataDir).lockPath)
        throw new crypto.CryptoError("keystore_unavailable");
      try {
        assertPending?.();
      } catch {
        throw new crypto.CryptoError("keystore_unavailable");
      }
    }
  };
  const readKek = async () => {
    let key: Uint8Array | null;
    try {
      key = await keyring.get(service, ACCOUNT);
    } catch {
      throw new crypto.CryptoError("keystore_unavailable");
    }
    if (key && key.length !== 32) {
      key.fill(0);
      throw new crypto.CryptoError("keystore_corrupt");
    }
    return key;
  };
  const readKekChecked = async () => {
    const key = await readKek();
    try {
      assertState();
      return key;
    } catch (error) {
      key?.fill(0);
      throw error;
    }
  };
  const read = async (name: string) => {
    assertState();
    const blob = await files.read(name);
    try {
      assertState();
    } catch (error) {
      blob?.fill(0);
      throw error;
    }
    if (!blob) return null;
    let key: Uint8Array | null = null;
    try {
      key = await readKekChecked();
      if (!key) throw new crypto.CryptoError("keystore_unavailable");
      const plain = crypto.openKeyStoreValue(sodium, key, name, blob);
      try {
        assertState();
        return plain;
      } catch (error) {
        plain.fill(0);
        throw error;
      }
    } finally {
      key?.fill(0);
      blob.fill(0);
    }
  };
  return {
    async get(name) {
      admit(name);
      return read(name);
    },
    async set(name, value) {
      admit(name);
      const detached = Uint8Array.from(value);
      return serializeNamespace(service, async () => {
        try {
          assertState();
          let key: Uint8Array | null = null;
          try {
            if (purpose === "open") {
              // Authentication, not mere existence, is required before replacement.
              const old = await read(name);
              if (!old) throw new crypto.CryptoError("keystore_unavailable");
              old.fill(0);
              assertState();
              key = await readKekChecked();
            } else {
              const existing = await files.read(name);
              try {
                assertState();
              } catch (error) {
                existing?.fill(0);
                throw error;
              }
              if (existing) {
                existing.fill(0);
                throw new crypto.CryptoError("keystore_unavailable");
              }
              key = await readKekChecked();
              if (!key) {
                if (files.hasAnyBlob()) throw new crypto.CryptoError("keystore_unavailable");
                assertState();
                // The namespace queue and the held cross-process host lock make this final reread
                // authoritative for first creation among all host factories.
                key = await readKekChecked();
                if (!key) {
                  const fresh = sodium.randomBytes(32);
                  try {
                    assertState();
                    try {
                      await keyring.set(service, ACCOUNT, fresh);
                    } catch {
                      throw new crypto.CryptoError("keystore_unavailable");
                    }
                    assertState();
                    key = await readKekChecked();
                    if (!key) throw new crypto.CryptoError("keystore_unavailable");
                    if (!timingSafeEqual(key, fresh)) {
                      key.fill(0);
                      key = null;
                      throw new crypto.CryptoError("keystore_corrupt");
                    }
                  } finally {
                    fresh.fill(0);
                  }
                }
              }
            }
            if (!key) throw new crypto.CryptoError("keystore_unavailable");
            {
              assertState();
              const blob = crypto.sealKeyStoreValue(sodium, key, name, detached);
              try {
                assertState();
                await files.write(name, blob, assertState);
                assertState();
              } finally {
                blob.fill(0);
              }
            }
          } finally {
            key?.fill(0);
          }
        } finally {
          detached.fill(0);
        }
      });
    },
    async delete(name) {
      admit(name);
      if (purpose !== "provision") throw new crypto.CryptoError("keystore_unavailable");
      return serializeNamespace(service, async () => {
        assertState();
        await files.remove(name);
        assertState();
      });
    },
  };
}
/** A canonical absolute directory (its realpath), else keystore_unavailable. */
function canonicalDir(path: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new crypto.CryptoError("keystore_unavailable");
  }
  if (resolve(path) !== path || canonical !== path)
    throw new crypto.CryptoError("keystore_unavailable");
  return canonical;
}

/**
 * The directory whose namespace holds the KEK: `dataDir`, or a migration's `scopeDir` when
 * `dataDir` is exactly `<scopeDir>/.migration-<time>/native`.
 */
function namespaceDir(input: { readonly dataDir: string; readonly scopeDir?: string }): string {
  const dataDir = canonicalDir(input.dataDir);
  if (input.scopeDir === undefined) return dataDir;
  const scope = canonicalDir(input.scopeDir);
  const parts = relative(scope, dataDir).split(sep);
  if (
    parts.length !== 2 ||
    !parts[0]?.startsWith(MIGRATION_STAGING_PREFIX) ||
    parts[0].length === MIGRATION_STAGING_PREFIX.length ||
    parts[1] !== "native"
  )
    throw new crypto.CryptoError("keystore_unavailable");
  return scope;
}

/** The vault KEK service of `dir` in this process's flavor (`<keychainPrefix>.vault.v1.<hash>`). */
const productionService = (dir: string) =>
  keychainService(processFlavor(), "vault", createHash("sha256").update(dir, "utf8").digest("hex"));

/** Fixed new-app namespace v1. Signature/package verification remains an S47 deployment gate. */
export function createProductionKeyStore(input: ProductionKeyStoreInput): crypto.KeyStore {
  return make(input, productionService(namespaceDir(input)), nativeOsKeyring());
}

/**
 * The KEK of one data dir's namespace, as the in-place migration manages it: an orphan left by a
 * failed attempt (KEK present, no native inventory) is removed before an import, and a KEK the
 * failed run created is removed with its staging. Nothing else ever deletes a KEK.
 */
export interface MigrationKek {
  /** Whether the namespace holds a KEK. */
  present(): Promise<boolean>;
  /** Removes the KEK; an absent one is not an error. */
  remove(): Promise<void>;
}

function migrationKek(service: string, keyring: OsKeyringDeletePort): MigrationKek {
  return {
    async present() {
      let key: Uint8Array | null;
      try {
        key = await keyring.get(service, ACCOUNT);
      } catch {
        throw new crypto.CryptoError("keystore_unavailable");
      }
      key?.fill(0);
      return key !== null;
    },
    remove: () =>
      serializeNamespace(service, async () => {
        try {
          await keyring.delete(service, ACCOUNT);
        } catch {
          throw new crypto.CryptoError("keystore_unavailable");
        }
      }),
  };
}

/** The production KEK of `dataDir` (canonical, absolute) for the in-place migration. */
export function productionMigrationKek(dataDir: string): MigrationKek {
  return migrationKek(productionService(canonicalDir(dataDir)), nativeOsKeyring());
}
/** Synthetic-only constructor. Tests must use a fresh temp root and exact test namespace. */
function assertTestNamespace(dir: string, service: string): void {
  const buildRoot = resolve(process.cwd(), "build");
  const tempRoot = realpathSync(tmpdir());
  const underTestRoot = (root: string) =>
    dir.startsWith(`${root}/`) && /^t44-test-[^/]+\/data$/.test(dir.slice(root.length + 1));
  if (!TEST_SERVICE.test(service) || (!underTestRoot(buildRoot) && !underTestRoot(tempRoot))) {
    throw new crypto.CryptoError("keystore_unavailable");
  }
}

export function createTestKeyStore(input: TestKeyStoreInput): crypto.KeyStore {
  assertTestNamespace(
    input.scopeDir === undefined ? input.dataDir : namespaceDir(input),
    input.service,
  );
  return make(input, input.service, input.keyring);
}

/** Synthetic-only `MigrationKek` over an exact test namespace and in-memory keyring. */
export function createTestMigrationKek(input: {
  readonly dataDir: string;
  readonly service: string;
  readonly keyring: OsKeyringDeletePort;
}): MigrationKek {
  assertTestNamespace(canonicalDir(input.dataDir), input.service);
  return migrationKek(input.service, input.keyring);
}
