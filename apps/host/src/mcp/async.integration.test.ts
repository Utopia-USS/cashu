/** Real host queue/socket proofs; all files, names and instruments are synthetic. */
import { market } from "@cashu/domain/investments";
import { decodeEntityRef, investmentSearchIo, type NativePreparationExecution } from "@cashu/mcp";
import { connectHost } from "@cashu/node-host";
import {
  investmentsCommands as C,
  runCommand,
  investmentsServices as S,
  setModules,
  setProfileSettings,
} from "@cashu/store";
import { afterEach, expect, it, vi } from "vitest";
import { startLocalHost } from "../host.js";
import { memoryLog } from "../log.js";
import { currentRuntime } from "../runtime.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { initializeMcp, mcpClient } from "../testing/mcp.js";
import { nativeRuntime } from "./native.js";
import * as pythonMcp from "./python.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());
it("rejects and observes accidental preparation promises and revokes escaped read/lazy contexts", async () => {
  const dataDir = tempDir(),
    log = memoryLog();
  const host = await startLocalHost({
    ...testHostOptions(dataDir),
    log,
    launcher: false,
    python: null,
  });
  const release = deferred<void>(),
    finished = deferred<void>();
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    const runtime = nativeRuntime({
      stores: host.stores,
      vault,
      dataDir,
      now: Date.now,
      replaced: () => false,
      log,
      inventory: [],
    });
    let escaped: NativePreparationExecution | undefined;
    const pending = runtime.preparations?.execute(undefined, async (execution) => {
      if (!execution) throw new Error("missing synthetic preparation");
      escaped = execution;
      expect("commit" in execution).toBe(false);
      await release.promise;
      try {
        expect(() => execution.context.store.read("SELECT 1")).toThrow("no longer active");
      } finally {
        finished.resolve();
      }
    });
    await expect(pending).rejects.toThrow("must be synchronous");
    expect(await runtime.execute(undefined, (execution) => execution !== undefined)).toBe(true);
    if (!escaped) throw new Error("missing escaped test context");
    const expired = escaped;
    expect(() => expired.context.store.read("SELECT 1")).toThrow("no longer active");
    expect(() => expired.context.guard).toThrow("no longer active");
    expect(() => expired.context.accountLabels).toThrow("no longer active");
    release.resolve();
    await finished.promise;
    // Controlled profile-query absence exercises the early branch without changing any schema/log.
    const originalRead = vault.store.read.bind(vault.store);
    const absentRead: typeof vault.store.read = (sql, ...params) =>
      sql.includes("FROM profiles") ? [] : originalRead(sql, ...params);
    vi.spyOn(vault.store, "read").mockImplementation(absentRead);
    const missingRelease = deferred<void>(),
      missingFinished = deferred<void>();
    const missing = nativeRuntime({
      stores: host.stores,
      vault,
      dataDir,
      now: Date.now,
      replaced: () => false,
      log: {
        ...log,
        warn() {
          throw new Error("synthetic diagnostic failure");
        },
      },
      inventory: [],
    });
    const absentPending = missing.preparations?.execute(undefined, async (execution) => {
      expect(execution).toBeUndefined();
      await missingRelease.promise;
      missingFinished.resolve();
      throw new Error("synthetic rejected callback details");
    });
    await expect(absentPending).rejects.toThrow("must be synchronous");
    expect(await vault.queue.run(() => true)).toBe(true);
    missingRelease.resolve();
    await missingFinished.promise;
  } finally {
    release.resolve();
    await host.stop();
  }
});
it("native socket search releases the actual vault queue, rebuilds refs/privacy and starts no Python", async () => {
  const spy = vi.spyOn(pythonMcp, "startPythonMcp"),
    dataDir = tempDir();
  const entered = deferred<void>(),
    answer = deferred<readonly market.SearchHit[]>();
  let lookups = 0,
    closes = 0;
  const host = await startLocalHost({
    ...testHostOptions(dataDir),
    launcher: false,
    python: null,
    runtime: { ...currentRuntime(), checkout: undefined },
    mcpInvestmentAsync: (vault) => ({
      vault,
      search: investmentSearchIo(
        vault,
        new S.InstrumentSearch(() => 1),
        () => ({
          symbols: {
            async search() {
              lookups++;
              entered.resolve();
              return await answer.promise;
            },
          },
          close() {
            closes++;
          },
        }),
        () => true,
      ),
    }),
  });
  let connection: Awaited<ReturnType<typeof connectHost>> | undefined;
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    await vault.queue.run(() => {
      for (const [command, input] of [
        [setModules, { moduleIds: ["investments"] }],
        [setProfileSettings, { mcpPrivacy: "amounts" }],
      ] as const) {
        const result = runCommand(
          vault.store,
          vault.writer,
          command as typeof setModules,
          input,
          vault.env,
        );
        if (!result.ok) throw new Error(result.reason);
      }
    });
    connection = await connectHost({ dataDir, role: "mcp", profile: "demo", build: "test" });
    const channel = connection;
    const client = mcpClient(
      (line) => channel.send({ t: "mcp", line }),
      (callback) =>
        channel.onFrame((frame) => {
          if (frame.t === "mcp") callback(frame.line);
        }),
    );
    await connection.call("mcp.open", { cwd: tempDir(), env: {} });
    await initializeMcp(client);
    const pending = client.call("tools/call", {
      name: "search_instruments",
      arguments: { query: "unmatched" },
    });
    await entered.promise;
    const created = await vault.queue.run(() => {
      const changed = runCommand(
        vault.store,
        vault.writer,
        setProfileSettings,
        { mcpPrivacy: "strict" },
        vault.env,
      );
      if (!changed.ok) throw new Error(changed.reason);
      const result = runCommand(
        vault.store,
        vault.writer,
        C.addToWatchlist,
        {
          target: {
            planned: {
              symbol: "ABC",
              name: "Synthetic Public",
              currency: "PLN",
              assetClass: "equity",
              aliases: [{ namespace: "yahoo", value: "ABC.WA", guessed: false }],
            },
          },
        },
        vault.env,
      );
      if (!result.ok) throw new Error(result.reason);
      return result.value;
    });
    answer.resolve(
      market.parseYahooSearch(
        JSON.stringify({
          quotes: [
            {
              symbol: "ABC.WA",
              shortname: "Synthetic Public",
              quoteType: "EQUITY",
              exchange: "WSE",
            },
          ],
        }),
      ),
    );
    const wire = (await pending).result as {
      isError: boolean;
      structuredContent: {
        local: { key: string; instrument_id: string; state: string }[];
        remote: unknown[];
        remote_status: string;
      };
    };
    expect(wire.isError).toBe(false);
    const row = wire.structuredContent.local[0];
    if (!row) throw new Error("missing native hit");
    expect(decodeEntityRef("instrument", row.instrument_id)).toBe(created.instrument);
    expect(row.key).toBe(`i:${row.instrument_id}`);
    expect(row.state).toBe("watched");
    expect(wire.structuredContent.remote).toEqual([]);
    expect(wire.structuredContent.remote_status).toBe("ok");
    expect(lookups).toBe(1);
    expect(closes).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    answer.resolve([]);
    connection?.close();
    await host.stop();
  }
});
it("native socket import uses checked file bytes and returned proposal ref roundtrips genuine T28 commands", async () => {
  const { writeFileSync } = await import("node:fs"),
    { join } = await import("node:path");
  const { sha256Hex } = await import("@cashu/domain");
  const { encodeEntityRef } = await import("@cashu/mcp");
  const { approvePrepared, proposalExecution } = await import("@cashu/store/core");
  const { transactions } = await import("@cashu/store/investments/queries");
  const spy = vi.spyOn(pythonMcp, "startPythonMcp"),
    dataDir = tempDir(),
    exportDir = tempDir(),
    legacyDir = tempDir();
  const path = join(exportDir, "synthetic.csv");
  const content = new TextEncoder().encode(
    "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source\n1,txn,2026-01-01,,deposit,D,,,,,,,PLN,,,,1000,PLN,,,generic_csv\n",
  );
  writeFileSync(path, content, { mode: 0o600 });
  const blobs = new Map<string, Uint8Array>();
  let published = 0,
    readbacks = 0;
  let publication: S.ImportPublication | undefined;
  const host = await startLocalHost({
    ...testHostOptions(dataDir),
    launcher: false,
    python: null,
    mcpLegacyDataDir: legacyDir,
    runtime: { ...currentRuntime(), checkout: undefined },
    mcpInvestmentAsync: (vault) => {
      publication = {
        vault,
        binding: Object.freeze({}),
        isCurrent: () => true,
        async publish(bytes, expected) {
          published++;
          const blob = { sha256: sha256Hex(bytes), ext: expected.ext };
          blobs.set(blob.sha256, Uint8Array.from(bytes));
          return { blob, privateStage: null };
        },
        async read(actualVault, blob, max) {
          readbacks++;
          expect(actualVault).toBe(vault);
          expect(max).toBeGreaterThan(content.length);
          const bytes = blobs.get(blob.sha256);
          return bytes ? Uint8Array.from(bytes) : null;
        },
        async discardPrivateStage() {
          throw new Error("no private stage was issued");
        },
      };
      return { vault, imports: publication };
    },
  });
  let connection: Awaited<ReturnType<typeof connectHost>> | undefined;
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    const account = await vault.queue.run(() => {
      const modules = runCommand(
        vault.store,
        vault.writer,
        setModules,
        { moduleIds: ["investments"] },
        vault.env,
      );
      if (!modules.ok) throw new Error(modules.reason);
      const result = runCommand(
        vault.store,
        vault.writer,
        C.addBrokerageAccount,
        { name: "Synthetic broker", broker: "dif" },
        vault.env,
      );
      if (!result.ok) throw new Error(result.reason);
      return result.value.account;
    });
    connection = await connectHost({ dataDir, role: "mcp", profile: "demo", build: "test" });
    const channel = connection;
    const client = mcpClient(
      (line) => channel.send({ t: "mcp", line }),
      (callback) =>
        channel.onFrame((frame) => {
          if (frame.t === "mcp") callback(frame.line);
        }),
    );
    await connection.call("mcp.open", { cwd: exportDir, env: {} });
    await initializeMcp(client);
    const call = async (accountRef: string) =>
      (
        await client.call("tools/call", {
          name: "propose_import",
          arguments: { path, account: accountRef, importer: "cashu" },
        })
      ).result as {
        isError: boolean;
        structuredContent?: { stored: boolean; proposal_id: string };
      };
    const wrong = await call(encodeEntityRef("instrument", account));
    expect(wrong.isError).toBe(true);
    expect(published).toBe(0);
    const result = await call(encodeEntityRef("account", account));
    expect(result.isError).toBe(false);
    if (!result.structuredContent) throw new Error("missing native proposal response");
    const id = decodeEntityRef("proposal", result.structuredContent.proposal_id);
    const snapshot = await vault.queue.run(() =>
      proposalExecution(vault.store.read.bind(vault.store), id),
    );
    if (!snapshot || !publication) throw new Error("missing actual pending import");
    expect(snapshot.payload).toMatchObject({
      account,
      blob: { sha256: sha256Hex(content), ext: "csv" },
    });
    expect(snapshot.payload).not.toHaveProperty("account_id");
    expect(snapshot.payload).not.toHaveProperty("staged");
    // Explicit synthetic authority port, never the host's transitional placeholder lease.
    const authority = { isHolder: () => true };
    const prepared = await S.prepareInvestmentImport(
      {
        store: vault.store,
        blobs: publication,
        isHolder: (id) => id === vault.id && authority.isHolder(),
        now: Date.now,
      },
      snapshot,
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    let appends = 0;
    const approved = await vault.queue.run(() =>
      runCommand(
        vault.store,
        {
          append(events) {
            appends++;
            vault.writer.append(events);
          },
        },
        approvePrepared(prepared.value),
        {},
        { ...vault.env, lease: authority },
      ),
    );
    expect(approved.ok).toBe(true);
    expect(appends).toBe(1);
    expect(transactions(vault.store.read.bind(vault.store))).toHaveLength(1);
    expect(published).toBe(1);
    expect(readbacks).toBe(2);
    expect(blobs.size).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    connection?.close();
    await host.stop();
  }
});
it("refuses an ambiguous native slug before Python start or native provider dispatch", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs"),
    { join } = await import("node:path");
  const { openNodeSqlite } = await import("@cashu/node-host/sqlite");
  const { builtinModules, createProfile, HybridClock, Store, storeWriter, vaultSalt } =
    await import("@cashu/store");
  const { storeFiles } = await import("../stores.js");
  const dataDir = tempDir(),
    files = storeFiles(dataDir),
    ids = ["11111111111111111111111111111111", "22222222222222222222222222222222"];
  mkdirSync(files.vaultDir, { recursive: true, mode: 0o700 });
  for (const [index, id] of ids.entries()) {
    const salt = new Uint8Array(32).fill(index + 17),
      path = join(files.vaultDir, `${id}.db`);
    writeFileSync(path, "", { mode: 0o600 });
    writeFileSync(join(files.vaultDir, `${id}.salt`), Buffer.from(salt).toString("hex"), {
      mode: 0o600,
    });
    const store = Store.open({
      driver: openNodeSqlite(path),
      vault: id,
      salt: vaultSalt(salt),
      modules: builtinModules(),
    });
    try {
      const device = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        clock = { now: () => Date.parse("2026-11-01T12:00:00Z") };
      const created = runCommand(
        store,
        storeWriter(store),
        createProfile,
        { slug: "duplicate", name: `Synthetic profile ${index}` },
        {
          device,
          clock,
          hlc: new HybridClock(device, { physical: clock }),
          lease: { isHolder: () => false },
        },
      );
      if (!created.ok) throw new Error(created.reason);
    } finally {
      store.close();
    }
  }
  const spy = vi.spyOn(pythonMcp, "startPythonMcp").mockImplementation(() => {
    throw new Error("unexpected synthetic child dispatch");
  });
  let providerCalls = 0;
  const host = await startLocalHost({
    ...testHostOptions(dataDir),
    launcher: false,
    python: { command: process.execPath, args: [] },
    mcpInvestmentAsync: () => {
      providerCalls++;
      return undefined;
    },
  });
  let connection: Awaited<ReturnType<typeof connectHost>> | undefined;
  try {
    expect(host.stores.vaults.size).toBe(2);
    connection = await connectHost({ dataDir, role: "mcp", profile: "duplicate", build: "test" });
    let message = "";
    try {
      await connection.call("mcp.open", { cwd: tempDir(), env: {} });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("duplicate");
    for (const id of ids) expect(message).not.toContain(id);
    expect(message).not.toContain("Synthetic profile");
    expect(spy).not.toHaveBeenCalled();
    expect(providerCalls).toBe(0);
  } finally {
    connection?.close();
    await host.stop();
  }
});
