// A supervised, synthetic-only native host for the Electron Create proof. Its factory never calls
// the real OS KeyStore port. The same constrained factory opens and creates vaults across restarts.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createTestKeyStore, type OsKeyringPort } from "@cashu/node-host/testing";
import { startLocalHost } from "../host.js";
import { ProductionVaultSourceFactory } from "../productionVaultSource.js";

const [dataDir, service] = process.argv.slice(2);
const tempRoot = realpathSync(tmpdir());
if (
  !dataDir ||
  !service ||
  resolve(dataDir) !== dataDir ||
  realpathSync(dataDir) !== dataDir ||
  !dataDir.startsWith(`${tempRoot}/`) ||
  !/^t44-test-[^/]+\/data$/.test(dataDir.slice(tempRoot.length + 1)) ||
  !/^cashu-next-test\.[0-9a-f]{32}$/.test(service)
)
  throw new Error("synthetic_creation_root_required");

const keyFile = join(dataDir, "test-keyring", "kek");
const keyring: OsKeyringPort = {
  async get(requestedService, account) {
    if (requestedService !== service || account !== "cashu.keystore.kek")
      throw new Error("synthetic_creation_key_name_invalid");
    try {
      const value = readFileSync(keyFile);
      if (value.length !== 32) throw new Error("synthetic_creation_key_invalid");
      return Uint8Array.from(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async set(requestedService, account, value) {
    if (requestedService !== service || account !== "cashu.keystore.kek" || value.length !== 32)
      throw new Error("synthetic_creation_key_name_invalid");
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    // Exclusive create: a restarted child can read the same fake KEK, but cannot replace it.
    writeFileSync(keyFile, value, { flag: "wx", mode: 0o600 });
  },
};
const factory = new ProductionVaultSourceFactory(dataDir, (input) =>
  createTestKeyStore({ ...input, service, keyring }),
);
const host = await startLocalHost({
  dataDir,
  build: "desktop-dev",
  vaultSource: { kind: "native-production", factory },
  lingerMs: 60_000,
});
process.once("SIGTERM", () => void host.stop("signal"));
process.once("SIGINT", () => void host.stop("signal"));
process.stdout.write("ready\n");
process.exitCode = await host.exit;
