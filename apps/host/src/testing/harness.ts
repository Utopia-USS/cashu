// Test helpers for the local host: temp data dirs (never a real location), a store channel client over
// a real host socket, and spawned host processes (Node type stripping) with process bookkeeping so no
// test leaves a host running.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoreToClient } from "@cashu/host-protocol/store";
import { connectHost, type HostConnection, resolveReal } from "@cashu/node-host";
import { mintUlid } from "@cashu/store";
import { memoryLog } from "../log.js";

const RESOLVE_TS = fileURLToPath(
  new URL("../../../../tools/node-ts/resolveTs.ts", import.meta.url),
);
const FAULT_HOST = fileURLToPath(new URL("./faultHost.ts", import.meta.url));

const dirs = new Set<string>();
const children = new Set<ChildProcess>();

/** A fresh temp directory (resolved), removed by `cleanup`. */
export function tempDir(prefix = "cashu-apphost-"): string {
  const dir = resolveReal(mkdtempSync(join(tmpdir(), prefix)));
  dirs.add(dir);
  return dir;
}

/** Options every in-process test host gets: a temp home for the real-location guard, a memory log. */
export function testHostOptions(dataDir: string) {
  return { dataDir, home: tempDir("cashu-home-"), log: memoryLog(), build: "test" };
}

type RunResult = Extract<StoreToClient, { t: "result" }>["result"];

/** A `ui` session speaking the store channel v2. */
export interface StoreClient {
  readonly conn: HostConnection;
  /** The vaults the host announced at `ready`. */
  readonly vaults: readonly string[];
  run(
    command: string,
    input: unknown,
    options?: { key?: string; vault?: string },
  ): Promise<RunResult>;
  /** Sends a run without waiting (the reply may never come). */
  send(command: string, input: unknown, key: string, vault?: string): number;
  /** Subscribes; resolves with the first value. `values` collects every pushed value. */
  subscribe(
    query: string,
    target: "device" | string,
  ): Promise<{ first: unknown; values: unknown[] }>;
  close(): void;
}

export async function storeClient(dataDir: string): Promise<StoreClient> {
  const conn = await connectHost({ dataDir, role: "ui", build: "test" });
  const results = new Map<number, (r: RunResult | Error) => void>();
  const subs = new Map<number, (v: unknown) => void>();
  let ready: (vaults: readonly string[]) => void = () => {};
  const announced = new Promise<readonly string[]>((resolve) => {
    ready = resolve;
  });
  conn.onFrame((frame) => {
    if (frame.t !== "store") return;
    const m = frame.m as StoreToClient;
    if (m.t === "ready") ready(m.vaults);
    else if (m.t === "result") results.get(m.rid)?.(m.result);
    else if (m.t === "failed")
      results.get(m.rid)?.(new Error(`${m.error.name}: ${m.error.message}`));
    else if (m.t === "value") subs.get(m.sid)?.(m.value);
    else if (m.t === "error") subs.get(m.sid)?.(new Error(m.error.name));
  });
  conn.onClose(() => {
    for (const settle of results.values()) settle(new Error("closed"));
  });
  const vaults = await announced;
  let next = 1;
  const send = (command: string, input: unknown, key: string, vault?: string) => {
    const rid = next++;
    const target =
      vault === undefined ? { kind: "device" as const } : { kind: "vault" as const, vault };
    conn.send({ t: "store", m: { t: "run", rid, key, target, command, input } as never });
    return rid;
  };
  return {
    conn,
    vaults,
    run(command, input, options = {}) {
      const key = options.key ?? mintUlid(Date.now());
      return new Promise((resolve, reject) => {
        const rid = send(command, input, key, options.vault);
        results.set(rid, (r) => {
          results.delete(rid);
          if (r instanceof Error) reject(r);
          else resolve(r);
        });
      });
    },
    send,
    subscribe(query, target) {
      const sid = next++;
      const values: unknown[] = [];
      return new Promise((resolve, reject) => {
        subs.set(sid, (v) => {
          if (v instanceof Error && values.length === 0) return reject(v);
          values.push(v);
          if (values.length === 1) resolve({ first: v, values });
        });
        const t = target === "device" ? { kind: "device" } : { kind: "vault", vault: target };
        conn.send({ t: "store", m: { t: "sub", sid, target: t, query, args: null } as never });
      });
    },
    close: () => conn.close(),
  };
}

export interface SpawnedHost {
  readonly child: ChildProcess;
  readonly exit: Promise<number | null>;
  /** Resolves when the host printed its ready line. */
  readonly ready: Promise<void>;
}

/**
 * Spawns `faultHost.ts` for `dataDir` with a temp home. `killAfterCommits`: the host SIGKILLs itself
 * right after that many command commits (before the reply).
 */
export function spawnHost(
  dataDir: string,
  options: { killAfterCommits?: number; lingerMs?: number } = {},
): SpawnedHost {
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "--import",
      RESOLVE_TS,
      FAULT_HOST,
      dataDir,
      tempDir("cashu-home-"),
      String(options.killAfterCommits ?? 0),
      String(options.lingerMs ?? 60_000),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(child);
  const exit = new Promise<number | null>((resolve) => {
    child.once("exit", (code, signal) => resolve(signal === null ? code : null));
  });
  const ready = new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("ready")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`host exited ${code} before ready`)));
  });
  ready.catch(() => {});
  return { child, exit, ready };
}

/** Kills every spawned host still running and removes the temp dirs. */
export function cleanup(): void {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
}
