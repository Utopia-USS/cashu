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
  /** Reserve eid and order now; resolve data once after a successful run, before validation/append. */
  emitDeferred(
    type: string,
    gid: string,
    resolveData: () => Record<string, unknown>,
    opts?: EmitOptions,
  ): string;
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

/** A validated command event before the sync engine assigns its durable HLC. */
export interface PreparedEvent {
  readonly eid: string;
  readonly vault: string;
  readonly device: string;
  readonly at: string;
  readonly type: string;
  readonly v: number;
  readonly gid: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly cause?: string;
  readonly origin?: string;
  readonly hlc?: never;
  readonly [key: string]: unknown;
}
export type PreparedOutcome<R> =
  | { readonly ok: true; readonly value: R; readonly events: readonly PreparedEvent[] }
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
const preparedEvents = new WeakSet<object>();

/** Internal seam for callers that must fingerprint the same parsed input before deciding. */
export function parseCommandInput<I, R>(
  cmd: Command<I, R>,
  raw: unknown,
): { readonly ok: true; readonly value: I } | CommandRefusal {
  const parsed = cmd.input.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : refuse("invalid_input");
}

type ResolvedEvent = {
  readonly eid: string;
  readonly type: string;
  readonly gid: string;
  readonly data: Record<string, unknown>;
  readonly cause?: string;
};

function decideCommand<I, R>(
  store: Store,
  cmd: Command<I, R>,
  input: I,
  env: Pick<CommandEnv, "clock" | "lease" | "random">,
):
  | { readonly ok: true; readonly value: R; readonly events: readonly ResolvedEvent[] }
  | CommandRefusal {
  type Pending = {
    type: string;
    gid: string;
    payload:
      | { kind: "static"; data: Record<string, unknown> }
      | { kind: "deferred"; resolveData: () => Record<string, unknown> };
    cause?: string;
  };
  const pending: Pending[] = [];
  const eids: string[] = [];
  let emitting = true;
  let lateEmissionAttempted = false;
  const random = env.random;
  const ulid = () => mintUlid(env.clock.now(), random);
  const iso = () => new Date(env.clock.now()).toISOString();
  const queue = (item: Pending): string => {
    if (!emitting) {
      lateEmissionAttempted = true;
      throw new InvalidEmitError(`${cmd.id}: cannot emit while resolving deferred data`);
    }
    const eid = ulid();
    eids.push(eid);
    pending.push(item);
    return eid;
  };
  const ctx: CommandContext = {
    vault: store.vault,
    read: (sql, ...params) => store.read(sql, ...params),
    det: store.deps.det,
    newGid: ulid,
    now: iso,
    today: () => iso().slice(0, 10),
    lease: env.lease,
    emit(type, gid, data, opts) {
      return queue({
        type,
        gid,
        payload: { kind: "static", data },
        ...(opts?.cause === undefined ? {} : { cause: opts.cause }),
      });
    },
    emitDeferred(type, gid, resolveData, opts) {
      return queue({
        type,
        gid,
        payload: { kind: "deferred", resolveData },
        ...(opts?.cause === undefined ? {} : { cause: opts.cause }),
      });
    },
  };
  const result = (() => {
    try {
      return cmd.run(ctx, input);
    } finally {
      emitting = false;
    }
  })();
  if (!result.ok) return result;
  const events = pending.map((p, i): ResolvedEvent => {
    const data = p.payload.kind === "deferred" ? p.payload.resolveData() : p.payload.data;
    if (lateEmissionAttempted) {
      throw new InvalidEmitError(`${cmd.id}: a deferred resolver tried to emit`);
    }
    if (p.payload.kind === "deferred") {
      const prototype =
        data !== null && typeof data === "object" ? Object.getPrototypeOf(data) : undefined;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new InvalidEmitError(`${cmd.id}: deferred data must be a plain record`);
      }
    }
    return {
      eid: eids[i] as string,
      type: p.type,
      gid: p.gid,
      data,
      ...(p.cause === undefined ? {} : { cause: p.cause }),
    };
  });
  return { ok: true, value: result.value, events };
}

