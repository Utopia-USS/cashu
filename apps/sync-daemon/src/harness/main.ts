// TRANSITIONAL(S49): the S31a phase 1 milestone harness (spec 9): Python writes -> outbox -> daemon ->
// encrypted log -> a verifier's TS fold == the Python DB, per `store.table.*`, on a run copy of a
// parity dataset (`demo`, synthetic; `lab`, the owner's real data COPY).
//
//   pnpm parity:bridge --dataset lab|demo [--keep-run]
//
// Real data rules: every output is counts, short hashes and pass / fail; scripted writes are synthetic;
// the source dataset's manifest is taken before the copy and after the run (a difference fails the
// run, exit 2); every plaintext output stays in the private run dir under `<lab>/parity`, deleted
// unless `--keep-run`. Every Python child runs with the environment `bridge_env.py` prints (golden.py
// `safe_env` over the run dir + the lab keyring + the frozen clock), and before ANY Python run the
// data-dir check asserts `paths.data_dir()` is the run's `data/` (README rule 2).
//
// Placement deviation (S31a checkpoint): the spec puts the harness in packages/parity, but it drives
// sync engines and Node folders, which the parity layer may not import (parity -> domain, store, mcp;
// node-host is for apps): it lives in the daemon app and calls the parity CLIs as processes.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeFolderFs } from "@cashu/node-host";
import { detGidFor, mintUlid, vaultSalt } from "@cashu/store";
import { createOwnLogCodec, crypto, decodePayload, FolderTransport, scanFrames } from "@cashu/sync";
import { labFileKeyStore } from "../keys/labFile.js";
import { openDevice, openVerifier, verifierDb } from "./devices.js";

const REPO = resolve(import.meta.dirname, "..", "..", "..", "..");
const PY = join(REPO, ".venv", "bin", "python");
const CASHU = join(REPO, ".venv", "bin", "cashu");
const NODE_TS = [
  "--disable-warning=ExperimentalWarning",
  "--experimental-strip-types",
  "--import",
  join(REPO, "tools", "node-ts", "resolveTs.ts"),
];
const DAEMON = [...NODE_TS, join(REPO, "apps", "sync-daemon", "src", "cli.ts")];
const STORE_TABLES = [
  "profiles",
  "profile_modules",
  "accounts",
  "balances",
  "transactions",
  "category_rules",
  "import_batches",
  "loans",
  "depreciations",
  "asset_details",
  "inv_account_settings",
  "inv_import_batches",
  "inv_transactions",
  "inv_position_snapshots",
  "inv_instrument_renames",
  "inv_manual_valuations",
  "inv_instruments",
  "inv_instrument_aliases",
  "inv_profile_instruments",
  "inv_strategy_versions",
  "inv_theses",
  "inv_topic_theses",
  "watchlist_items",
  "alerts",
  "inv_planned_deposits",
  "inv_signals",
  "inv_rule_runs",
  "inv_decisions",
  "reviews",
  "proposals",
  "research_runs",
  "research_notes",
  "connector_bindings",
].map((t) => `store.table.${t}`);

type Line = Record<string, unknown>;
const say = (line: Line) => process.stdout.write(`${JSON.stringify(line)}\n`);

