// TRANSITIONAL(S49): the outbox bridge and the sync carrier loop as a host service (S56c; S31a loop).
//
// One service per host, so one per data dir: the host's machine lock is the single-instance guard
// (it replaces the sync daemon's pid lockfile), and every vault database opens exclusively under the
// writer lease, so nothing else can append to this device's streams. Lifecycle:
//   start   at host start: no `sync-bridge.json` -> off; safe mode -> not started (no network after
//           a crash loop); a refused configuration or missing keys -> refused; no linked vault ->
//           uninitialized (`cashu bridge init` links them); else the vaults open and a first
//           iteration runs at once (the wake-up: an on-demand host started by a client, or by the
//           daily wake, catches up first).
//   loop    every `pollMs` the service looks at Python's outbox; a change, or `carrierMs` since the
//           last iteration (the carrier loop: push own frames, pull and fold the other devices',
//           pipe them to Python), runs iterations until the outbox is idle. Iterations never
//           overlap: ticks, `cashu bridge run --once` and `init` take turns on one queue.
//   block   a row the bridge cannot map stops the loop (D4, visible in status), until a `run --once`
//           gets past it; any other failure is retried after a pause.
//   stop    at host stop: no new iteration, the current one finishes, the vaults close (before the
//           host releases its lock).
// Leader rule: only the vault's fetch leader ships leader-emitted events (bridge `isLeader`, checked
// for every plan). Output: counts and codes only, to the host log and to the `bridge` command's
// caller; never values, slugs, vault or device ids.
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import type { SyncStatus } from "@cashu/host-protocol";
import { RefusalError } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { mintUlid, type SqlDriver } from "@cashu/store";
import { crypto } from "@cashu/sync";
import type { WriterLease } from "../lease.js";
import { errorName, type HostLog, type LogField } from "../log.js";
import { type BridgeConfig, loadConfig } from "./config.js";
import { InitRefusedError, initVaults } from "./init.js";
import { labFileKeyStore } from "./keys/labFile.js";
import { labGate } from "./keys/labGate.js";
import { loadVaultKeys } from "./keys/vaultKeys.js";
import { BlockedError, type CrashPoint, Loop } from "./loop.js";
import { pythonCli } from "./python/cli.js";
import { PythonReader } from "./python/reader.js";
import { type OpenVault, openVault } from "./vault.js";

/** A failed iteration is retried after this pause at most (Python busy, a remote offline). */
const RETRY_MS = 30_000;
/** Iterations one tick runs at most before it yields to the next tick. */
const MAX_ITERATIONS = 20;

export type Line = Readonly<Record<string, unknown>>;

export type RunOutcome =
  | { readonly kind: "idle"; readonly iterations: number }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: string };

export interface SyncServiceOptions {
  readonly dataDir: string;
  /** The home whose real cashU locations the configuration may not name. */
  readonly home: string;
  readonly lease: WriterLease;
  readonly log: HostLog;
  /** The host's capabilities: in safe mode (`network` false) the service does not start. */
  readonly capabilities: { readonly jobs: boolean; readonly network: boolean };
  readonly now?: () => number;
  /** Tests only: called at each crash point of the loop. */
  readonly at?: (point: CrashPoint) => void;
}

/** SQLite's "database is locked" (another process holds a vault database exclusively). */
const SQLITE_BUSY = 5;

/** A short reason code for a start failure. */
function startReason(error: unknown): string {
  if (error instanceof RefusalError) return "keys";
  if ((error as { errcode?: unknown } | null)?.errcode === SQLITE_BUSY) return "vault-busy";
  return errorName(error);
}

/** Creates an empty database file with mode 0600 (SQLite keeps the file's mode for its WAL). */
function privateDbFile(path: string): string {
  if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  return path;
}

