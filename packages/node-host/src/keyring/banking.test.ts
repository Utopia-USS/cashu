import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireHostLock } from "../host/lock.js";
import { hostRunPaths } from "../host/paths.js";
import { type BankingSecretAuthority, createTestBankingSecrets } from "./banking.js";
import type { OsKeyringPort } from "./native.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("isolates profile banking secrets and closes access after authority or lock loss", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cashu-banking-keys-test-"));
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
