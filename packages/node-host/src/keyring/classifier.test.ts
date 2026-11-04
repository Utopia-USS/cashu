import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireHostLock } from "../host/lock.js";
import { hostRunPaths } from "../host/paths.js";
import { type ClassifierSecretAuthority, createTestClassifierSecrets } from "./classifier.js";
import type { OsKeyringPort } from "./native.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("isolates each vault and refuses non-owner writes or stale reads before OS access", async () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-classifier-test-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(join(dataDir, "run"), { mode: 0o700 });
  const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
  if (!lock) throw new Error("synthetic lock unavailable");
  try {
    const values = new Map<string, Uint8Array>();
    const calls: string[] = [];
    const keyring: OsKeyringPort = {
      async get(service, account) {
        calls.push("get");
        return values.get(`${service}/${account}`)?.slice() ?? null;
      },
      async set(service, account, value) {
        calls.push("set");
        values.set(`${service}/${account}`, value.slice());
      },
    };
    let owner = false;
    let current = true;
    const authority: ClassifierSecretAuthority = {
      dataDir,
      lock,
      vault: "a".repeat(32),
      isCurrent: () => current,
      isOwnerAction: () => owner,
    };
    const service = `cashu-next-classifier-test.${randomBytes(16).toString("hex")}`;
    const secret = createTestClassifierSecrets(authority, service, keyring);
    await expect(secret.set("synthetic-key")).rejects.toThrow("classifier_credential_unavailable");
    expect(calls).toEqual([]);
    owner = true;
    await secret.set("synthetic-key");
    owner = false;
    expect(await secret.get()).toBe("synthetic-key");
    expect(
      await createTestClassifierSecrets(
        { ...authority, vault: "b".repeat(32) },
        service,
        keyring,
      ).get(),
    ).toBeNull();
    const before = calls.length;
    current = false;
    await expect(secret.get()).rejects.toThrow("classifier_credential_unavailable");
    expect(calls).toHaveLength(before);
  } finally {
    lock.release();
  }
});