function validateEvent(store: Store, cmdId: string, envelope: Envelope): Envelope {
  const check = parseEvent(envelope);
  if (check.status !== "known") {
    throw new InvalidEmitError(`${cmdId}: ${envelope.type} would not fold (${check.status})`);
  }
  const parts = detPartsOf(envelope.type, envelope.data);
  if (parts !== undefined && store.deps.det(parts.table, parts.parts) !== envelope.gid) {
    throw new InvalidEmitError(
      `${cmdId}: ${envelope.type} carries a gid its payload does not derive`,
    );
  }
  return check.event;
}

function immutableJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new InvalidEmitError("event contains a non-JSON value");
  if (seen.has(value)) throw new InvalidEmitError("event contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = Object.freeze(
      value.map((entry) => immutableJson(entry === undefined ? null : entry, seen)),
    );
    seen.delete(value);
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidEmitError("event contains a non-plain record");
  }
  const copy: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) copy[key] = immutableJson(entry, seen);
  }
  seen.delete(value);
  return Object.freeze(copy);
}

/** Only preparation-created, deeply frozen events may cross into the unstamped converter. */
export function assertPreparedEvent(event: PreparedEvent): void {
  if (!preparedEvents.has(event)) throw new InvalidEmitError("event was not prepared");
}

/** Decide a command without advancing the durable clock or retaining its mutable payload. */
export function prepareParsedCommand<I, R>(
  store: Store,
  cmd: Command<I, R>,
  input: I,
  env: Pick<CommandEnv, "device" | "clock" | "lease" | "random">,
): PreparedOutcome<R> {
  const decided = decideCommand(store, cmd, input, env);
  if (!decided.ok) return decided;
  const events = decided.events.map((event): PreparedEvent => {
    const checked = validateEvent(store, cmd.id, {
      ...event,
      vault: store.vault,
      device: env.device,
      hlc: `000000000-0000-${env.device}`,
      at: new Date(env.clock.now()).toISOString(),
      v: 1,
    });
    const { hlc: _hlc, ...unstamped } = checked;
    const snapshot = immutableJson(unstamped) as PreparedEvent;
    preparedEvents.add(snapshot);
    return snapshot;
  });
  return { ok: true, value: decided.value, events: Object.freeze(events) };
}

export function prepareCommand<I, R>(
  store: Store,
  cmd: Command<I, R>,
  raw: unknown,
  env: Pick<CommandEnv, "device" | "clock" | "lease" | "random">,
): PreparedOutcome<R> {
  const parsed = parseCommandInput(cmd, raw);
  return parsed.ok ? prepareParsedCommand(store, cmd, parsed.value, env) : parsed;
}

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
  const parsed = parseCommandInput(cmd, raw);
  if (!parsed.ok) return parsed;
  if (env.hlc.device !== env.device) throw new RangeError("the clock belongs to another device");
  // A device's stamp sorts after everything it folded (events.md 6.7 point 4): merge the highest
  // folded HLC before stamping, so a guard checked here is never re-evaluated at an earlier position.
  const hwm = store
    .read<{ hwm: string | null }>("SELECT MAX(hwm) AS hwm FROM materializer_state")
    .at(0)?.hwm;
  if (hwm) env.hlc.receive(hwm.slice(0, HLC_LEN));

  const decided = decideCommand(store, cmd, parsed.value, env);
  if (!decided.ok) return decided;
  const iso = () => new Date(env.clock.now()).toISOString();
  const events: Envelope[] = decided.events.map((event) => {
    const hlc = env.hlc.tick();
    return validateEvent(store, cmd.id, {
      ...event,
      vault: store.vault,
      device: env.device,
      hlc,
      at: iso(),
      v: 1,
    });
  });
  if (events.length > 0) writer.append(events);
  return { ok: true, value: decided.value, events };
}

/** An `EventWriter` that applies the batch to a store directly (tests, a single-device CLI). */
export function storeWriter(store: Store): EventWriter {
  return {
    append(envelopes) {
      store.applyEnvelopes(envelopes);
    },
  };
}
