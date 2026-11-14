import { NativeMcpServer } from "@cashu/mcp";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { defineCommand, ok, runCommand, setModules } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { SqlAttemptJournal } from "../attemptJournal.js";
import { startLocalHost } from "../host.js";
import type { NativeVaultSession } from "../nativeVault.js";
import type { OpenVault } from "../stores.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { nativeRuntime } from "./native.js";

afterEach(cleanup);

it("keeps the original MCP key unknown after an invoked native engine write fails", async () => {
  const dataDir = tempDir();
  const host = await startLocalHost({ ...testHostOptions(dataDir), launcher: false });
  const original = [...host.stores.vaults.values()][0];
  if (!original) throw new Error("missing synthetic vault");
  const driver = openNodeSqlite(`${dataDir}/attempts-test.db`);
  try {
    await original.queue.run(() =>
      runCommand(
        original.store,
        original.writer,
        setModules,
        {
          moduleIds: ["budget", "investments"],
        },
        original.env,
      ),
    );
    const attempts = SqlAttemptJournal.open(driver, "new", Date.now);
    let invoked = 0;
    const native = {
      id: original.id,
      store: original.store,
      device: original.env.device,
      queue: original.queue,
      attempts,
      engine: {
        vault: original.id,
        device: original.env.device,
        async write() {
          invoked++;
          throw new Error("synthetic fault after engine invocation");
        },
      } as unknown as NativeVaultSession["engine"],
      epoch: {},
      isCurrent: () => true,
      canRunSideEffects: () => true,
    } as NativeVaultSession;
    const vault = { ...original, mode: "native", native } as OpenVault;
    (host.stores.vaults as Map<string, OpenVault>).set(vault.id, vault);
    const runtime = nativeRuntime({
      stores: host.stores,
      vault,
      dataDir,
      now: Date.now,
      replaced: () => false,
      log: testHostOptions(dataDir).log,
      inventory: [],
    });
    const { coreTools } = await import("@cashu/mcp");
    const tool = coreTools().find((entry) => entry.name === "mark_review_done");
    if (!tool) throw new Error("missing review tool");
    const server = new NativeMcpServer(runtime, [tool]);
    const key = "01K9B2W000000000000000000C";
    const first = await server.call("mark_review_done", { module: "investments" }, undefined, key);
    expect(first).toMatchObject({ ok: false, errorKind: "outcome_unknown", requestKey: key });
    expect(invoked).toBe(1);
    expect(await runtime.writeStatus?.(key)).toEqual({ kind: "outcome_unknown" });
    expect(await runtime.writeStatus?.("01K9B2W000000000000000000F")).toEqual({
      kind: "outcome_unknown",
    });
    const repeated = await server.call(
      "mark_review_done",
      { module: "investments" },
      undefined,
      key,
    );
    expect(repeated).toMatchObject({ ok: false, errorKind: "outcome_unknown", requestKey: key });
    expect(invoked).toBe(1);
    const connectorKey = "01K9B2W000000000000000000D";
    let proposed = 0;
    const connectorRuntime = nativeRuntime({
      stores: host.stores,
      vault,
      dataDir,
      now: Date.now,
      replaced: () => false,
      log: testHostOptions(dataDir).log,
      inventory: [],
      connectors: {
        proposalStatus: (candidate: string) =>
          candidate === connectorKey ? "completed" : "absent",
        list: async () => ({ installed: [], catalog: [] }),
        testFile: async () => {
          throw new Error("unused");
        },
        propose: async () => {
          proposed++;
          throw new Error("connector_path_invalid");
        },
      } as never,
    });
    const financialCollision = await new NativeMcpServer(connectorRuntime, [tool]).call(
      "mark_review_done",
      { module: "investments" },
      undefined,
      connectorKey,
    );
    expect(financialCollision).toMatchObject({
      ok: false,
      errorKind: "outcome_unknown",
      requestKey: connectorKey,
    });
    expect(invoked).toBe(1);
    await expect(
      connectorRuntime.execute(
        undefined,
        async (execution) => {
          if (!execution) throw new Error("missing native execution");
          return execution.context.store.connectors?.propose({ catalogId: "sample" });
        },
        key,
      ),
    ).rejects.toMatchObject({ kind: "outcome_unknown" });
    expect(proposed).toBe(0);
    await expect(
      connectorRuntime.execute(
        undefined,
        async (execution) => {
          if (!execution) throw new Error("missing native execution");
          return execution.context.store.connectors?.propose({ path: "invalid" });
        },
        "01K9B2W000000000000000000G",
      ),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(proposed).toBe(1);
    expect(original.store.read("SELECT COUNT(*) AS n FROM reviews")).toEqual([{ n: 0 }]);
    const noEvent = defineCommand({
      id: "core.syntheticMcpNoEvent",
      input: z.object({}),
      run: () => ok(null),
    });
    const noEventKey = "01K9B2W000000000000000000E";
    await runtime.execute(
      undefined,
      async (execution) => {
        if (!execution) throw new Error("missing native execution");
        expect((await execution.context.store.run(noEvent, {})).ok).toBe(true);
        expect(() => execution.context.store.run(noEvent, {})).toThrow("multiple native MCP");
        execution.commit();
      },
      noEventKey,
    );
    expect(await runtime.writeStatus?.(noEventKey)).toEqual({ kind: "completed" });
    expect(invoked).toBe(1);
    driver.prepare("UPDATE host_attempts SET completed_at = 1 WHERE key = ?").run(noEventKey);
    attempts.pruneReceipts();
    expect(await runtime.writeStatus?.(noEventKey)).toEqual({ kind: "completed" });
    const refusedKey = "01K9B2W000000000000000000J";
    await attempts.recordTerminal({
      vault: original.id,
      key: refusedKey,
      attemptId: "01K9B2W000000000000000000K",
      commandId: "core.syntheticRefusal",
      fingerprint: "synthetic",
      result: { kind: "refused", reason: "synthetic_refusal" },
    });
    expect(await runtime.writeStatus?.(refusedKey)).toEqual({
      kind: "refused",
      reason: "synthetic_refusal",
    });
  } finally {
    (host.stores.vaults as Map<string, OpenVault>).set(original.id, original);
    driver.close();
    await host.stop();
  }
});