class HarnessError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Runs a process; returns stdout. Stderr is not echoed (it could name a path or a value). */
function run(cmd: string, args: readonly string[], env: NodeJS.ProcessEnv, what: string): string {
  const r = spawnSync(cmd, args, {
    env,
    encoding: "utf8",
    cwd: REPO,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new HarnessError(`${what} failed (exit ${r.status ?? "signal"})`);
  return r.stdout;
}

const jsonLines = (out: string): Line[] =>
  out
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Line);

const lastJson = (out: string): Line => jsonLines(out).at(-1) ?? {};

interface Ctx {
  readonly dataset: "lab" | "demo";
  readonly run: string;
  readonly config: string;
  readonly env: NodeJS.ProcessEnv;
  readonly envSync: NodeJS.ProcessEnv;
  readonly daemonLines: Line[];
}

function dataDirCheck(c: Ctx, env: NodeJS.ProcessEnv): void {
  const out = run(
    PY,
    ["-c", "from cashu.core import paths; print(paths.data_dir())"],
    env,
    "data-dir check",
  );
  if (resolve(out.trim()) !== resolve(c.run, "data")) {
    throw new HarnessError("data-dir check: Python does not point at the run copy", 2);
  }
}

function python(c: Ctx, args: readonly string[], sync: boolean, what: string): string {
  const env = sync ? c.envSync : c.env;
  dataDirCheck(c, env);
  return run(PY, args, env, what);
}

function cashu(c: Ctx, args: readonly string[], sync: boolean): string {
  const env = sync ? c.envSync : c.env;
  dataDirCheck(c, env);
  return run(CASHU, args, env, `cashu ${args[0] ?? ""}`);
}

function daemon(c: Ctx, args: readonly string[], what: string): Line[] {
  const r = spawnSync(process.execPath, [...DAEMON, ...args, "--config", c.config], {
    encoding: "utf8",
    cwd: REPO,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    maxBuffer: 256 * 1024 * 1024,
  });
  const lines = jsonLines(r.stdout);
  c.daemonLines.push(...lines.map((l) => ({ ...l, run: what })));
  if (r.status !== 0) {
    const blocked = lines.find((l) => "blocked" in l);
    throw new HarnessError(
      `daemon ${what} exit ${r.status ?? "signal"}${blocked ? ` blocked=${String(blocked.blocked)}` : ""}`,
    );
  }
  return lines;
}

/** Starts `run`, SIGKILLs it when it prints the progress line `point`; true when it was killed there. */
function killAt(c: Ctx, point: string): Promise<boolean> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [...DAEMON, "run", "--config", c.config], {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let killed = false;
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new HarnessError(`kill test: no ${point} line within 120 s`));
    }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("{"))
          c.daemonLines.push({ ...(JSON.parse(line) as Line), run: `kill-${point}` });
        if (!killed && line.includes(`"progress":"${point}"`)) {
          killed = true;
          child.kill("SIGKILL");
        }
        nl = buffer.indexOf("\n");
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      done(killed);
    });
  });
}

/** Read-only counts / targets from the run copy (never printed). */
function pythonDb(c: Ctx): DatabaseSync {
  return new DatabaseSync(join(c.run, "data", "cashu.db"), { readOnly: true });
}

function pending(c: Ctx): number {
  const db = pythonDb(c);
  try {
    return Number(
      (
        db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acked_at IS NULL").get() as {
          n: number;
        }
      ).n,
    );
  } finally {
    db.close();
  }
}

interface Targets {
  readonly profileId: number;
  readonly vaultId: string;
  readonly titled?: string;
  readonly muteAlert?: string;
  readonly note?: string;
  readonly snoozeSignal?: string;
  readonly decideSignal?: string;
}

/** Gids of the rows the inbound edits address, picked from the run copy (profile ordinal 0). */
function targets(c: Ctx): Targets {
  const db = pythonDb(c);
  try {
    const first = db
      .prepare(
        "SELECT p.id AS id, v.vault_id AS vault FROM profiles p JOIN sync_vaults v ON v.profile_id = p.id ORDER BY p.id LIMIT 1",
      )
      .get() as { id: number; vault: string };
    const gid = (table: string, sql: string, ...params: (string | number)[]) => {
      const row = db.prepare(sql).get(...params) as { id: number } | undefined;
      if (row === undefined) return undefined;
      const g = db
        .prepare(
          "SELECT gid FROM sync_ids WHERE profile_id = ? AND table_name = ? AND local_id = ?",
        )
        .get(first.id, table, String(row.id)) as { gid: string } | undefined;
      return g?.gid;
    };
    const titled = gid(
      "alerts",
      "SELECT id FROM alerts WHERE profile_id = ? AND title LIKE 'bridge-test-title%' ORDER BY id LIMIT 1",
      first.id,
    );
    const muteAlert = gid(
      "alerts",
      "SELECT id FROM alerts WHERE profile_id = ? AND status = 'active' AND deleted_at IS NULL AND title NOT LIKE 'bridge-test-title%' ORDER BY id LIMIT 1",
      first.id,
    );
    const note = gid(
      "research_notes",
      "SELECT id FROM research_notes WHERE profile_id = ? AND read_at IS NULL AND dismissed_at IS NULL AND created_by = 'agent' ORDER BY id LIMIT 1",
      first.id,
    );
    const signals = db
      .prepare(
        "SELECT id FROM inv_signals WHERE profile_id = ? AND status = 'active' AND snoozed_until IS NULL ORDER BY id LIMIT 2",
      )
      .all(first.id) as { id: number }[];
    const signalGid = (i: number) => {
      const id = signals[i]?.id;
      if (id === undefined) return undefined;
      return (
        db
          .prepare(
            "SELECT gid FROM sync_ids WHERE profile_id = ? AND table_name = 'inv_signals' AND local_id = ?",
          )
          .get(first.id, String(id)) as { gid: string } | undefined
      )?.gid;
    };
    return {
      profileId: first.id,
      vaultId: first.vault,
      ...(titled === undefined ? {} : { titled }),
      ...(muteAlert === undefined ? {} : { muteAlert }),
      ...(note === undefined ? {} : { note }),
      ...(signalGid(0) === undefined ? {} : { snoozeSignal: signalGid(0) }),
      ...(signalGid(1) === undefined ? {} : { decideSignal: signalGid(1) }),
    };
  } finally {
    db.close();
  }
}

