// Commands (S24 5): the only way a writer changes a vault. A command validates its input (zod), reads
// this vault's view, and emits events; `runCommand` stamps them with the device's hybrid clock
// (strictly increasing HLCs, events.md 3.3 and 5), validates every envelope with the catalog's parser
// and its DET gid parts (a writer bug never reaches the log), and appends them as ONE batch through
// an `EventWriter`. The desktop and the phone wire the writer to the sync engine's local append; tests
// wire it to `store.applyEnvelopes`. Platform free: time comes from an injected `Clock`, gids from
// `mintUlid` with an injectable random source.
import type { HybridClock } from "@cashu/sync/hlc";
import type { z } from "zod";
import { parseEvent } from "./events/v1/catalog.js";
import { detPartsOf } from "./events/v1/det-parts.js";
import type { Envelope } from "./events/v1/envelope.js";
import { type DetGid, mintUlid } from "./gid.js";
import type { Store } from "./materialize.js";
import type { SqlValue } from "./sql/driver.js";

/** Wall-clock milliseconds since the epoch (UTC). */
export interface Clock {
  now(): number;
}

/** Appends one batch of validated logical envelopes (the sync engine's local append, or a test store). */
export interface EventWriter {
  append(envelopes: readonly Envelope[]): void;
}

/** The fetch lease (S29): leader-only commands refuse on a device that does not hold it. */
export interface Lease {
  isHolder(): boolean;
}

export interface CommandEnv {
  /** This device's id (32 lower-case hex); must equal the clock's device. */
  readonly device: string;
  readonly clock: Clock;
  /** The device's hybrid clock (state persisted by the caller, e.g. `metaClockStore`). */
  readonly hlc: HybridClock;
  readonly lease: Lease;
  /** Random bytes for ULIDs (default: the CSPRNG); tests pass a seeded source. */
  readonly random?: (n: number) => Uint8Array;
}

export interface EmitOptions {
  /** The eid of an event of this batch (or the log) this one is caused by (events.md 6.6). */
  readonly cause?: string;
}

export interface CommandContext {
  /** This vault's id (the gid of `profile.*` events). */
  readonly vault: string;
  /** Read-only SQL on this vault's view. */
  read<R>(sql: string, ...params: SqlValue[]): R[];
  readonly det: DetGid;
  /** A fresh ULID (created entities, gid.md 4.7). */
  newGid(): string;
  /** Now, from the injected clock, as an event timestamp (`YYYY-MM-DDTHH:MM:SS.mmmZ`). */
  now(): string;
  /** Today's calendar date in UTC (`YYYY-MM-DD`), from the injected clock. */
  today(): string;
  readonly lease: Lease;
  /** Queue one event of the batch; returns its eid (usable as a later event's `cause`). */
  emit(type: string, gid: string, data: Record<string, unknown>, opts?: EmitOptions): string;
}

/** An expected failure: a value-free reason code (never amounts, names or ids). */
export interface CommandRefusal {
  readonly ok: false;
  readonly reason: string;
}

export type CommandResult<R> = { readonly ok: true; readonly value: R } | CommandRefusal;

/**
 * `I` is the validated input the command runs with; `In` what callers may pass before zod applies
 * defaults (the type `useCommand(...).run` accepts).
 */
export interface Command<I, R, In = unknown> {
  readonly id: string;
  readonly input: z.ZodType<I, In>;
  run(ctx: CommandContext, input: I): CommandResult<R>;
}

export function defineCommand<I, R, In = unknown>(cmd: Command<I, R, In>): Command<I, R, In> {
  return cmd;
}

export const ok = <R>(value: R): CommandResult<R> => ({ ok: true, value });
export const refuse = (reason: string): CommandRefusal => ({ ok: false, reason });

export type CommandOutcome<R> =
  | { readonly ok: true; readonly value: R; readonly events: readonly Envelope[] }
  | CommandRefusal;

/** A writer bug: an emitted event the catalog would not fold as written. */
export class InvalidEmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEmitError";
  }
}

/** Width of an HLC string (`<wall9>-<counter4>-<device32>`): the prefix of a materializer hwm. */
const HLC_LEN = 47;

/**
 * Validate `raw` with `cmd.input`, run the command against `store`'s view and append what it emitted
 * as one batch. Input that fails validation is refused with `invalid_input`; a refusal emits nothing.
 */
export function runCommand<I, R>(
  store: Store,
  writer: EventWriter,
  cmd: Command<I, R>,
  raw: unknown,
  env: CommandEnv,
): CommandOutcome<R> {
  const parsed = cmd.input.safeParse(raw);
  if (!parsed.success) return refuse("invalid_input");
  if (env.hlc.device !== env.device) throw new RangeError("the clock belongs to another device");
  // A device's stamp sorts after everything it folded (events.md 6.7 point 4): merge the highest
  // folded HLC before stamping, so a guard checked here is never re-evaluated at an earlier position.
  const hwm = store
    .read<{ hwm: string | null }>("SELECT MAX(hwm) AS hwm FROM materializer_state")
    .at(0)?.hwm;
  if (hwm) env.hlc.receive(hwm.slice(0, HLC_LEN));

  const pending: { type: string; gid: string; data: Record<string, unknown>; cause?: string }[] =
    [];
  const eids: string[] = [];
  const random = env.random;
  const ulid = () => mintUlid(env.clock.now(), random);
  const iso = () => new Date(env.clock.now()).toISOString();
  const ctx: CommandContext = {
    vault: store.vault,
    read: (sql, ...params) => store.read(sql, ...params),
    det: store.deps.det,
    newGid: ulid,
    now: iso,
    today: () => iso().slice(0, 10),
    lease: env.lease,
    emit(type, gid, data, opts) {
      const eid = ulid();
      eids.push(eid);
      pending.push({
        type,
        gid,
        data,
        ...(opts?.cause === undefined ? {} : { cause: opts.cause }),
      });
      return eid;
    },
  };
  const result = cmd.run(ctx, parsed.data);
  if (!result.ok) return result;
  const events: Envelope[] = pending.map((p, i) => {
    const hlc = env.hlc.tick();
    const envelope = {
      eid: eids[i] as string,
      vault: store.vault,
      device: env.device,
      hlc,
      at: iso(),
      type: p.type,
      v: 1,
      gid: p.gid,
      data: p.data,
      ...(p.cause === undefined ? {} : { cause: p.cause }),
    };
    const check = parseEvent(envelope);
    if (check.status !== "known") {
      throw new InvalidEmitError(`${cmd.id}: ${p.type} would not fold (${check.status})`);
    }
    const parts = detPartsOf(p.type, p.data);
    if (parts !== undefined && store.deps.det(parts.table, parts.parts) !== p.gid) {
      throw new InvalidEmitError(`${cmd.id}: ${p.type} carries a gid its payload does not derive`);
    }
    return check.event;
  });
  if (events.length > 0) writer.append(events);
  return { ok: true, value: result.value, events };
}

/** An `EventWriter` that applies the batch to a store directly (tests, a single-device CLI). */
export function storeWriter(store: Store): EventWriter {
  return {
    append(envelopes) {
      store.applyEnvelopes(envelopes);
    },
  };
}
