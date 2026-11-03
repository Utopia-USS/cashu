import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { adminStatusResultSchema } from "@cashu/host-protocol";
import type { StoreToClient } from "@cashu/host-protocol/store";
import { connectHost, HostBusyError } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  createProfile,
  type EventWriter,
  HybridClock,
  mintUlid,
  renameProfile,
  runCommand,
  Store,
  vaultSalt,
} from "@cashu/store";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalHost } from "./host.js";
import { WriterLease } from "./lease.js";
import { main } from "./main.js";
import { storeFiles } from "./stores.js";
import { cleanup, storeClient, tempDir, testHostOptions } from "./testing/harness.js";

afterEach(cleanup);

interface LogRow {
  seq: number;
  eid: string;
  hlc: string;
  type: string;
}

/** The vault's event log, read after the host stopped (it holds the file exclusively while running). */
function readLog(dataDir: string, vault: string): LogRow[] {
  const db = new DatabaseSync(join(storeFiles(dataDir).vaultDir, `${vault}.db`), {
    readOnly: true,
  });
  try {
    return db
      .prepare("SELECT seq, eid, hlc, type FROM event_log ORDER BY seq")
      .all() as unknown as LogRow[];
  } finally {
    db.close();
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("local host", () => {
  it("refuses ordinary open without a native provider before creating host files", async () => {
    const dir = tempDir();
    await expect(startLocalHost({ dataDir: dir, home: tempDir() })).rejects.toThrow(
      "native_vault_provider_unavailable",
    );
    expect(existsSync(join(dir, "run"))).toBe(false);
  });
  it("serves the store channel: vaults at ready, live queries, keyed commands", async () => {
    const dir = tempDir();
    const host = await startLocalHost(testHostOptions(dir));
    const client = await storeClient(dir);
    const [vault] = client.vaults;
    expect(client.vaults).toHaveLength(1);
    const current = await client.subscribe("device.currentVault", "device");
    expect(current.first).toBe(vault);
    const profile = await client.subscribe("core.profile", vault as string);
    expect(profile.first).toMatchObject({ name: "Demo" });
    expect(await client.run("core.renameProfile", { name: "Renamed" }, { vault })).toEqual({
      ok: true,
      value: null,
    });
    await wait(20);
    expect(profile.values.at(-1)).toMatchObject({ name: "Renamed" });
    await expect(client.run("core.nope", {}, { vault })).rejects.toThrow("UnknownCommand");
    await expect(client.run("core.renameProfile", { name: "x" })).rejects.toThrow(
      "UnknownTargetError",
    );
    client.close();
    expect(await host.stop()).toBe(0);
  });

  it("orders two clients writing concurrently into one monotonic device stream", async () => {
    const dir = tempDir();
    const host = await startLocalHost(testHostOptions(dir));
    const a = await storeClient(dir);
    const b = await storeClient(dir);
    const vault = a.vaults[0] as string;
    const runs = Array.from({ length: 40 }, (_, i) => [
      a.run("core.renameProfile", { name: `a ${i}` }, { vault }),
      b.run("core.renameProfile", { name: `b ${i}` }, { vault }),
    ]).flat();
    const results = await Promise.all(runs);
    expect(results.every((r) => r.ok)).toBe(true);
    a.close();
    b.close();
    await host.stop();

    const log = readLog(dir, vault);
    expect(log.filter((r) => r.type === "profile.renamed")).toHaveLength(80);
    expect(new Set(log.map((r) => r.eid)).size).toBe(log.length);
    for (let i = 1; i < log.length; i++) {
      expect((log[i] as LogRow).hlc > (log[i - 1] as LogRow).hlc).toBe(true);
    }
  });

  it("answers a resent key from the request table instead of applying it again", async () => {
    const dir = tempDir();
    const host = await startLocalHost(testHostOptions(dir));
    const client = await storeClient(dir);
    const vault = client.vaults[0] as string;
    const key = mintUlid(Date.now());
    const first = await client.run("core.renameProfile", { name: "Once" }, { vault, key });
    await client.run("core.renameProfile", { name: "Other" }, { vault });
    // The resend comes after another rename: re-applying it would rename back to "Once".
    expect(await client.run("core.renameProfile", { name: "Once" }, { vault, key })).toEqual(first);
    expect(await client.run("core.setProfileSettings", {}, { vault, key })).toEqual({
      ok: false,
      reason: "request_key_conflict",
    });
    const deviceKey = mintUlid(Date.now());
    const set = await client.run("device.setCurrentVault", { vault }, { key: deviceKey });
    expect(await client.run("device.setCurrentVault", { vault }, { key: deviceKey })).toEqual(set);
    client.close();
    await host.stop();
    expect(readLog(dir, vault).filter((r) => r.type === "profile.renamed")).toHaveLength(2);
  });

  it("keeps a lookup unknown while the original keyed write is waiting in the queue", async () => {
    const dir = tempDir();
    const host = await startLocalHost(testHostOptions(dir));
    const client = await storeClient(dir);
    const vault = client.vaults[0] as string;
    const opened = host.stores.vaults.get(vault);
    if (!opened) throw new Error("missing vault");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = opened.queue.run(() => held);
    const key = mintUlid(Date.now());
    const replies: StoreToClient[] = [];
    client.conn.onFrame((frame) => {
      if (frame.t === "store") replies.push(frame.m as StoreToClient);
    });
    client.conn.send({
      t: "store",
      m: {
        t: "run",
        rid: 901,
        generation: 0,
        key,
        target: { kind: "vault", vault },
        command: "core.renameProfile",
        input: { name: "Queued" },
      },
    });
    client.conn.send({
      t: "store",
      m: {
        t: "lookup",
        rid: 900,
        generation: 0,
        key,
        target: { kind: "vault", vault },
        command: "core.renameProfile",
      },
    });
    await expect
      .poll(() => replies.find((reply) => reply.t === "lookupResult" && reply.rid === 900))
      .toMatchObject({ outcome: { kind: "outcome_unknown" } });
    release();
    await blocker;
    await expect
      .poll(() => replies.find((reply) => reply.t === "result" && reply.rid === 901))
      .toMatchObject({ outcome: { kind: "completed", value: null } });
    client.close();
    await host.stop();
  });

  it("refuses a foreign open of its stores and a second host", async () => {
    const dir = tempDir();
    const host = await startLocalHost(testHostOptions(dir));
    const vault = [...host.stores.vaults.keys()][0] as string;
    const path = join(storeFiles(dir).vaultDir, `${vault}.db`);
    const foreign = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         try { new DatabaseSync(process.argv[1]).prepare("SELECT count(*) FROM event_log").get(); console.log("opened"); }
         catch (e) { console.log(String(e.message)); }`,
        path,
      ],
      { encoding: "utf8" },
    );
    expect(foreign.stdout).toMatch(/locked/);
    await expect(startLocalHost(testHostOptions(dir))).rejects.toBeInstanceOf(HostBusyError);
    expect(() => new WriterLease(Symbol("WriterLease") as never, host.server.lock)).toThrow(
      TypeError,
    );
    await host.stop();
    // Released with the lock: another process may open it now.
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT count(*) AS n FROM event_log").get()).toMatchObject({ n: 1 });
    db.close();
  });

  it("exits 0 after the idle linger, and not while a session is open", async () => {
    const dir = tempDir();
    const host = await startLocalHost({ ...testHostOptions(dir), lingerMs: 150 });
    const client = await storeClient(dir);
    let exited = false;
    void host.exit.then(() => {
      exited = true;
    });
    await wait(300);
    expect(exited).toBe(false);
    client.close();
    expect(await host.exit).toBe(0);
    await expect(connectHost({ dataDir: dir, role: "admin", build: "t" })).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("starts in safe mode after repeated crashes and clears the record on a clean exit", async () => {
    const dir = tempDir();
    const now = Date.now();
    const first = await startLocalHost(testHostOptions(dir));
    await first.stop();
    const starts = join(dir, "run", "starts.json");
    writeFileSync(
      starts,
      JSON.stringify({ format: 1, unclean: [now - 3000, now - 2000, now - 1000] }),
    );
    const host = await startLocalHost(testHostOptions(dir));
    expect(host.safeMode).toBe(true);
    expect(host.capabilities).toEqual({ jobs: false, network: false });
    const admin = await connectHost({ dataDir: dir, role: "admin", build: "t" });
    const status = adminStatusResultSchema.parse(await admin.call("admin.status"));
    expect(status).toMatchObject({ safeMode: true, vaults: 1, pendingWrites: 0 });
    // Safe mode still serves reads and commands.
    const client = await storeClient(dir);
    const vault = client.vaults[0] as string;
    expect((await client.run("core.renameProfile", { name: "Safe" }, { vault })).ok).toBe(true);
    client.close();
    admin.close();
    await host.stop();
    expect(JSON.parse(readFileSync(starts, "utf8"))).toEqual({ format: 1, unclean: [] });
    const after = await startLocalHost(testHostOptions(dir));
    expect(after.safeMode).toBe(false);
    await after.stop();
  });

  it("hands over with exit 75 when its bundle file is replaced", async () => {
    const dir = tempDir();
    const bundle = join(tempDir(), "Info.plist");
    writeFileSync(bundle, "v1");
    const host = await startLocalHost({
      ...testHostOptions(dir),
      bundlePath: bundle,
      bundleCheckMs: 20,
    });
    await wait(50);
    writeFileSync(`${bundle}.new`, "v2 longer");
    const { renameSync } = await import("node:fs");
    renameSync(`${bundle}.new`, bundle);
    expect(await host.exit).toBe(75);
    // The lock is free for the new bundle's host.
    const next = await startLocalHost(testHostOptions(dir));
    await next.stop();
  });

  it("lets commands of other sessions run between the slices of a big apply", async () => {
    const dir = tempDir();
    const host = await startLocalHost(testHostOptions(dir));
    const vault = [...host.stores.vaults.keys()][0] as string;
    const envelopes = foreignRenames(dir, vault, 2_000);
    const client = await storeClient(dir);
    const order: string[] = [];
    const big = host.applySliced(vault, envelopes, 100).then((n) => {
      order.push("apply");
      return n;
    });
    const command = client.run("core.renameProfile", { name: "Mine" }, { vault }).then((r) => {
      order.push("command");
      return r;
    });
    expect(await big).toBeGreaterThanOrEqual(2_000);
    expect((await command).ok).toBe(true);
    expect(order).toEqual(["command", "apply"]);
    client.close();
    await host.stop();
  });

  it("hands over with exit 75 on admin.handover and caps a session's queued commands", async () => {
    const dir = tempDir();
    const host = await startLocalHost({ ...testHostOptions(dir), maxInFlight: 1 });
    const client = await storeClient(dir);
    const vault = client.vaults[0] as string;
    const outcomes = await Promise.allSettled(
      [1, 2, 3].map((i) => client.run("core.renameProfile", { name: `n ${i}` }, { vault })),
    );
    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(
      outcomes.slice(1).every((o) => o.status === "rejected" && /Busy/.test(String(o.reason))),
    ).toBe(true);
    const admin = await connectHost({ dataDir: dir, role: "admin", build: "t" });
    expect(await admin.call("admin.handover")).toEqual({ handover: true });
    expect(await host.exit).toBe(75);
  });

  it("answers status and stop through the admin commands", async () => {
    const dir = tempDir();
    const out: string[] = [];
    const io = {
      env: {},
      stdout: (l: string) => out.push(l),
      stderr: (l: string) => out.push(l),
      onSignal: () => {},
      build: "test",
    };
    expect(await main(["status", "--data-dir", dir], io)).toBe(3);
    expect(out.pop()).toBe("cashu-host: not running");
    const host = await startLocalHost(testHostOptions(dir));
    await host.sync;
    expect(await main(["status", "--data-dir", dir], io)).toBe(0);
    const status = out.pop();
    expect(status).toMatch(/running \(pid \d+, build test, protocol 1\.4\)[\s\S]*vaults {4}1/);
    expect(status).toContain("sync      off, pending ?, last run never");
    expect(await main(["stop", "--data-dir", dir], io)).toBe(0);
    expect(await host.exit).toBe(0);
    expect(await main(["status", "--data-dir", dir], io)).toBe(3);
    expect(await main(["status"], io)).toBe(64);
    expect(await main(["bogus", "--data-dir", dir], io)).toBe(64);
  });
});

/**
 * `count` profile renames by another device of the same vault (as a sync pull would deliver them),
 * plus that device's own profile creation: built on a scratch in-memory store with the vault's salt.
 */
function foreignRenames(dataDir: string, vault: string, count: number): unknown[] {
  const salt = Buffer.from(
    readFileSync(join(storeFiles(dataDir).vaultDir, `${vault}.salt`), "utf8").trim(),
    "hex",
  );
  const scratch = Store.open({
    driver: openNodeSqlite(":memory:"),
    vault,
    salt: vaultSalt(Uint8Array.from(salt)),
    modules: builtinModules(),
  });
  const device = "f".repeat(32);
  const env = {
    device,
    clock: { now: Date.now },
    hlc: new HybridClock(device),
    lease: { isHolder: () => true },
  };
  const out: unknown[] = [];
  const capture: EventWriter = { append: (e) => out.push(...e) };
  const created = runCommand(
    scratch,
    {
      append(e) {
        scratch.applyEnvelopes(e);
        out.push(...e);
      },
    },
    createProfile,
    { slug: "demo", name: "Demo" },
    env,
  );
  expect(created.ok).toBe(true);
  for (let i = 0; i < count; i++) {
    runCommand(scratch, capture, renameProfile, { name: `foreign ${i}` }, env);
  }
  scratch.close();
  return out;
}
