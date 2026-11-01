// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a spec 2.2).
//
// `cashu-sync-daemon init|run [--once]|status --config <file>`. One process per Python data dir
// (lockfile), one serialized loop. Exit codes: 0 ok, 64 usage / refusal, 65 data / mapping block,
// 70 internal. Output: one JSON line per step, counts and short hashes only (never values, slugs,
// vault or device ids, salts, keys or gids). SIGTERM / SIGINT finish the current step; SIGUSR1 wakes
// the loop (the lab harness); SIGKILL at any point is safe (spec 6).
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RefusalError } from "@cashu/node-host";
import { mintUlid } from "@cashu/store";
import { crypto } from "@cashu/sync";
import { type DaemonConfig, loadConfig } from "./config.js";
import { InitRefusedError, initVaults } from "./init.js";
import { labFileKeyStore } from "./keys/labFile.js";
import { labGate } from "./keys/labGate.js";
import { loadVaultKeys } from "./keys/vaultKeys.js";
import { acquireLock, LockedError } from "./lock.js";
import { BlockedError, Loop } from "./loop.js";
import { pythonCli } from "./python/cli.js";
import { PythonReader } from "./python/reader.js";
import { type OpenVault, openVault } from "./vault.js";

export interface MainEnv {
  readonly argv: readonly string[];
  readonly home: string;
  readonly out: (line: Readonly<Record<string, unknown>>) => void;
  readonly err: (line: string) => void;
}

const USAGE = "usage: cashu-sync-daemon init|run [--once]|status --config <file>";

async function openLinked(
  config: DaemonConfig,
  reader: PythonReader,
  sodium: crypto.Sodium,
): Promise<OpenVault[]> {
  const store = labFileKeyStore(config.keys.path);
  const ordinals = new Map(reader.profiles().map((p, i) => [p.id, i]));
  const vaults: OpenVault[] = [];
  for (const linked of reader.vaults()) {
    const keys = await loadVaultKeys(store, sodium, linked.vaultId);
    const ordinal = ordinals.get(linked.profileId);
    if (keys === undefined || ordinal === undefined) {
      throw new RefusalError("a linked vault has no keys on this device");
    }
    vaults.push(
      await openVault({
        ordinal,
        profileId: linked.profileId,
        stateRoot: config.stateRoot,
        remotes: config.remotes.map((r) => r.root),
        keys,
        sodium,
        gate: await labGate(store, sodium, keys.ring, keys.identity),
      }),
    );
  }
  return vaults.sort((a, b) => a.ordinal - b.ordinal);
}

async function run(config: DaemonConfig, env: MainEnv, once: boolean): Promise<number> {
  const sodium = await crypto.loadNodeSodium();
  const reader = new PythonReader(config.dataDir);
  const vaults = await openLinked(config, reader, sodium);
  if (vaults.length === 0) {
    // Without a vault nothing can ship or be acked: refuse instead of spinning (review F6).
    reader.close();
    throw new RefusalError("no linked vault: run `init` first");
  }
  const slugs = new Map(reader.profiles().map((p) => [p.id, p.slug]));
  const loop = new Loop({
    reader,
    cli: pythonCli(config.python.argv, config.python.env),
    vaults,
    slugs,
    ports: {
      ulid: () => mintUlid(Date.now(), (n) => new Uint8Array(randomBytes(n))),
      // TRANSITIONAL(S29c-B1): phase 1 runs one Python device per vault, its creator, which is the
      // pinned fetch leader by construction; B1 replaces this with the registry query.
      isLeader: () => true,
    },
    now: () => Date.now(),
    out: env.out,
  });
  let stop = false;
  let wake: (() => void) | undefined;
  const onStop = () => {
    stop = true;
    wake?.();
  };
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);
  process.on("SIGUSR1", () => wake?.());
  try {
    if (once) {
      for (;;) {
        const r = await loop.iteration();
        if (r.idle) break;
      }
      return 0;
    }
    let marker = "";
    while (!stop) {
      const now = reader.changeMarker();
      if (now !== marker) {
        await loop.iteration();
        marker = reader.changeMarker();
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, config.pollMs);
      });
      wake = undefined;
    }
    return 0;
  } finally {
    for (const v of vaults) await v.close();
    reader.close();
  }
}

async function status(config: DaemonConfig, env: MainEnv): Promise<number> {
  const sodium = await crypto.loadNodeSodium();
  const reader = new PythonReader(config.dataDir);
  try {
    const vaults = await openLinked(config, reader, sodium);
    const rows = vaults.map((v) => ({
      vault: v.ordinal,
      intentOpen: v.state.intent() !== undefined,
      genesis: v.state.genesis()?.status ?? "none",
      events: v.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM event_log")[0]?.n ?? 0,
      pipeCursor: v.state.pipeCursor().seq,
    }));
    env.out({ step: "status", pending: reader.pendingCount(), vaults: rows });
    for (const v of vaults) await v.close();
    return 0;
  } finally {
    reader.close();
  }
}

/** The CLI; returns the exit code. */
export async function main(env: MainEnv): Promise<number> {
  const [command, ...rest] = env.argv;
  const at = rest.indexOf("--config");
  const path = at >= 0 ? rest[at + 1] : undefined;
  if (command === undefined || path === undefined || !["init", "run", "status"].includes(command)) {
    env.err(USAGE);
    return 64;
  }
  try {
    const config = loadConfig(path, env.home);
    mkdirSync(config.stateRoot, { recursive: true, mode: 0o700 });
    const lock = acquireLock(join(config.stateRoot, "daemon.lock"), process.pid);
    try {
      if (command === "status") return await status(config, env);
      if (command === "run") return await run(config, env, rest.includes("--once"));
      const sodium = await crypto.loadNodeSodium();
      const reader = new PythonReader(config.dataDir);
      try {
        await initVaults({
          config,
          reader,
          cli: pythonCli(config.python.argv, config.python.env),
          sodium,
          keyStore: labFileKeyStore(config.keys.path),
          now: Date.now(),
          out: env.out,
        });
      } finally {
        reader.close();
      }
      return 0;
    } finally {
      lock.release();
    }
  } catch (e) {
    if (e instanceof RefusalError || e instanceof LockedError || e instanceof InitRefusedError) {
      env.err(e.message);
      return 64;
    }
    if (e instanceof BlockedError) {
      env.out({ blocked: e.reason });
      return 65;
    }
    env.err(`internal error: ${e instanceof Error ? e.name : "unknown"}`);
    return 70;
  }
}

export const defaultEnv = (): MainEnv => ({
  argv: process.argv.slice(2),
  home: homedir(),
  out: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