/** A loop line as log fields: numbers, flags and codes, one level of nesting flattened. */
function logFields(line: Line): Record<string, LogField> {
  const out: Record<string, LogField> = {};
  for (const [key, value] of Object.entries(line)) {
    if (key === "step" || key === "progress") continue;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      out[key] = value;
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === "number" || typeof v === "boolean") out[`${key}.${k}`] = v;
      }
    }
  }
  return out;
}

export class SyncService {
  readonly #o: SyncServiceOptions;
  readonly #now: () => number;
  #config: BridgeConfig | undefined;
  #state: SyncStatus["state"] = "off";
  #reason: string | undefined;
  #reader: PythonReader | undefined;
  #vaults: OpenVault[] = [];
  #loop: Loop | undefined;
  #sodium: crypto.Sodium | undefined;
  /** The turn queue: ticks, `run --once` and `init` never overlap. */
  #turn: Promise<unknown> = Promise.resolve();
  /** Callers that want this turn's lines (the `bridge` command). */
  readonly #sinks = new Set<(line: Line) => void>();
  #timer: NodeJS.Timeout | undefined;
  #marker = "";
  #lastRunAt: number | undefined;
  /** A bounded turn yielded with work left; its next poll must not wait for a new edit. */
  #continueOnPoll = false;
  #retryAt = 0;
  #stopping = false;

  private constructor(o: SyncServiceOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  /** Starts the data dir's service (never throws: a refusal is a state). */
  static async start(o: SyncServiceOptions): Promise<SyncService> {
    const service = new SyncService(o);
    await service.#start();
    return service;
  }

  async #start(): Promise<void> {
    try {
      this.#config = loadConfig(this.#o.dataDir, this.#o.home);
    } catch (error) {
      this.#refuse(error instanceof RefusalError ? "config" : errorName(error));
      return;
    }
    if (this.#config === undefined) return; // off
    if (!this.#o.capabilities.network || !this.#o.capabilities.jobs) {
      this.#state = "safe-mode";
      this.#o.log.warn("sync.not-started", { state: "safe-mode" });
      return;
    }
    try {
      this.#sodium = await crypto.loadNodeSodium();
      this.#reader = new PythonReader(this.#o.dataDir);
      await this.#openLinked();
    } catch (error) {
      this.#refuse(startReason(error));
      this.#closeAll();
      return;
    }
    this.#o.log.info("sync.started", { state: this.#state, vaults: this.#vaults.length });
    this.#schedule(0);
  }

  #refuse(reason: string): void {
    this.#state = "refused";
    this.#reason = reason;
    this.#o.log.warn("sync.refused", { reason });
  }

