import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireHostLock } from "../host/lock.js";
import { hostRunPaths } from "../host/paths.js";
import { type BankingSecretAuthority, createTestBankingSecrets } from "./banking.js";
import { type OsKeyringPort, osKeyringFits } from "./native.js";
import { largeSecretKeyring } from "./sealed.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("isolates profile banking secrets and closes access after authority or lock loss", async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "cashu-banking-keys-test-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(join(dataDir, "run"), { mode: 0o700 });
  const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
  if (!lock) throw new Error("synthetic lock unavailable");
  const values = new Map<string, Uint8Array>();
  const keyring: OsKeyringPort = {
    async get(service, account) {
      return values.get(`${service}/${account}`)?.slice() ?? null;
    },
    async set(service, account, value) {
      values.set(`${service}/${account}`, value.slice());
    },
  };
  let current = true;
  let owner = true;
  const authority: BankingSecretAuthority = {
    dataDir,
    lock,
    profileId: "profile-a",
    isCurrent: () => current,
    isOwnerAction: () => owner,
  };
  const service = `cashu-next-banking-test.${randomBytes(16).toString("hex")}`;
  const first = createTestBankingSecrets(authority, service, keyring);
  const other = createTestBankingSecrets(
    { ...authority, profileId: "profile-b" },
    service,
    keyring,
  );
  await first.set("credentials", "synthetic-private-key");
  expect(await first.get("credentials")).toBe("synthetic-private-key");
  expect(await other.get("credentials")).toBeNull();
  owner = false;
  await expect(first.set("credentials", "replacement")).rejects.toThrow(
    "banking_secrets_unavailable",
  );
  await first.set("sessions", "[]");
  current = false;
  await expect(first.get("sessions")).rejects.toThrow("banking_secrets_unavailable");
  current = true;
  lock.release();
  await expect(first.get("credentials")).rejects.toThrow("banking_secrets_unavailable");
});

it("keeps a credential too large for one Windows credential in sealed files on Windows", async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "cashu-banking-keys-test-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(join(dataDir, "run"), { mode: 0o700 });
  const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
  if (!lock) throw new Error("synthetic lock unavailable");
  const values = new Map<string, Uint8Array>();
  // A synthetic Credential Manager: one entry holds at most 2560 bytes.
  const credentialManager: OsKeyringPort = {
    async get(service, account) {
      return values.get(`${service}/${account}`)?.slice() ?? null;
    },
    async set(service, account, value) {
      if (!osKeyringFits(value.length, "win32")) throw new Error("synthetic blob limit");
      values.set(`${service}/${account}`, value.slice());
    },
  };
  const authority: BankingSecretAuthority = {
    dataDir,
    lock,
    profileId: "profile-a",
    isCurrent: () => true,
    isOwnerAction: () => true,
  };
  const service = `cashu-next-banking-test.${randomBytes(16).toString("hex")}`;
  const native = createTestBankingSecrets(authority, service, credentialManager);
  const sealed = createTestBankingSecrets(
    authority,
    service,
    largeSecretKeyring(dataDir, "banking-secrets", {
      platform: "win32",
      keyring: credentialManager,
    }),
  );
  // An RSA-4096 PEM in its JSON record is about 3.4 KB: synthetic text of that size.
  const credential = JSON.stringify({ appId: "synthetic", privateKeyPem: "k".repeat(3300) });
  await expect(native.set("credentials", credential)).rejects.toThrow(
    "banking_secrets_unavailable",
  );
  await sealed.set("credentials", credential);
  expect(await sealed.get("credentials")).toBe(credential);
  expect([...values.values()].map((v) => v.length)).toEqual([32]);
  await sealed.clear("credentials");
  expect(await sealed.get("credentials")).toBeNull();
  lock.release();
  await expect(sealed.get("credentials")).rejects.toThrow("banking_secrets_unavailable");
});
