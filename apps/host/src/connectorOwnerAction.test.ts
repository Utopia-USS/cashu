import { expect, it } from "vitest";
import { connectorOwnerAction } from "./connectorOwnerAction.js";
import type { ConnectorRuntime } from "./connectorRuntime.js";
import { manifestSchema } from "./connectors/manifest.js";
import type { HostStores } from "./stores.js";
import type { WorkerBindings } from "./worker/contracts.js";

const vaultId = "5f0c3a9e81d24b7690ae13c7d2f4b856";
const account = "6ad703ab-383d-8c73-82a5-1ee2d6742735";
const bindingId = "8ad703ab-383d-8c73-82a5-1ee2d6742735";
const manifest = manifestSchema.parse({
  api_version: 1,
  id: "synthetic-fetch",
  name: "Synthetic",
  version: "1",
  module: "budget",
  kind: "fetch",
  run: ["./true"],
  fetch: { hosts: ["example.test"], secrets: [{ id: "token", label: "Token" }] },
});

it("uses a migrated UUID8 account and returned UUID8 binding for secrets, run and removal", async () => {
  let row: {
    gid: string;
    account: string;
    connector_id: string;
    params_json: string;
    cursor: null;
    auto_commit: number;
  } | null = null;
  const writes: string[] = [];
  const read = <R>(sql: string): R[] => {
    if (sql.includes("FROM profile_modules")) return [{ module_id: "budget" }] as R[];
    if (sql.includes("FROM accounts") && sql.includes("type =")) return [];
    if (sql.includes("FROM accounts"))
      return [{ gid: account, name: "Synthetic", type: "checking", removed: 0 }] as R[];
    if (sql.includes("FROM connector_bindings"))
      return row ? ([{ ...row, account_gid: row.account }] as R[]) : [];
    return [];
  };
  const loaded = {
    root: "/usr/bin",
    manifest,
    files: [{ path: "true", size: 1, sha256: "a".repeat(64), executable: true }],
    contentSha256: "a".repeat(64),
  };
  const catalog = {
    installed: () => loaded,
    approved: () => loaded,
  } as unknown as ConnectorRuntime["catalog"];
  const vault = {
    id: vaultId,
    mode: "native",
    store: { read },
    native: { isCurrent: () => true, canFetchPublicMarket: () => true },
    queue: { run: async (fn: () => unknown) => fn() },
  };
  const stores = { vaults: new Map([[vaultId, vault]]) } as unknown as HostStores;
  const runtime = {
    catalog,
    runOne: async (_vault: unknown, _id: string, guard: () => void) => {
      guard();
      writes.push("run");
      return { status: "ok", stats: { stored: 1 } };
    },
  } as unknown as ConnectorRuntime;
  const worker = { ownership: { isExclusive: () => true } } as unknown as WorkerBindings;
  let unknown = false;
  const action = connectorOwnerAction({
    runtime: () => runtime,
    worker: () => worker,
    dataDir: "/synthetic",
    lock: () => ({ held: true }) as never,
    now: () => 1,
    execute: async (_vault, command) => {
      if (unknown) return { kind: "outcome_unknown", key: "synthetic-attempt" };
      const result = command.run(
        {
          vault: vaultId,
          lease: { isHolder: () => true },
          read,
          det: () => bindingId,
          emit: (type: string, _gid: string, data: Record<string, unknown>) => {
            writes.push(type);
            if (type === "connectorBinding.set")
              row = {
                gid: bindingId,
                account,
                connector_id: "synthetic-fetch",
                params_json: JSON.stringify(data.params),
                cursor: null,
                auto_commit: 0,
              };
            if (type === "connectorBinding.removed") row = null;
            return "event";
          },
        } as never,
        {},
      );
      return result.ok
        ? { kind: "completed", value: result.value, eids: ["event"] }
        : { kind: "refused", reason: result.reason };
    },
    makeSecrets: () => ({
      get: async () => null,
      set: async () => {
        writes.push("secret");
      },
      clear: async () => {
        writes.push("clear");
      },
    }),
  });
  const bound = await action.run(stores, vaultId, {
    op: "bind",
    id: "synthetic-fetch",
    account,
    params: {},
    autoCommit: false,
  });
  expect(bound).toMatchObject({ status: "completed", value: { binding: bindingId } });
  expect(
    await action.run(stores, vaultId, {
      op: "setSecret",
      binding: bindingId,
      secret: "token",
      value: "synthetic",
    }),
  ).toMatchObject({ status: "completed" });
  expect(await action.run(stores, vaultId, { op: "run", binding: bindingId })).toMatchObject({
    status: "completed",
  });
  unknown = true;
  const removal = await action.run(stores, vaultId, { op: "unbind", binding: bindingId });
  expect(removal).toMatchObject({
    status: "outcome_unknown",
    attempt: { key: "synthetic-attempt", command: "connector.owner.unbind" },
  });
  expect(await action.run(stores, vaultId, { op: "unbind", binding: bindingId })).toEqual(removal);
  expect(writes).toEqual(["connectorBinding.set", "secret", "run"]);
});

it("routes confirmed owner Settings removal to the native deletion service", async () => {
  const vault = {
    id: vaultId,
    mode: "native",
    native: { isCurrent: () => true, canFetchPublicMarket: () => true },
  };
  const stores = { vaults: new Map([[vaultId, vault]]) } as unknown as HostStores;
  const removed: string[] = [];
  const action = connectorOwnerAction({
    runtime: () => ({ catalog: {} }) as ConnectorRuntime,
    worker: () => undefined,
    dataDir: "/synthetic",
    lock: () => ({ held: true }) as never,
    now: () => 1,
    remove: async (input) => {
      removed.push(input.id);
      return { status: "completed", value: { bindings: 2, runs: 3 } };
    },
  });
  expect(await action.run(stores, vaultId, { op: "remove", id: "synthetic-fetch" })).toMatchObject({
    status: "refused",
  });
  expect(
    await action.run(stores, vaultId, { op: "remove", id: "synthetic-fetch", allVaults: true }),
  ).toEqual({
    status: "completed",
    value: { bindings: 2, runs: 3 },
  });
  expect(removed).toEqual(["synthetic-fetch"]);
});