  /** The vault databases' opener: exclusive, under the writer lease. */
  readonly #openDb = (path: string): SqlDriver =>
    openNodeSqlite(privateDbFile(path), { exclusive: this.#o.lease.lock() });

  async #openLinked(): Promise<void> {
    const config = this.#config;
    const reader = this.#reader;
    const sodium = this.#sodium;
    if (config === undefined || reader === undefined || sodium === undefined) return;
    const store = labFileKeyStore(config.keys.path);
    const profiles = reader.profiles();
    const ordinals = new Map(profiles.map((p, i) => [p.id, i]));
    const vaults: OpenVault[] = [];
    try {
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
            openDb: this.#openDb,
          }),
        );
      }
    } catch (error) {
      for (const v of vaults) await v.close();
      throw error;
    }
    this.#vaults = vaults.sort((a, b) => a.ordinal - b.ordinal);
    if (this.#vaults.length === 0) {
      // Without a vault nothing can ship or be acked (review F6): wait for `bridge init`.
      this.#state = "uninitialized";
      return;
    }
    const slugs = new Map(profiles.map((p) => [p.id, p.slug]));
    const byVault = new Map(this.#vaults.map((v) => [v.vaultId, v]));
    this.#loop = new Loop({
      reader,
      cli: pythonCli(config.python.argv, config.python.env),
      vaults: this.#vaults,
      slugs,
      ports: {
        ulid: () => mintUlid(this.#now(), (n) => new Uint8Array(randomBytes(n))),
        isLeader: (vault) => this.#isLeader(byVault.get(vault)),
      },
      now: this.#now,
      out: (line) => this.#emit(line),
      ...(this.#o.at === undefined ? {} : { at: this.#o.at }),
    });
    this.#state = "idle";
  }

  /**
   * Whether this device is the vault's fetch leader. TRANSITIONAL(S44): lab vaults carry no device
   * registry or lease chain yet (no creator pin without pairing and recovery words), so the leader is
   * the pinned default by construction: the device that created the vault here (its genesis is
   * recorded in the vault's bridge state). With the registry this becomes `devices.holdsLease` on the
   * vault's lease view, checked right before each plan.
   */
  #isLeader(v: OpenVault | undefined): boolean {
    return v !== undefined && v.state.genesis()?.status === "done";
  }

  #emit(line: Line): void {
    const progress = line.progress;
    if (typeof progress === "string") this.#o.log.info("sync.progress", { point: progress });
    else if (typeof line.step === "string") {
      const event = `sync.${line.step}`;
      if ("blocked" in line) this.#o.log.warn(event, logFields(line));
      else this.#o.log.info(event, logFields(line));
    }
    for (const sink of this.#sinks) sink(line);
  }

  /** Runs `fn` in its turn, with `out` receiving the turn's lines. */
  #inTurn<T>(fn: () => Promise<T>, out?: (line: Line) => void): Promise<T> {
    const run = async () => {
      if (out !== undefined) this.#sinks.add(out);
      try {
        return await fn();
      } finally {
        if (out !== undefined) this.#sinks.delete(out);
      }
    };
    const next = this.#turn.then(run, run);
    this.#turn = next.catch(() => undefined);
    return next;
  }

  /** Iterations until the outbox is idle (at most `max`). */
  async #iterate(max: number): Promise<RunOutcome> {
    const loop = this.#loop;
    if (loop === undefined) return { kind: "refused", reason: this.#state };
    this.#state = "running";
    this.#reason = undefined;
    this.#continueOnPoll = false;
    let iterations = 0;
    try {
      while (iterations < max && !this.#stopping) {
        iterations += 1;
        const r = await loop.iteration();
        this.#continueOnPoll = !r.idle;
        if (r.idle) break;
      }
      this.#marker = this.#reader?.changeMarker() ?? "";
      // Shipping may have seen idle before an edit arrived during the awaited carrier/pipe phase.
      // Read pending after the marker so a later edit still changes the next poll's marker.
      this.#continueOnPoll ||= (this.#reader?.pendingCount() ?? 0) > 0;
      this.#state = "idle";
      return { kind: "idle", iterations };
    } catch (error) {
      this.#continueOnPoll = false;
      if (error instanceof BlockedError) {
        this.#state = "blocked";
        this.#reason = error.reason;
        this.#o.log.warn("sync.blocked", { reason: error.reason });
        return { kind: "blocked", reason: error.reason };
      }
      this.#state = "error";
      this.#reason = errorName(error);
      this.#retryAt = this.#now() + Math.min(RETRY_MS, this.#config?.carrierMs ?? RETRY_MS);
      this.#o.log.error("sync.failed", { error: this.#reason });
      return { kind: "failed", error: this.#reason };
    } finally {
      this.#lastRunAt = this.#now();
    }
  }

  #schedule(ms: number): void {
    if (this.#stopping || this.#loop === undefined) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#tick();
    }, ms);
  }

  /** The poll / carrier tick: an iteration when Python's outbox changed or the carrier is due. */
  async #tick(): Promise<void> {
    const config = this.#config;
    if (config === undefined || this.#stopping) return;
    await this.#inTurn(async () => {
      if (this.#stopping || this.#state === "blocked") return;
      const now = this.#now();
      if (this.#state === "error" && now < this.#retryAt) return;
      let marker: string;
      try {
        marker = this.#reader?.changeMarker() ?? "";
      } catch (error) {
        this.#o.log.error("sync.poll-failed", { error: errorName(error) });
        return;
      }
      const carrierDue = this.#lastRunAt === undefined || now - this.#lastRunAt >= config.carrierMs;
      if (
        this.#continueOnPoll ||
        marker !== this.#marker ||
        carrierDue ||
        this.#state === "error"
      ) {
        await this.#iterate(MAX_ITERATIONS);
      }
    });
    this.#schedule(config.pollMs);
  }

  /** `cashu bridge run --once`: iterations until idle, the lines to `out`. Also clears a block. */
  runOnce(out: (line: Line) => void): Promise<RunOutcome> {
    return this.#inTurn(async () => {
      if (this.#stopping) return { kind: "refused", reason: "stopped" };
      if (this.#loop === undefined) return { kind: "refused", reason: this.#state };
      return this.#iterate(Number.POSITIVE_INFINITY);
    }, out);
  }

  /** `cashu bridge init`: the first start of a quiescent Python data dir (S31a spec 8). */
  init(out: (line: Line) => void): Promise<RunOutcome> {
    return this.#inTurn(async () => {
      const config = this.#config;
      const reader = this.#reader;
      const sodium = this.#sodium;
      if (this.#stopping) return { kind: "refused", reason: "stopped" };
      if (this.#state !== "uninitialized" || !config || !reader || !sodium) {
        return { kind: "refused", reason: this.#state === "idle" ? "linked" : this.#state };
      }
      try {
        await initVaults({
          config,
          reader,
          cli: pythonCli(config.python.argv, config.python.env),
          sodium,
          keyStore: labFileKeyStore(config.keys.path),
          openDb: this.#openDb,
          now: this.#now(),
          out: (line) => this.#emit(line),
        });
        await this.#openLinked();
      } catch (error) {
        if (error instanceof InitRefusedError || error instanceof RefusalError) {
          return { kind: "refused", reason: error.message.slice(0, 64) };
        }
        this.#o.log.error("sync.init-failed", { error: errorName(error) });
        return { kind: "failed", error: errorName(error) };
      }
      this.#o.log.info("sync.initialized", { vaults: this.#vaults.length });
      this.#schedule(0);
      return { kind: "idle", iterations: 0 };
    }, out);
  }

  status(): SyncStatus {
    let pending: number | undefined;
    try {
      pending = this.#reader?.pendingCount();
    } catch {
      pending = undefined;
    }
    return {
      state: this.#state,
      ...(this.#reason === undefined ? {} : { reason: this.#reason.slice(0, 64) }),
      ...(pending === undefined ? {} : { pending }),
      ...(this.#lastRunAt === undefined
        ? {}
        : { lastRunAt: new Date(this.#lastRunAt).toISOString() }),
      vaults: this.#vaults.map((v) => ({
        ordinal: v.ordinal,
        leader: this.#isLeader(v),
        intentOpen: v.state.intent() !== undefined,
        pipeSeq: v.state.pipeCursor().seq,
      })),
    };
  }

  #closeAll(): void {
    const vaults = this.#vaults;
    this.#vaults = [];
    this.#loop = undefined;
    for (const v of vaults) {
      v.close().catch((error: unknown) =>
        this.#o.log.error("sync.close-failed", { error: errorName(error) }),
      );
    }
    this.#reader?.close();
    this.#reader = undefined;
  }

  /** Lets the current turn finish, then closes the vaults (the host still holds its lock). */
  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#turn;
    const vaults = this.#vaults;
    this.#vaults = [];
    this.#loop = undefined;
    for (const v of vaults) await v.close();
    this.#reader?.close();
    this.#reader = undefined;
    if (this.#state !== "off") this.#state = "stopped";
    this.#o.log.info("sync.stopped");
  }
}
