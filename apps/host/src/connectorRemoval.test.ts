import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeConnectorOwner } from "./connectorRemoval.js";
import { ConnectorCatalog } from "./connectors/catalog.js";
import type { HostStores, OpenVault } from "./stores.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync("/private/tmp/cashu-remove-connector-");
  roots.push(root);
  const data = join(root, "data"),
    source = join(root, "source");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(
    join(source, "connector.yaml"),
    "api_version: 1\nid: sample-fetch\nname: Sample\nversion: '1'\nmodule: budget\nkind: fetch\nrun: [python3, connector.py]\nfetch:\n  hosts: [example.invalid]\n  secrets: [{id: api_key, label: Key}]\n",
  );
  writeFileSync(join(source, "connector.py"), "print('synthetic')\n");
  const catalog = new ConnectorCatalog(data);
  catalog.installPending(source);
  let binding = true,
    runs = 1,
    uncertain = false,
    attemptPhase = "absent",
    extra = false,
    rebindDuringCleanup = false,
    inventoryReady = true;
  const vault = {
    id: "a".repeat(32),
    mode: "native",
    native: { isCurrent: () => true, attempts: { status: () => ({ phase: attemptPhase }) } },
    store: {
      read: (sql: string) =>
        sql.includes("connector_bindings") && binding
          ? [{ gid: "synthetic-binding" }, ...(extra ? [{ gid: "new-binding" }] : [])]
          : [],
    },
  } as unknown as OpenVault;
  const stores = {
    vaults: new Map([[vault.id, vault]]),
    device: {
      queue: { run: async (fn: () => unknown) => fn() },
      store: {
        read: () => [{ n: runs }],
        removeConnectorRuns: () => {
          const old = runs;
          runs = 0;
          return old;
        },
      },
    },
  } as unknown as HostStores;
  const steps: string[] = [];
  const input = {
    stores,
    catalog,
    id: "sample-fetch",
    dataDir: data,
    lock: { held: true } as never,
    now: () => Date.parse("2026-11-04T00:00:00Z"),
    inventory: (() => ({
      fingerprint: "synthetic",
      entries: inventoryReady ? [{ vaultId: vault.id, state: "ready" }] : [],
    })) as never,
    isCurrent: () => true,
    cleanup: (() => ({
      secretIds: ["api_key"],
      clear: async (id: string) => {
        steps.push(`clear:${id}`);
        if (rebindDuringCleanup) extra = true;
      },
    })) as never,
    execute: async (_vault: OpenVault, key: string) => {
      steps.push(`command:${key}`);
      if (uncertain) return { kind: "outcome_unknown" as const, key };
      binding = false;
      return { kind: "completed" as const, value: { bindings: 1 }, eids: [] };
    },
  };
  return {
    catalog,
    source,
    input,
    steps,
    setUncertain: (value: boolean) => {
      uncertain = value;
    },
    setAttemptPhase: (value: string) => {
      attemptPhase = value;
    },
    setRebindDuringCleanup: (value: boolean) => {
      rebindDuringCleanup = value;
    },
    setInventoryReady: (value: boolean) => {
      inventoryReady = value;
    },
  };
}

it("clears known secrets before a durable binding removal, then history and catalog", async () => {
  const f = fixture();
  expect(await removeConnectorOwner(f.input)).toEqual({
    status: "completed",
    value: { bindings: 1, runs: 1 },
  });
  expect(f.steps[0]).toBe("clear:api_key");
  expect(f.steps[1]).toMatch(/^command:/);
  expect(f.catalog.list()).toEqual([]);
});

it("keeps the original binding attempt key after an uncertain native command", async () => {
  const f = fixture();
  f.setUncertain(true);
  const first = await removeConnectorOwner(f.input);
  expect(first).toMatchObject({
    status: "outcome_unknown",
    attempt: { command: "connector.owner.removeAllBindings" },
  });
  f.setAttemptPhase("may_append");
  const second = await removeConnectorOwner(f.input);
  expect(second).toMatchObject({
    status: "outcome_unknown",
    attempt: first.status === "outcome_unknown" ? first.attempt : undefined,
  });
  expect(f.catalog.list()).toHaveLength(1);
  expect(f.steps.filter((step) => step.startsWith("command:"))).toHaveLength(1);
});

it("fences a concurrent binding before the final removal command", async () => {
  const f = fixture();
  f.setRebindDuringCleanup(true);
  expect(await removeConnectorOwner(f.input)).toMatchObject({ status: "outcome_unknown" });
  expect(f.steps.filter((step) => step.startsWith("command:"))).toEqual([]);
  expect(f.catalog.removalActive("sample-fetch")).toBe(true);
  expect(() => f.catalog.installPending(f.source)).toThrow("removal in progress");
});

it("retries a known terminal refusal with a new key under the existing fence", async () => {
  const f = fixture();
  f.setUncertain(true);
  expect(await removeConnectorOwner(f.input)).toMatchObject({ status: "outcome_unknown" });
  const firstKey = f.steps.find((step) => step.startsWith("command:"));
  f.setAttemptPhase("terminal");
  f.setUncertain(false);
  expect(await removeConnectorOwner(f.input)).toMatchObject({ status: "completed" });
  const keys = f.steps.filter((step) => step.startsWith("command:"));
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(firstKey);
  expect(f.catalog.removalActive("sample-fetch")).toBe(false);
});

it("reports unknown when a resumed removal loses full native inventory", async () => {
  const f = fixture();
  f.setUncertain(true);
  expect(await removeConnectorOwner(f.input)).toMatchObject({ status: "outcome_unknown" });
  f.setInventoryReady(false);
  expect(await removeConnectorOwner(f.input)).toMatchObject({ status: "outcome_unknown" });
  expect(f.catalog.removalActive("sample-fetch")).toBe(true);
});