const ulid = (sodium: crypto.Sodium, ms: number) => mintUlid(ms, (n) => sodium.randomBytes(n));

async function main(argv: readonly string[]): Promise<number> {
  const at = argv.indexOf("--dataset");
  const dataset = argv[at + 1];
  if (at < 0 || (dataset !== "lab" && dataset !== "demo")) {
    process.stderr.write("usage: pnpm parity:bridge --dataset lab|demo [--keep-run]\n");
    return 64;
  }
  const keep = argv.includes("--keep-run");
  const lab = join(homedir(), "cashu-lab");
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const runDir = join(lab, "parity", `bridge-run-${stamp}-${process.pid}-${dataset}`);
  for (const d of ["", "keys", "out", "state", "remote", "verifier"]) {
    mkdirSync(join(runDir, d), { recursive: true, mode: 0o700 });
  }
  chmodSync(runDir, 0o700);
  let failed = true;
  try {
    const before = lastJson(
      run(
        PY,
        [join(REPO, "parity", "python", "golden.py"), "--manifest", dataset],
        process.env,
        "manifest",
      ),
    );
    say({ step: "manifest", when: "before", manifest: String(before.manifest).slice(0, 20) });
    run(
      PY,
      [
        join(REPO, "parity", "python", "golden.py"),
        "--copy-dataset",
        dataset,
        "--to",
        join(runDir, "data"),
      ],
      process.env,
      "copy",
    );
    const envOf = (sync: boolean): NodeJS.ProcessEnv =>
      JSON.parse(
        run(
          PY,
          [
            join(REPO, "parity", "python", "bridge_env.py"),
            "--run",
            runDir,
            "--dataset",
            dataset,
            ...(sync ? ["--sync"] : []),
          ],
          process.env,
          "bridge_env",
        ),
      ) as NodeJS.ProcessEnv;
    const env = envOf(false);
    const envSync = envOf(true);
    const config = join(runDir, "daemon.json");
    writeFileSync(
      config,
      JSON.stringify({
        format: 1,
        dataDir: join(runDir, "data"),
        python: { argv: [CASHU], env: envSync },
        stateRoot: join(runDir, "state"),
        remotes: [{ kind: "folder", root: join(runDir, "remote") }],
        keys: {
          kind: "lab-file",
          path: join(runDir, "keys", "daemon-keys.json"),
          pythonKeyring: join(runDir, "keys", "keyring.json"),
        },
        pollMs: 500,
      }),
      { mode: 0o600 },
    );
    const c: Ctx = { dataset, run: runDir, config, env, envSync, daemonLines: [] };

    // 1-2: schema to head, first start.
    cashu(c, ["init-db"], false);
    daemon(c, ["init"], "init");
    say({
      step: "init",
      vaults: c.daemonLines.filter((l) => l.step === "init").length,
      events: c.daemonLines
        .filter((l) => l.step === "init")
        .reduce((n, l) => n + Number(l.events ?? 0), 0),
    });

    // A stale device: holds the genesis only; its clock stays near the genesis wall.
    const sodium = await crypto.loadNodeSodium();
    const keyStore = labFileKeyStore(join(runDir, "keys", "daemon-keys.json"));
    const first = targets(c);
    const ring = await crypto.loadKeyring(keyStore, sodium, first.vaultId);
    if (ring === null) throw new HarnessError("no ring for vault 0");
    const stateDb = new DatabaseSync(join(runDir, "state", "v0", "bridge.db"), { readOnly: true });
    const genesisWall = Number(
      (stateDb.prepare("SELECT wall FROM genesis WHERE id = 1").get() as { wall: number }).wall,
    );
    stateDb.close();
    const stale = await openDevice({
      sodium,
      ring,
      remote: join(runDir, "remote"),
      dbPath: ":memory:",
      clockMs: genesisWall + 60_000,
    });
    await stale.engine.sync();

    // 3-4: phase A, ship.
    say({
      step: "phaseA",
      ...lastJson(
        python(
          c,
          [
            join(REPO, "parity", "python", "bridge_writes.py"),
            "--dataset",
            dataset,
            "--phase",
            "A",
          ],
          true,
          "phase A",
        ),
      ),
    });
    daemon(c, ["run", "--once"], "phaseA");
    say({ step: "shipA", pending: pending(c), ...shipTotals(c.daemonLines, "phaseA") });

    // 5: phase B in three parts, one SIGKILL per crash point, each recovered by `run --once`.
    const kills: Line = {};
    for (const [i, point] of (["intent", "written", "acked"] as const).entries()) {
      python(
        c,
        [
          join(REPO, "parity", "python", "bridge_writes.py"),
          "--dataset",
          dataset,
          "--phase",
          "B",
          "--part",
          String(i + 1),
        ],
        true,
        `phase B${i + 1}`,
      );
      const killed = await killAt(c, point);
      daemon(c, ["run", "--once"], `recover-${point}`);
      kills[point] = { killed, pending: pending(c) };
    }
    say({ step: "kill", ...kills });

    // 6: inbound edits from two other devices (one stale-stamped, one current).
    const t = targets(c);
    const current = await openDevice({
      sodium,
      ring,
      remote: join(runDir, "remote"),
      dbPath: ":memory:",
      clockMs: Date.now(),
    });
    await current.engine.sync();
    const inbound: Line = {};
    const now = Date.now();
    const atIso = new Date(now).toISOString();
    const wire = (type: string, gid: string, data: Record<string, unknown>, ms: number) => ({
      t: type,
      v: 1,
      i: ulid(sodium, ms),
      g: gid,
      a: new Date(ms).toISOString(),
      d: data,
    });
    if (t.titled !== undefined) {
      await stale.write([
        wire("alert.updated", t.titled, { title: "bridge-in-old" }, genesisWall + 60_000),
      ]);
      await current.write([wire("alert.updated", t.titled, { title: "bridge-in-new" }, now)]);
      inbound.titlePair = 2;
    }
    if (t.muteAlert !== undefined) {
      await current.write([
        wire("alert.statusSet", t.muteAlert, { status: "muted", snoozedUntil: null }, now),
      ]);
      inbound.mute = 1;
    }
    if (t.note !== undefined) {
      await current.write([wire("note.read", t.note, {}, now)]);
      inbound.noteRead = 1;
    }
    if (t.snoozeSignal !== undefined) {
      await current.write([
        wire(
          "signal.snoozed",
          t.snoozeSignal,
          { until: new Date(now + 7 * 86_400_000).toISOString() },
          now,
        ),
      ]);
      inbound.snooze = 1;
    }
    if (t.decideSignal !== undefined) {
      const data = {
        signals: [t.decideSignal],
        instrument: null,
        account: null,
        action: "held",
        quantity: null,
        price: null,
        currency: null,
        reason: "bridge-inbound",
      };
      await current.write([wire("decision.recorded", ulid(sodium, now), data, now)]);
      inbound.decision = 1;
    }
    if (dataset === "demo") {
      const merchantKey = "BRIDGE INBOUND 1";
      const salt = ring.gidSalt();
      const g = detGidFor(vaultSalt(salt.expose().slice()))("category_rules", [merchantKey]);
      salt.wipe();
      await current.write([
        wire(
          "categoryRule.set",
          g,
          { merchantKey, category: "inne", source: "manual", locked: true },
          now,
        ),
      ]);
      inbound.categoryRule = 1;
    }
    await stale.engine.sync();
    await current.engine.sync();
    say({ step: "inbound", at: atIso.slice(0, 10), ...inbound });

    // 7: pull + pipe, then a local write after the inbound ones and ship it.
    daemon(c, ["run", "--once"], "inbound");
    say({ step: "pipe", ...pipeTotals(c.daemonLines, "inbound") });
    say({
      step: "phaseC",
      ...lastJson(
        python(
          c,
          [
            join(REPO, "parity", "python", "bridge_writes.py"),
            "--dataset",
            dataset,
            "--phase",
            "C",
          ],
          true,
          "phase C",
        ),
      ),
    });
    daemon(c, ["run", "--once"], "phaseC");
    await stale.close();
    await current.close();

    // 8: verifiers: fresh devices pull only the remote folder and fold it.
    const db = pythonDb(c);
    const vaults = db
      .prepare(
        "SELECT profile_id AS profileId, vault_id AS vault FROM sync_vaults ORDER BY profile_id",
      )
      .all() as { profileId: number; vault: string }[];
    const ordinals = new Map(
      (db.prepare("SELECT id FROM profiles ORDER BY id").all() as { id: number }[]).map((p, i) => [
        p.id,
        i,
      ]),
    );
    db.close();
    const verifier: Line[] = [];
    const checks: Line[] = [];
    for (const v of vaults) {
      const r = await crypto.loadKeyring(keyStore, sodium, v.vault);
      if (r === null) throw new HarnessError("no ring for a vault");
      const ordinal = ordinals.get(v.profileId) ?? -1;
      const dev = await openVerifier({
        sodium,
        ring: r,
        remote: join(runDir, "remote"),
        run: runDir,
        ordinal,
        clockMs: Date.now(),
      });
      const synced = await dev.engine.sync();
      const folded =
        dev.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM event_log")[0]?.n ?? 0;
      const dup =
        dev.store.read<{ n: number }>(
          "SELECT COUNT(*) AS n FROM (SELECT eid FROM event_log GROUP BY eid HAVING COUNT(*) > 1)",
        )[0]?.n ?? 0;
      const raw = await rawScan(join(runDir, "remote"), r, sodium);
      const secret = r.gidSalt();
      verifier.push({
        profileId: v.profileId,
        vault: v.vault,
        salt: Buffer.from(secret.expose()).toString("hex"),
        viewDb: verifierDb(ordinal),
      });
      secret.wipe();
      checks.push({
        vault: ordinal,
        folded,
        duplicates: dup,
        rawEvents: raw.events,
        rawDuplicates: raw.duplicates,
        rejected: synced.rejected.length,
        parked: synced.parked,
      });
      await dev.close();
    }
    writeFileSync(
      join(runDir, "verifier", "verifier.json"),
      JSON.stringify({ format: 1, vaults: verifier }),
      { mode: 0o600 },
    );
    say({ step: "verifier", vaults: checks });

    // 9-11: Python goldens of the run copy, TS producers over the verifier stores, compare.
    const golden = run(
      PY,
      [
        join(REPO, "parity", "python", "golden.py"),
        "--dataset",
        dataset,
        "--source-dir",
        join(runDir, "data"),
        "--check",
        "store.table.*",
        "--out",
        join(runDir, "out"),
      ],
      process.env,
      "golden",
    );
    const ts = run(
      process.execPath,
      [
        ...NODE_TS,
        join(REPO, "packages", "parity", "src", "producers", "cli.ts"),
        "--dataset",
        dataset,
        "--source-dir",
        join(runDir, "data"),
        "--store-source",
        `bridge:${runDir}`,
        "--out",
        join(runDir, "out", "ts"),
        "--force",
        ...STORE_TABLES.flatMap((s) => ["--check", s]),
      ],
      process.env,
      "produce",
    );
    const compare = spawnSync(
      process.execPath,
      [
        ...NODE_TS,
        join(REPO, "packages", "parity", "src", "cli.ts"),
        "--dataset",
        dataset,
        "--golden",
        join(runDir, "out", dataset),
        "--actual",
        join(runDir, "out", "ts"),
        "--allow-stale",
        ...STORE_TABLES.flatMap((s) => ["--check", s]),
      ],
      { encoding: "utf8", cwd: REPO },
    );
    writeFileSync(join(runDir, "out", "parity.txt"), `${golden}\n${ts}\n${compare.stdout}`, {
      mode: 0o600,
    });
    const after = lastJson(
      run(
        PY,
        [join(REPO, "parity", "python", "golden.py"), "--manifest", dataset],
        process.env,
        "manifest",
      ),
    );
    say({
      step: "manifest",
      when: "after",
      manifest: String(after.manifest).slice(0, 20),
      unchanged: after.manifest === before.manifest,
    });
    say({
      step: "parity",
      exit: compare.status,
      tsLines: ts.split("\n").filter((l) => l.includes("store.table.")).length,
    });
    process.stdout.write(compare.stdout);
    writeFileSync(
      join(runDir, "out", "daemon.jsonl"),
      c.daemonLines.map((l) => JSON.stringify(l)).join("\n"),
      { mode: 0o600 },
    );
    if (after.manifest !== before.manifest) throw new HarnessError("source manifest changed", 2);
    failed = compare.status !== 0;
    return failed ? 1 : 0;
  } catch (e) {
    say({
      step: "error",
      message: e instanceof HarnessError ? e.message : e instanceof Error ? e.name : "unknown",
    });
    if (process.env.CASHU_HARNESS_DEBUG === "1" && dataset === "demo") console.error(e);
    return e instanceof HarnessError ? e.exitCode : 70;
  } finally {
    if (!keep && !failed) rmSync(runDir, { recursive: true, force: true });
    else say({ step: "run-dir", kept: true });
  }
}

