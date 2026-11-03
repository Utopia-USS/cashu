import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { crypto } from "@cashu/sync";
import type { HostLock } from "../host/lock.js";
import { hostRunPaths } from "../host/paths.js";
import { PrivateBlobFiles } from "./files.js";
import { nativeOsKeyring, type OsKeyringPort } from "./native.js";

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
/** Fixed new-app namespace v1. Signature/package verification remains an S47 deployment gate. */
export function createProductionKeyStore(input: ProductionKeyStoreInput): crypto.KeyStore {
  let canonical: string;
  try {
    canonical = realpathSync(input.dataDir);
  } catch {
    throw new crypto.CryptoError("keystore_unavailable");
  }
  if (canonical !== input.dataDir) throw new crypto.CryptoError("keystore_unavailable");
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return make(input, `cashu-next.v1.${hash}`, nativeOsKeyring());
}
/** Synthetic-only constructor. Tests must use a fresh temp root and exact test namespace. */
export function createTestKeyStore(input: TestKeyStoreInput): crypto.KeyStore {
  const buildRoot = resolve(process.cwd(), "build");
  const tempRoot = realpathSync(tmpdir());
  const underTestRoot = (root: string) =>
    input.dataDir.startsWith(`${root}/`) &&
    /^t44-test-[^/]+\/data$/.test(input.dataDir.slice(root.length + 1));
  if (
    !TEST_SERVICE.test(input.service) ||
    (!underTestRoot(buildRoot) && !underTestRoot(tempRoot))
  ) {
    throw new crypto.CryptoError("keystore_unavailable");
  }
  return make(input, input.service, input.keyring);
}
