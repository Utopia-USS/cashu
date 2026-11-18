import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireHostLock } from "../host/lock.js";
import { hostRunPaths } from "../host/paths.js";
import { type ConnectorSecretAuthority, createTestConnectorSecretVault } from "./connectors.js";
import type { OsKeyringPort } from "./native.js";
import { largeSecretKeyring } from "./sealed.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "cashu-connector-keys-test-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(join(dataDir, "run"), { mode: 0o700 });
  const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
  if (!lock) throw new Error("synthetic host lock unavailable");
  const map = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const keyring: OsKeyringPort = {
    async get(service, account) {
      calls.push(`get:${service}/${account}`);
      return map.get(`${service}/${account}`)?.slice() ?? null;
    },
    async set(service, account, value) {
      calls.push(`set:${service}/${account}`);
      map.set(`${service}/${account}`, value.slice());
    },
  };
  let current = true;
  let owner = false;
  const authority: ConnectorSecretAuthority = {
    dataDir,
    lock,
    isCurrent: () => current,
    isOwnerAction: () => owner,
  };
  const identity = {
    profileId: "profile-a",
    bindingId: "binding-a",
    connectorId: "sample-fetch",
    secretIds: ["token"],
  };
  const service = `cashu-next-connectors-test.${randomBytes(16).toString("hex")}`;
  const make = (id = identity) => createTestConnectorSecretVault(authority, id, service, keyring);
  const makeWindows = (id = identity) =>
    createTestConnectorSecretVault(
      authority,
      id,
      service,
      largeSecretKeyring(dataDir, "connector-secrets", { platform: "win32", keyring }),
    );
  return {
    map,
    calls,
    lock,
    dataDir,
    identity,
    make,
    makeWindows,
    setOwner: (value: boolean) => {
      owner = value;
    },
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}

it("uses separate exact OS account per profile/binding/secret with owner-only mutation", async () => {
  const f = fixture();
  const vault = f.make();
  await expect(vault.set("token", "synthetic-secret")).rejects.toThrow(
    "connector_secrets_unavailable",
  );
  expect(f.calls).toEqual([]);
  f.setOwner(true);
  await vault.set("token", "synthetic-secret");
  f.setOwner(false);
  expect(await vault.get("token")).toBe("synthetic-secret");
  expect(await f.make({ ...f.identity, profileId: "profile-b" }).get("token")).toBeNull();
  expect(await f.make({ ...f.identity, bindingId: "binding-b" }).get("token")).toBeNull();
  expect(await f.make({ ...f.identity, connectorId: "other-fetch" }).get("token")).toBeNull();
  expect(
    f.calls.every(
      (call) => call.includes("cashu-next-connectors-test.") && call.includes("/binding."),
    ),
  ).toBe(true);
  f.lock.release();
});

it("refuses revoked binding/lock and invalid secret ids before OS access", async () => {
  const f = fixture();
  const vault = f.make();
  await expect(vault.get("../escape")).rejects.toThrow("connector_secrets_unavailable");
  await expect(vault.get("other_valid_id")).rejects.toThrow("connector_secrets_unavailable");
  expect(f.calls).toEqual([]);
  f.setCurrent(false);
  await expect(vault.get("token")).rejects.toThrow("connector_secrets_unavailable");
  expect(f.calls).toEqual([]);
  f.setCurrent(true);
  f.lock.release();
  await expect(vault.get("token")).rejects.toThrow("connector_secrets_unavailable");
  expect(f.calls).toEqual([]);
});

// Windows cannot rename a directory while the host lock's SQLite file inside it is open.
it.skipIf(process.platform === "win32")(
  "maps a missing or replaced data directory to a value-free failure",
  async () => {
    const f = fixture();
    const vault = f.make();
    renameSync(f.dataDir, `${f.dataDir}-moved`);
    await expect(vault.get("token")).rejects.toThrow("connector_secrets_unavailable");
    expect(f.calls).toEqual([]);
    f.lock.release();
  },
);

it("seals a 16 KiB connector secret into a private file on Windows, the keyring holding the key", async () => {
  const f = fixture();
  f.setOwner(true);
  const vault = f.makeWindows();
  const value = "s".repeat(16 * 1024);
  await vault.set("token", value);
  expect(await vault.get("token")).toBe(value);
  expect([...f.map.values()].map((v) => v.length)).toEqual([32]);
  await vault.clear("token");
  expect(await vault.get("token")).toBeNull();
  f.lock.release();
});