function shipTotals(lines: readonly Line[], run: string): Line {
  const ship = lines.filter((l) => l.run === run && l.step === "ship");
  const sum = (k: string) => ship.reduce((n, l) => n + Number(l[k] ?? 0), 0);
  return {
    plans: ship.length,
    txns: sum("txns"),
    rows: sum("rows"),
    events: sum("events"),
    gids: sum("gids"),
    closure: sum("closure"),
    noEvent: sum("noEvent"),
    blocked: lines.filter((l) => l.run === run && "blocked" in l).length,
  };
}

function pipeTotals(lines: readonly Line[], run: string): Line {
  const out: Record<string, number> = {};
  for (const l of lines.filter((x) => x.run === run && x.step === "pipe")) {
    for (const [k, v] of Object.entries(l))
      if (typeof v === "number" && k !== "vault") out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

/** Every eid in the remote folder's frames of a vault (decrypted with the ring), and repeats. */
async function rawScan(remote: string, ring: crypto.Keyring, sodium: crypto.Sodium) {
  const codec = createOwnLogCodec({ sodium, ring });
  const t = new FolderTransport({ fs: new NodeFolderFs(remote) });
  const seen = new Set<string>();
  let events = 0;
  let duplicates = 0;
  for (const seg of await t.list(ring.vaultId)) {
    if (seg.seg === 0) continue; // the manifest segment
    const bytes = await t.read(ring.vaultId, seg.device, seg.seg, 0);
    for (const f of scanFrames(bytes, 0).frames) {
      const plain = await codec.open(f.sealed, {
        vault: ring.vaultId,
        device: seg.device,
        seg: seg.seg,
        offset: f.offset,
      });
      const decoded = decodePayload(plain, seg.device);
      if (!decoded.ok) continue;
      for (const e of decoded.payload.events) {
        events += 1;
        if (seen.has(e.i)) duplicates += 1;
        seen.add(e.i);
      }
    }
  }
  return { events, duplicates };
}

process.exitCode = await main(process.argv.slice(2));
