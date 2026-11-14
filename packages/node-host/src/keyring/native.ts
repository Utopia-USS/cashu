import { createHash } from "node:crypto";
import { crypto } from "@cashu/sync";

export interface OsKeyringPort {
  get(service: string, account: string): Promise<Uint8Array | null>;
  set(service: string, account: string, value: Uint8Array): Promise<void>;
}

const TEST_SERVICE = /^cashu-next-test\.[0-9a-f]{32}$/;
let testBuildNamespace = false;

/**
 * One-way switch for a sealed test build (a manifest-verified Contents/Resources/test-build.json,
 * see ../testBuild.ts): from this call on, every OS keyring service this process addresses is
 * mapped into the synthetic `cashu-next-test.<hex>` namespace, so a test build never reads or
 * writes a production `cashu.*.v1.*` item. The mapping is deterministic per production service,
 * so a test build reopens its own vaults across restarts and across an update in place.
 */
export function enterTestBuildKeyringNamespace(): void {
  testBuildNamespace = true;
}

/** The test namespace service a production service maps to under a test build. */
export function testBuildService(service: string): string {
  const hex = createHash("sha256").update(`cashu-test-build\0${service}`, "utf8").digest("hex");
  return `cashu-next-test.${hex.slice(0, 32)}`;
}

/** The service actually addressed: unchanged in a release, mapped and checked in a test build. */
export function addressedService(service: string): string {
  if (!testBuildNamespace) return service;
  const mapped = testBuildService(service);
  if (!TEST_SERVICE.test(mapped)) throw new crypto.CryptoError("keystore_unavailable");
  return mapped;
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
        addressedService(service),
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
