// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a spec 2.4, 5.5, 6).
//
// The daemon's one serialized loop over every linked vault: recover an open intent, ship the Python
// outbox (plan -> intents durable -> one frame per vault -> ack with field clocks -> clear), sync
// (push own bytes, pull and fold foreign frames), pipe the other devices' events to Python. The steps
// never interleave: nothing is piped while a shipped row is unacked (spec 2.4 invariant), so Python's
// "an unacked local write beats any inbound event" is exact.
//
// Exactly once (spec 6.2): a batch enters the log only through `engine.write` of a stored intent and
// is one frame (wholly durable or absent); before re-writing an intent, recovery catches the store up
// (`engine.sync()`) and checks its eids: all present -> do not write, none -> write the SAME batch,
// some -> block `partial-intent`. Rows are acked only after their events are durable; the ack is
// idempotent. Progress lines (`intent`, `written`, `acked`, `cleared`) mark the crash points the kill
// test targets. Output: counts only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bridge } from "@cashu/store";
import type { PythonCli } from "./python/cli.js";
import type { PythonReader } from "./python/reader.js";
import type { Intent } from "./state.js";
import type { OpenVault } from "./vault.js";

/** Events per `sync apply` run (spec 5.5). */
const PIPE_PAGE = 500;
/** Plans per ship step before the loop yields to sync / pipe (a large backlog ships over iterations). */
const MAX_PLANS = 50;

/** Printed crash points, and `vaultWritten` (one vault of a multi-vault plan written; tests only). */
export type CrashPoint = "intent" | "written" | "acked" | "cleared" | "vaultWritten";

export interface LoopDeps {
  readonly reader: PythonReader;
  readonly cli: PythonCli;
  /** Linked vaults, ordinal order. */
  readonly vaults: readonly OpenVault[];
  /** Profile id -> slug (in memory only; passed to `cashu --profile`). */
  readonly slugs: ReadonlyMap<number, string>;
  readonly ports: bridge.BridgePorts;
  /** Wall clock (ms): the `at` of a shipped cushion edit. */
  readonly now: () => number;
  /** One JSON line per step (counts only). */
  readonly out: (line: Readonly<Record<string, unknown>>) => void;
  /** Test hook: called at each crash point (a test throws there to simulate a kill). */
  readonly at?: (point: CrashPoint) => void;
}

export class BlockedError extends Error {
  readonly exitCode = 65;
  readonly reason: string;
  constructor(reason: string) {
    super(`blocked: ${reason}`);
    this.name = "BlockedError";
    this.reason = reason;
  }
}

export interface ShipResult {
  readonly plans: number;
  readonly rows: number;
  readonly events: number;
  readonly idle: boolean;
}

const sumCounts = (a: Record<string, number>, b: Readonly<Record<string, unknown>>) => {
  for (const [k, v] of Object.entries(b)) if (typeof v === "number") a[k] = (a[k] ?? 0) + v;
  return a;
};

export class Loop {
  readonly #d: LoopDeps;

  constructor(deps: LoopDeps) {
    this.#d = deps;
  }

