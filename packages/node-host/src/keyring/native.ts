// The OS keyring behind every cashU secret (vault KEKs, banking, classifier, connector and relay
// secrets), through @napi-rs/keyring: the login Keychain on macOS, the Secret Service on Linux and the
// Credential Manager on Windows (generic credentials, target `<account>.<service>`, the same service
// and account names as elsewhere). Windows caveats, both set by the binding (2.1.2, keyring-core 1
// with windows-native-keyring-store 1):
// - one credential holds at most 2560 bytes (CRED_MAX_CREDENTIAL_BLOB_SIZE); a larger secret is
//   refused here as `keystore_unavailable` before the native call (fail closed, never truncated).
//   Kinds that can outgrow it (banking, connectors) keep only a 32-byte key here and their values
//   sealed in the data dir (`sealed.ts`);
// - credentials are written with CRED_PERSIST_ENTERPRISE, the store's default: in a domain with
//   roaming profiles they travel with the profile, while the data dir (%LOCALAPPDATA%) does not. The
//   binding exposes no `persistence` option (its EntryOptions carry only `linux`). Accepted: a vault,
//   banking or connector key is useless without the data dir's sealed files; the classifier API key
//   and the relay identity, stored as they are, do roam with such a profile.
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

/** The Windows Credential Manager's limit for one credential's secret (CRED_MAX_CREDENTIAL_BLOB_SIZE). */
export const WINDOWS_CREDENTIAL_MAX_BYTES = 2560;

/** Whether the OS keyring of `platform` takes a secret of `bytes` bytes (only Windows has a limit). */
export const osKeyringFits = (
  bytes: number,
  platform: NodeJS.Platform = process.platform,
): boolean => platform !== "win32" || bytes <= WINDOWS_CREDENTIAL_MAX_BYTES;

/** Whether `platform` has an OS keyring this port drives. */
export const hasNativeOsKeyring = (platform: NodeJS.Platform = process.platform): boolean =>
  platform === "darwin" || platform === "linux" || platform === "win32";

/**
 * Exact binary N-API Keychain / Secret Service / Credential Manager access. Native errors never leave
 * this boundary.
 */
export function nativeOsKeyring(): OsKeyringPort {
  if (!hasNativeOsKeyring()) {
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
      if (!osKeyringFits(value.length)) throw new crypto.CryptoError("keystore_unavailable");
      const item = await entry(service, account);
      try {
        await item.setSecret(value);
      } catch {
        throw new crypto.CryptoError("keystore_unavailable");
      }
    },
  };
}
