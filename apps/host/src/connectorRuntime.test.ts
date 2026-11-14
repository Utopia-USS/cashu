import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand, investmentsCommands, ok } from "@cashu/store";
import { DailyPriceLock } from "@cashu/store/investments/services";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  CONNECTOR_MIN_INTERVAL_MS,
  connectorDecision,
  connectorFetchFinish,
  createConnectorRuntime,
  RATE_LIMIT_BACKOFF_MS,
} from "./connectorRuntime.js";
import { documentRecords } from "./connectors/document.js";
import type { OpenVault } from "./stores.js";
import { cleanup, tempDir } from "./testing/harness.js";
import { command, workerFixture } from "./testing/worker.js";

afterEach(cleanup);

it("keeps the first empty fetch inert and records later empty fetches without daily proposals", () => {
  expect(connectorDecision(false, false, false)).toBe("nothing");
  expect(connectorDecision(false, false, true)).toBe("nothing");
  expect(connectorDecision(false, true, false)).toBe("commit");
  expect(connectorDecision(false, true, true)).toBe("commit");
  expect(connectorDecision(true, false, true)).toBe("proposal");
  expect(connectorDecision(true, true, false)).toBe("proposal");
  expect(connectorDecision(true, true, true)).toBe("commit");
});

it("moves a binding's fetch state: status always, last ok on a commit, 48 h backoff on rate limit", () => {
  const at = "2026-11-04T12:00:00.000Z";
  const now = Date.parse(at) + 1000;
  expect(connectorFetchFinish("ok", null, true, at, now)).toEqual({
    lastStatus: "ok",
    lastOkAt: at,
  });
  expect(connectorFetchFinish("ok", null, false, at, now)).toEqual({ lastStatus: "ok" });
  expect(connectorFetchFinish("failed", "rate_limited", false, at, now)).toEqual({
    lastStatus: "failed",
    backoffUntil: new Date(now + RATE_LIMIT_BACKOFF_MS).toISOString(),
  });
  expect(RATE_LIMIT_BACKOFF_MS).toBe(48 * 3_600_000);
});

it("counts a document's records", () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  expect(documentRecords("budget", bytes({ transactions: [{}, {}], records: [{}] }))).toBe(2);
  expect(documentRecords("investments", bytes({ records: [{}, {}, {}] }))).toBe(3);
  expect(documentRecords("investments", bytes({ records: {} }))).toBe(0);
  expect(documentRecords("budget", bytes([1, 2]))).toBe(0);
  expect(documentRecords("budget", new TextEncoder().encode("{"))).toBe(0);
});

it("skips a binding a scheduled run tried less than 20 h ago, runs it for the owner, and records the binding", async () => {
  const f = await workerFixture();
  const synthetic = f.vaults[0];
  if (synthetic === undefined) throw new Error("synthetic vault absent");
  // The fetch path checks the vault mode only; nothing here reaches the native session.
  const vault = { ...synthetic, mode: "native" } as unknown as OpenVault;
  let now = Date.parse("2026-11-06T08:00:00.000Z");
  const device = f.context.stores.device.store;
  const runtime = createConnectorRuntime({
    dataDir: tempDir(),
    lock: { held: true } as never,
    device,
    stores: f.context.stores,
    dailyLock: new DailyPriceLock(),
    current: () => true,
    holder: () => true,
    now: () => now,
  });
  try {
    const source = join(tempDir(), "source");
    mkdirSync(source, { mode: 0o700 });
    writeFileSync(
      join(source, "connector.yaml"),
      "api_version: 1\nid: synthetic-fetch\nname: Synthetic\nversion: '1'\nmodule: budget\nkind: fetch\nrun: [python3, connector.py]\nfetch:\n  hosts: [api.example.test]\n",
    );
    writeFileSync(join(source, "connector.py"), "print('{}')\n");
    runtime.catalog.installPending(source);
    // A budget connector bound to a brokerage account fails before any process starts (a recorded bad_request run).
    const account = await command(vault, investmentsCommands.addBrokerageAccount, {
      name: "Synthetic broker",
      broker: "dif",
    });
    const { binding } = await command(
      vault,
      defineCommand({
        id: "test.connectorBinding.set",
        input: z.object({}),
        run(ctx) {
          const gid = ctx.det("connector_bindings", [account.account, "synthetic-fetch"]);
          ctx.emit("connectorBinding.set", gid, {
            account: account.account,
            connectorId: "synthetic-fetch",
            params: {},
            autoCommit: false,
          });
          return ok({ binding: gid });
        },
      }),
      {},
    );
    const runs = () =>
      device.read<{ binding: string | null; errorKind: string | null }>(
        "SELECT binding, error_kind AS errorKind FROM connector_runs ORDER BY id",
      );
    device.updateConnectorFetch(vault.id, binding, {
      lastRunAt: new Date(now - CONNECTOR_MIN_INTERVAL_MS + 60_000).toISOString(),
    });
    expect(await runtime.worker.fetch(vault, () => {})).toEqual({
      status: "ok",
      stats: { stored: 0, skipped: 1, failed: 0 },
    });
    expect(runs()).toEqual([]);
    expect(await runtime.runOne(vault, binding, () => {})).toMatchObject({ status: "failed" });
    expect(runs()).toEqual([{ binding, errorKind: "bad_request" }]);
    now += 60_000;
    expect(await runtime.worker.fetch(vault, () => {})).toMatchObject({
      status: "failed",
      stats: { failed: 1 },
    });
    expect(runs()).toHaveLength(2);
  } finally {
    await f.close();
  }
});