  #point(p: CrashPoint): void {
    this.#d.out({ progress: p });
    this.#d.at?.(p);
  }

  #tmpDir(v: OpenVault): string {
    const dir = join(v.dir, "tmp");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Finishes an open plan left by a crash (spec 6.3). */
  async recover(): Promise<boolean> {
    const open = this.#d.vaults.flatMap((v) => {
      const intent = v.state.intent();
      return intent === undefined ? [] : [{ v, intent }];
    });
    if (open.length === 0) return false;
    const planIds = new Set(open.map((o) => o.intent.planId));
    if (planIds.size !== 1) throw new BlockedError("partial-intent");
    const first = open[0];
    if (first === undefined) return false;
    const expected = first.intent.vaults;
    const present = new Map<OpenVault, ReadonlyMap<string, string>>();
    for (const { v, intent } of open) {
      await v.engine.sync(); // catch up: own durable frames the store missed are applied now
      const eids = intent.batch.events.map((e) => e.i);
      const held = v.store.eventHlcs(eids);
      if (held.size !== 0 && held.size !== eids.length) throw new BlockedError("partial-intent");
      present.set(v, held);
    }
    if (open.length < expected) {
      // A crash while the intents were stored: writes start only after all are stored.
      if ([...present.values()].some((h) => h.size > 0)) throw new BlockedError("partial-intent");
      for (const { v } of open) v.state.clearIntent();
      this.#d.out({ step: "recover", discarded: open.length });
      return true;
    }
    let rewritten = 0;
    for (const { v, intent } of open) {
      if ((present.get(v)?.size ?? 0) === 0 && intent.batch.events.length > 0) {
        await v.engine.write(intent.batch.events);
        rewritten += 1;
      }
    }
    this.#ack(open.map((o) => o));
    this.#d.out({ step: "recover", vaults: open.length, rewritten });
    return true;
  }

  /** Acks a written plan (every vault's batch durable) and clears its intents. */
  #ack(members: readonly { v: OpenVault; intent: Intent }[]): number {
    const first = members[0];
    if (first === undefined) return 0;
    const hlcs = new Map<string, string>();
    for (const { v, intent } of members) {
      for (const [eid, hlc] of v.store.eventHlcs(intent.batch.events.map((e) => e.i))) {
        hlcs.set(eid, hlc);
      }
    }
    const plan: bridge.Plan = {
      through: first.intent.through,
      batches: members.map((m) => m.intent.batch),
      counts: {
        txns: 0,
        rows: 0,
        events: 0,
        notLeader: 0,
        unlinked: 0,
        sharedUnheld: 0,
        noEvent: 0,
        closure: 0,
      },
    };
    const entries = bridge.ackEntries(plan, hlcs);
    this.#d.cli.ack(first.intent.through, entries, this.#tmpDir(first.v));
    this.#point("acked");
    for (const { v } of members) v.state.clearIntent();
    this.#point("cleared");
    return entries.length;
  }

  /** One plan: returns false when the outbox is empty. Throws `BlockedError` on a block (D4). */
  async #shipOne(): Promise<{ rows: number; events: number } | undefined> {
    const rows = this.#d.reader.pending();
    if (rows.length === 0) return undefined;
    let live: ReadonlyMap<number, bridge.CurrentRows> | undefined;
    const liveRows = () => {
      live ??= this.#d.reader.liveRows();
      return live;
    };
    const vaults: bridge.VaultInput[] = this.#d.vaults.map((v) => ({
      ordinal: v.ordinal,
      profileId: v.profileId,
      vault: v.vaultId,
      salt: v.salt,
      syncIds: this.#d.reader.syncIds(v.profileId),
      current: () => {
        const rows = liveRows().get(v.profileId);
        if (rows === undefined) throw new bridge.BridgeBlock("profile-missing");
        return rows;
      },
      files: this.#d.reader.files,
    }));
    const result = bridge.plan({ rows, vaults, ports: this.#d.ports });
    if (!result.ok) {
      this.#d.out({ step: "ship", blocked: result.reason });
      throw new BlockedError(result.reason);
    }
    const p = result.plan;
    const planId = this.#d.ports.ulid();
    const byVault = new Map(this.#d.vaults.map((v) => [v.ordinal, v]));
    const members: { v: OpenVault; intent: Intent }[] = [];
    for (const batch of p.batches) {
      const v = byVault.get(batch.ordinal);
      if (v === undefined) throw new Error("a plan batch for a vault that is not open");
      members.push({ v, intent: { planId, vaults: p.batches.length, through: p.through, batch } });
    }
    for (const m of members) m.v.state.putIntent(m.intent);
    this.#point("intent");
    for (const m of members) {
      if (m.intent.batch.events.length > 0) await m.v.engine.write(m.intent.batch.events);
      this.#d.at?.("vaultWritten");
    }
    this.#point("written");
    if (members.length > 0) {
      this.#ack(members);
    } else {
      // Nothing to write (unlinked or no-event rows only): ack the rows without clocks.
      const v = this.#d.vaults[0];
      if (v !== undefined) this.#d.cli.ack(p.through, [], this.#tmpDir(v));
    }
    const c = p.counts;
    this.#d.out({
      step: "ship",
      txns: c.txns,
      rows: c.rows,
      events: c.events,
      notLeader: c.notLeader,
      unlinked: c.unlinked,
      sharedUnheld: c.sharedUnheld,
      noEvent: c.noEvent,
      closure: c.closure,
      gids: p.batches.reduce((n, b) => n + b.gids.length, 0),
    });
    return { rows: c.rows, events: c.events };
  }

  /**
   * The cushion of each vault's `budget.json` when it differs from the last shipped value (spec 4.6,
   * D7a). A crash between the write and the record ships the same value again: an LWW register, so
   * the second event changes nothing.
   */
  async #shipCushions(): Promise<number> {
    let shipped = 0;
    for (const v of this.#d.vaults) {
      const slug = this.#d.slugs.get(v.profileId);
      if (slug === undefined) continue;
      const input: bridge.VaultInput = {
        ordinal: v.ordinal,
        profileId: v.profileId,
        vault: v.vaultId,
        salt: v.salt,
        syncIds: this.#d.reader.syncIds(v.profileId),
        current: () => {
          throw new bridge.BridgeBlock("cushion-needs-no-rows");
        },
        files: this.#d.reader.files,
      };
      const at = new Date(this.#d.now()).toISOString();
      let ship: bridge.CushionShip | undefined;
      try {
        ship = bridge.cushionShip(input, slug, v.state.cushionShipped(), at, this.#d.ports);
      } catch (e) {
        if (e instanceof bridge.BridgeBlock) throw new BlockedError(e.reason);
        throw e;
      }
      if (ship === undefined) continue;
      await v.engine.write(ship.events);
      v.state.setCushionShipped(ship.value);
      shipped += 1;
    }
    if (shipped > 0) this.#d.out({ step: "cushion", shipped });
    return shipped;
  }

  /** Ships until the outbox is empty (or `MAX_PLANS` plans), then a changed cushion. */
  async ship(): Promise<ShipResult> {
    let plans = 0;
    let rows = 0;
    let events = 0;
    while (plans < MAX_PLANS) {
      const r = await this.#shipOne();
      if (r === undefined) {
        events += await this.#shipCushions();
        return { plans, rows, events, idle: true };
      }
      plans += 1;
      rows += r.rows;
      events += r.events;
    }
    return { plans, rows, events, idle: false };
  }

  /** Push own bytes, pull and fold the other devices' frames, per vault. */
  async sync(): Promise<void> {
    for (const v of this.#d.vaults) {
      const r = await v.engine.sync();
      this.#d.out({
        step: "sync",
        vault: v.ordinal,
        pulledFrames: r.pulledFrames,
        applied: r.applied,
        duplicates: r.duplicates,
        parked: r.parked,
        rejected: r.rejected.length,
        offlineRemotes: r.offlineRemotes,
      });
      if (r.rolledBack) throw new BlockedError("rolled-back");
    }
  }

  /** The other devices' events since the pipe cursor -> `cashu sync apply --stdin` (spec 5.5). */
  pipe(): void {
    for (const v of this.#d.vaults) {
      const slug = this.#d.slugs.get(v.profileId);
      if (slug === undefined) throw new BlockedError("profile-missing");
      let cursor = v.state.pipeCursor();
      if (cursor.seq > 0 && v.store.eidAt(cursor.seq) !== cursor.eid) cursor = { seq: 0, eid: "" };
      const exclude = new Set([v.device, v.genesisDevice]);
      const totals: Record<string, number> = { piped: 0 };
      for (;;) {
        const page = v.store.foreignEvents(cursor.seq, exclude, PIPE_PAGE);
        if (page.last === undefined) break;
        if (page.events.length > 0) {
          const counts = this.#d.cli.apply(
            slug,
            page.events.map((e) => JSON.stringify(e)),
          );
          sumCounts(totals, counts);
          totals.piped = (totals.piped ?? 0) + page.events.length;
        }
        cursor = page.last;
        v.state.setPipeCursor(cursor);
      }
      this.#d.out({ step: "pipe", vault: v.ordinal, ...totals });
    }
  }

  /** One iteration: recover, ship, sync, pipe (spec 2.4). */
  async iteration(): Promise<ShipResult> {
    await this.recover();
    const shipped = await this.ship();
    await this.sync();
    this.pipe();
    return shipped;
  }
}
