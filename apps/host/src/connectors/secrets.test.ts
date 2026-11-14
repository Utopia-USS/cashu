import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostLock, hostRunPaths } from "@cashu/node-host";
import { afterEach, expect, it } from "vitest";
import { ConnectorCatalog, resolveInterpreter } from "./catalog.js";
import { boundConnectorSecrets, deletionOnlyConnectorSecrets } from "./secrets.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("derives secret scope from the approved manifest and refuses cross-binding access", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cashu-secret-adapter-test-"));
  roots.push(root);
  const data = join(root, "data"),
    source = join(root, "source");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(join(data, "run"), { mode: 0o700 });
  const lock = acquireHostLock(hostRunPaths(data).lockPath);
  if (!lock) throw new Error("synthetic host lock unavailable");
  writeFileSync(
    join(source, "connector.yaml"),
    "api_version: 1\nid: sample-fetch\nname: Sample\nversion: '1'\nmodule: budget\nkind: fetch\nrun: [python3, connector.py]\nfetch:\n  hosts: [api.example.com]\n  secrets:\n    - id: token\n      label: Token\n",
  );
  writeFileSync(join(source, "connector.py"), "print('synthetic')");
  const catalog = new ConnectorCatalog(data);
  const loaded = catalog.installPending(source);
  const interpreter = resolveInterpreter(loaded);
  catalog.approve("sample-fetch", catalog.installed("sample-fetch").contentSha256, interpreter, {
    ownerAction: true,
    isCurrent: () => true,
  });
  const binding = {
    id: "binding-a",
    profileId: "profile-a",
    accountId: "account-a",
    connectorId: "sample-fetch",
    module: "budget" as const,
    enabled: true,
    params: {},
    cursor: null,
  };
  let ids: readonly string[] = [];
  let gets = 0;
  const secrets = boundConnectorSecrets({
    catalog,
    binding,
    interpreter,
    authority: { dataDir: data, lock, isCurrent: () => true, isOwnerAction: () => true },
    makeVault: (_authority, identity) => {
      ids = identity.secretIds;
      return {
        get: async () => {
          gets++;
          return "synthetic";
        },
        set: async () => {},
        clear: async () => {},
      };
    },
  });
  expect(ids).toEqual(["token"]);
  expect(await secrets.get("profile-a", "binding-a", "token")).toBe("synthetic");
  await expect(secrets.get("profile-b", "binding-a", "token")).rejects.toThrow();
  await expect(secrets.get("profile-a", "binding-a", "other_valid_id")).rejects.toThrow();
  expect(gets).toBe(1);
  catalog.disable("sample-fetch", { ownerAction: true, isCurrent: () => true });
  await expect(secrets.get("profile-a", "binding-a", "token")).rejects.toThrow();
  expect(gets).toBe(1);
  const cleared: string[] = [];
  const deletion = deletionOnlyConnectorSecrets({
    catalog,
    binding,
    authority: { dataDir: data, lock, isCurrent: () => true, isOwnerAction: () => true },
    makeCleanup: () => ({
      clear: async (id) => {
        cleared.push(id);
      },
    }),
  });
  await deletion.clear("token");
  await expect(deletion.clear("unknown")).rejects.toThrow();
  expect(cleared).toEqual(["token"]);
  lock.release();
});
