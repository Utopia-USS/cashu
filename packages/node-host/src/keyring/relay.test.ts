import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { keychainService } from "../flavor.js";
import { acquireHostLock } from "../host/lock.js";
import { hostRunPaths } from "../host/paths.js";
import type { OsKeyringPort } from "./native.js";
import { createTestRelayAuthSecret } from "./relay.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function memoryKeyring(calls: string[]): OsKeyringPort {
  const values = new Map<string, Uint8Array>();
  return {
    async get(service, account) {
      calls.push("get");
      return values.get(`${service}/${account}`)?.slice() ?? null;
    },
    async set(service, account, value) {
      calls.push("set");
      values.set(`${service}/${account}`, value.slice());
    },
  };
}

function privateDataDir(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cashu-relay-auth-test-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(join(dataDir, "run"), { mode: 0o700 });
  return dataDir;
}

it("keeps one record per data dir and refuses without the held host lock", async () => {
  const dataDir = privateDataDir();
  const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
  if (!lock) throw new Error("synthetic lock unavailable");
  const calls: string[] = [];
  const keyring = memoryKeyring(calls);
  const service = `cashu-next-relay-test.${randomBytes(16).toString("hex")}`;
  try {
    const secret = createTestRelayAuthSecret({ dataDir, lock }, service, keyring);
    expect(await secret.get()).toBeNull();
    await secret.set('{"uid":"u","refreshToken":"synthetic"}');
    expect(await secret.get()).toBe('{"uid":"u","refreshToken":"synthetic"}');
    const other = privateDataDir();
    const otherLock = acquireHostLock(hostRunPaths(other).lockPath);
    if (!otherLock) throw new Error("synthetic lock unavailable");
    try {
      expect(
        await createTestRelayAuthSecret(
          { dataDir: other, lock: otherLock },
          service,
          keyring,
        ).get(),
      ).toBeNull();
    } finally {
      otherLock.release();
    }
    await secret.clear();
    expect(await secret.get()).toBeNull();
    lock.release();
    const before = calls.length;
    await expect(secret.get()).rejects.toThrow("relay_auth_unavailable");
    expect(calls.length).toBe(before);
  } finally {
    if (lock.held) lock.release();
  }
});

it("refuses a production-looking service or a data dir outside the temp dir", () => {
  const dataDir = privateDataDir();
  const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
  if (!lock) throw new Error("synthetic lock unavailable");
  try {
    const keyring = memoryKeyring([]);
    expect(() =>
      createTestRelayAuthSecret({ dataDir, lock }, "cashu.relay-auth.v1.x", keyring),
    ).toThrow("relay_auth_unavailable");
    expect(
      keychainService(
        { keychainPrefix: "cashu" } as Parameters<typeof keychainService>[0],
        "relay-auth",
        "h",
      ),
    ).toBe("cashu.relay-auth.v1.h");
  } finally {
    lock.release();
  }
});
