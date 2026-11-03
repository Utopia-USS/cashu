import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crypto } from "@cashu/sync";
import { afterEach, expect, it } from "vitest";
import {
  NATIVE_CERTIFICATES,
  NATIVE_INVENTORY,
  readExistingNativeInventory,
} from "./nativeInventory.js";

const VAULT = "a".repeat(32);
const DEVICE = "b".repeat(32);
const created: string[] = [];
afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "cashu-t44-inventory-")));
  created.push(dataDir);
  const native = join(dataDir, "native", "v1");
  const root = join(dataDir, "vaults", VAULT);
  mkdirSync(native, { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const cert = new Uint8Array(crypto.CERT_BYTES);
  cert[0] = 1;
  const certificate = Buffer.from(cert).toString("base64url");
  const inventoryPath = join(dataDir, NATIVE_INVENTORY);
  const certPath = join(root, NATIVE_CERTIFICATES);
  const writeInventory = (state = "ready") =>
    writeFileSync(
      inventoryPath,
      JSON.stringify({
        format: 1,
        vaults: [{ vaultId: VAULT, deviceId: DEVICE, state, enrollment: "creator" }],
      }),
      { mode: 0o600 },
    );
  const writeCerts = (encoded = certificate) =>
    writeFileSync(
      certPath,
      JSON.stringify({ format: 1, vaultId: VAULT, deviceId: DEVICE, certificates: [encoded] }),
      { mode: 0o600 },
    );
  writeInventory();
  writeCerts();
  return { dataDir, inventoryPath, certPath, certificate, writeInventory, writeCerts };
}

it("reads only exact fixed candidates and binds certificate bytes to the locator", () => {
  const f = fixture();
  const found = readExistingNativeInventory(f.dataDir);
  expect(found.entries).toEqual([
    {
      vaultId: VAULT,
      deviceId: DEVICE,
      vaultRoot: join(f.dataDir, "vaults", VAULT),
      state: "ready",
      enrollment: "creator",
    },
  ]);
  expect(found.certificates.get(VAULT)?.[0]).toEqual(
    Uint8Array.from(Buffer.from(f.certificate, "base64url")),
  );
  expect(found.fingerprint).toMatch(/^[0-9a-f]{64}$/);
});

it("reports clean missing and empty inventory as setup required", () => {
  const missing = join(realpathSync(tmpdir()), `cashu-t44-absent-${process.pid}`);
  expect(() => readExistingNativeInventory(missing)).toThrow("native_setup_required");
  const f = fixture();
  writeFileSync(f.inventoryPath, JSON.stringify({ format: 1, vaults: [] }));
  expect(() => readExistingNativeInventory(f.dataDir)).toThrow("native_setup_required");
});

it("refuses pending state and malformed or swapped certificate records", () => {
  const f = fixture();
  f.writeInventory("pairing");
  expect(() => readExistingNativeInventory(f.dataDir)).toThrow("native_provisioning_pending");
  f.writeInventory();
  f.writeCerts("AA");
  expect(() => readExistingNativeInventory(f.dataDir)).toThrow("native_inventory_invalid");
  f.writeCerts();
  writeFileSync(
    f.certPath,
    JSON.stringify({
      format: 1,
      vaultId: "c".repeat(32),
      deviceId: DEVICE,
      certificates: [f.certificate],
    }),
  );
  expect(() => readExistingNativeInventory(f.dataDir)).toThrow("native_inventory_invalid");
});

it("refuses symlinked and weak-permission locator artifacts", () => {
  const f = fixture();
  const saved = join(f.dataDir, "saved.json");
  writeFileSync(saved, "{}", { mode: 0o600 });
  rmSync(f.inventoryPath);
  symlinkSync(saved, f.inventoryPath);
  expect(() => readExistingNativeInventory(f.dataDir)).toThrow("native_inventory_invalid");
  rmSync(f.inventoryPath);
  f.writeInventory();
  chmodSync(f.inventoryPath, 0o644);
  expect(() => readExistingNativeInventory(f.dataDir)).toThrow("native_inventory_invalid");
});
