// Portable durable command boundary. The caller owns one non-reentrant per-vault queue shared with
// sync and inbound apply. Call this function outside a prior queue acquisition.

import { Decimal } from "@cashu/domain";
import { ownBatchDigest, type SyncEngine, type UnstampedEvent } from "@cashu/sync/engine";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "./canonical.js";
import {
  assertPreparedEvent,
  type Clock,
  type Command,
  type CommandRefusal,
  InvalidEmitError,
  type Lease,
  type PreparedEvent,
  type PreparedOutcome,
  parseCommandInput,
  prepareParsedCommand,
} from "./command.js";
import { parseEvent } from "./events/v1/catalog.js";
import type { Store } from "./materialize.js";

const EXECUTION_CONTRACT = "cashu-durable-command-v1";
const HLC_LEN = 47;

export type DurableCommandResult<R> =
  | { readonly kind: "completed"; readonly value: R; readonly eids: readonly string[] }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "not_started"; readonly reason: string }
  | {
      readonly kind: "outcome_unknown";
      readonly key: string;
      /** Omitted only when the attempt ledger could not be read. */
      readonly attemptId?: string;
      readonly eids?: readonly string[];
    };

export type AttemptLookup<R> =
  | { readonly phase: "absent" }
  | {
      readonly phase: "may_append";
      readonly attemptId: string;
      readonly fingerprint: string;
      readonly eids: readonly string[];
      readonly digest?: string;
    }
  | {
      readonly phase: "completed";
      readonly attemptId: string;
      readonly fingerprint: string;
      readonly eids: readonly string[];
      readonly digest?: string;
      /** Undefined when the private completed-result receipt expired; the key tombstone remains. */
      readonly receipt: { readonly value: R } | undefined;
    }
  | {
      readonly phase: "terminal";
      readonly attemptId: string;
      readonly fingerprint: string;
      readonly result: { readonly kind: "refused" | "not_started"; readonly reason: string };
    };

export interface AttemptRecord {
  readonly vault: string;
  readonly key: string;
  readonly attemptId: string;
  readonly commandId: string;
  readonly fingerprint: string;
}

/** Pending rows hold only opaque metadata and EIDs, never parsed input, payload or result. */
export interface CommandAttemptPort<R> {
  lookup(vault: string, key: string): Promise<AttemptLookup<R>>;
  /** Atomic insert-if-absent; a conflict returns the existing record without replacing it. */
  saveMayAppend(
    record: AttemptRecord & { readonly eids: readonly string[]; readonly digest?: string },
  ): Promise<AttemptLookup<R>>;
  /** Atomically persist a private receipt and durable key tombstone before acknowledging success. */
  markCompleted(attemptId: string, receipt: R): Promise<void>;
  /** Atomic insert-if-absent for refusals before any engine invocation. */
  recordTerminal(
    record: AttemptRecord & {
      readonly result: { readonly kind: "refused" | "not_started"; readonly reason: string };
    },
  ): Promise<AttemptLookup<R>>;
  unresolved(
    vault: string,
  ): Promise<
    readonly (AttemptRecord & { readonly eids: readonly string[]; readonly digest?: string })[]
  >;
}

/** The same queue must serialize command preparation and every local sync entry point. */
export interface VaultCommandQueue {
  run<T>(vault: string, task: () => Promise<T>): Promise<T>;
}

export interface DurableCommandSession<R> {
  readonly vault: string;
  readonly device: string;
  readonly store: Store;
  readonly engine: SyncEngine;
  readonly clock: Clock;
  readonly lease: Lease;
  readonly attempts: CommandAttemptPort<R>;
  readonly queue: VaultCommandQueue;
  readonly isCurrent: () => boolean;
  readonly random?: (n: number) => Uint8Array;
  /** Attempt IDs are opaque and unique; the caller may use a CSPRNG-backed ULID. */
  readonly newAttemptId: () => string;
}

/** Hash the canonical parsed input under an explicit execution-contract domain. */
export function commandFingerprint(vault: string, commandId: string, parsedInput: unknown): string {
  return bytesToHex(
    sha256(
      utf8ToBytes(
        canonicalJson([EXECUTION_CONTRACT, vault, commandId, fingerprintValue(parsedInput)]),
      ),
    ),
  );
}

/** Copy supported parsed input synchronously so caller mutation cannot race the ledger lookup. */
function detachedInput<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (typeof value === "function") throw new TypeError("unsupported command input function");
  if (value instanceof Decimal) {
    return Object.freeze(Decimal.fromTriple(value.sign, value.digits, value.exp)) as T;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("unsupported command input date");
    return new Date(value.getTime()) as T;
  }
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (seen.has(value)) throw new TypeError("cyclic command input");
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = Array.from({ length: value.length }, (_, index) => {
      if (!(index in value)) throw new TypeError("sparse command input array");
      return detachedInput(value[index], seen);
    });
    seen.delete(value);
    return Object.freeze(copy) as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("unsupported command input object");
  }
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length) {
    throw new TypeError("unsupported command input property");
  }
  const copy: Record<string, unknown> = Object.create(prototype);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("unsupported command input accessor");
    }
    Object.defineProperty(copy, key, {
      value: detachedInput(descriptor.value, seen),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  seen.delete(value);
  return Object.freeze(copy) as T;
}

/** Tagged, type-preserving canonical form for parsed imports and ordinary command inputs. */
function fingerprintValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("unsupported command input number");
    return ["number", Object.is(value, -0) ? "-0" : value.toString()];
  }
  if (typeof value !== "object") throw new TypeError("unsupported command input type");
  if (value instanceof Decimal) return ["decimal", value.sign, value.digits, value.exp];
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("unsupported command input date");
    return ["date", value.toISOString()];
  }
  if (value instanceof Uint8Array) return ["bytes", bytesToHex(value)];
  if (seen.has(value)) throw new TypeError("cyclic command input");
  seen.add(value);
  if (Array.isArray(value)) {
    const encoded = ["array", value.map((item) => fingerprintValue(item, seen))];
    seen.delete(value);
    return encoded;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("unsupported command input object");
  }
  const encoded = [
    "object",
    Object.keys(value)
      .sort()
      .map((key) => [key, fingerprintValue((value as Record<string, unknown>)[key], seen)]),
  ];
  seen.delete(value);
  return encoded;
}

/** Convert only immutable preparation-owned events; validate the snapshot again before writing. */
export function toUnstampedEvent(prepared: PreparedEvent): UnstampedEvent {
  assertPreparedEvent(prepared);
  const checked = parseEvent({
    ...prepared,
    hlc: `000000000-0000-${prepared.device}`,
  });
  if (checked.status !== "known") throw new InvalidEmitError("prepared event is invalid");
  // Preparation checked the DET derivation with the store salt. Its branded snapshot is immutable.
  // This second check also rejects malformed detached data or unsupported catalog versions.
  const {
    eid,
    vault: _vault,
    device: _device,
    hlc: _hlc,
    at,
    type,
    v,
    gid,
    data,
    cause,
    origin,
    ...extra
  } = checked.event;
  return {
    ...extra,
    t: type,
    v,
    i: eid,
    g: gid,
    a: at,
    d: data,
    ...(cause === undefined ? {} : { c: cause }),
    ...(origin === undefined ? {} : { o: origin }),
  };
}

function foldedHwm(store: Store): string | undefined {
  const hwm = store
    .read<{ hwm: string | null }>("SELECT MAX(hwm) AS hwm FROM materializer_state")
    .at(0)?.hwm;
  return hwm ? hwm.slice(0, HLC_LEN) : undefined;
}

function existingResult<R>(
  lookup: AttemptLookup<R>,
  fingerprint: string,
  key: string,
): DurableCommandResult<R> {
  if (lookup.phase === "absent") return { kind: "not_started", reason: "attempt_missing" };
  if (lookup.fingerprint !== fingerprint)
    return { kind: "refused", reason: "request_key_conflict" };
  if (lookup.phase === "may_append") {
    return { kind: "outcome_unknown", key, attemptId: lookup.attemptId, eids: lookup.eids };
  }
  if (lookup.phase === "terminal") return lookup.result;
  if (lookup.receipt === undefined) {
    return { kind: "outcome_unknown", key, attemptId: lookup.attemptId, eids: lookup.eids };
  }
  return { kind: "completed", value: lookup.receipt.value, eids: lookup.eids };
}

function sessionCurrent<R>(session: DurableCommandSession<R>): boolean {
  try {
    return (
      session.store.vault === session.vault &&
      session.engine.vault === session.vault &&
      session.engine.device === session.device &&
      session.isCurrent()
    );
  } catch {
    return false;
  }
}

/**
 * One queue acquisition spans key lookup, decision, metadata, engine write and receipt. A saved
 * may_append attempt is never replayed, even if no write was invoked before interruption.
 */
export async function executeDurableCommand<I, R>(
  session: DurableCommandSession<R>,
  cmd: Command<I, R>,
  raw: unknown,
  key: string,
  beforeMayAppend?: () => Promise<void>,
): Promise<DurableCommandResult<R>> {
  let parsed: { readonly ok: true; readonly value: I } | CommandRefusal;
  try {
    parsed = parseCommandInput(cmd, raw);
  } catch {
    return { kind: "refused", reason: "invalid_input" };
  }
  if (!parsed.ok) return { kind: "refused", reason: parsed.reason };
  let input: I;
  let fingerprint: string;
  try {
    input = detachedInput(parsed.value);
    fingerprint = commandFingerprint(session.vault, cmd.id, input);
  } catch {
    return { kind: "refused", reason: "unsupported_input" };
  }
  try {
    return await session.queue.run(session.vault, async (): Promise<DurableCommandResult<R>> => {
      if (!sessionCurrent(session)) return { kind: "not_started", reason: "session_unavailable" };
      let lookup: AttemptLookup<R>;
      try {
        lookup = await session.attempts.lookup(session.vault, key);
      } catch {
        return { kind: "outcome_unknown", key };
      }
      if (lookup.phase !== "absent") return existingResult(lookup, fingerprint, key);
      if (!sessionCurrent(session)) return { kind: "not_started", reason: "session_unavailable" };
      let attemptId: string;
      try {
        attemptId = session.newAttemptId();
      } catch {
        return { kind: "not_started", reason: "attempt_id_failed" };
      }
      const base = { vault: session.vault, key, attemptId, commandId: cmd.id, fingerprint };
      let prepared: PreparedOutcome<R>;
      try {
        prepared = prepareParsedCommand(session.store, cmd, input, session);
      } catch {
        return { kind: "not_started", reason: "preparation_failed" };
      }
      if (!prepared.ok) {
        try {
          const saved = await session.attempts.recordTerminal({
            ...base,
            result: { kind: "refused", reason: prepared.reason },
          });
          return existingResult(saved, fingerprint, key);
        } catch {
          return { kind: "not_started", reason: "attempt_save_failed" };
        }
      }
      let events: UnstampedEvent[];
      let digest: string | undefined;
      try {
        events = prepared.events.map(toUnstampedEvent);
        // Nothing is appended yet: a batch the proof cannot digest was never started.
        digest = events.length === 0 ? undefined : ownBatchDigest(events);
      } catch {
        return { kind: "not_started", reason: "preparation_failed" };
      }
      const eids = prepared.events.map((event) => event.eid);
      if (beforeMayAppend) {
        try {
          await beforeMayAppend();
        } catch {
          return { kind: "not_started", reason: "checkpoint_failed" };
        }
        if (!sessionCurrent(session)) return { kind: "not_started", reason: "session_unavailable" };
      }
      let saved: AttemptLookup<R>;
      try {
        saved = await session.attempts.saveMayAppend({
          ...base,
          eids,
          ...(digest === undefined ? {} : { digest }),
        });
      } catch {
        return { kind: "not_started", reason: "attempt_save_failed" };
      }
      if (
        saved.phase !== "may_append" ||
        saved.attemptId !== attemptId ||
        saved.fingerprint !== fingerprint ||
        saved.eids.length !== eids.length ||
        (saved.digest !== undefined && saved.digest !== digest) ||
        saved.eids.some((eid, index) => eid !== eids[index])
      ) {
        return existingResult(saved, fingerprint, key);
      }
      if (!sessionCurrent(session)) return { kind: "outcome_unknown", key, attemptId, eids };
      if (events.length === 0) {
        try {
          await session.attempts.markCompleted(attemptId, prepared.value);
          if (!sessionCurrent(session)) return { kind: "outcome_unknown", key, attemptId, eids };
          return { kind: "completed", value: prepared.value, eids };
        } catch {
          return { kind: "outcome_unknown", key, attemptId, eids };
        }
      }
      // This synchronous read is adjacent to invocation inside the external per-vault queue.
      let writeInvoked = false;
      try {
        const afterHlc = foldedHwm(session.store);
        writeInvoked = true;
        await session.engine.write(events, afterHlc === undefined ? undefined : { afterHlc });
        if (!sessionCurrent(session)) return { kind: "outcome_unknown", key, attemptId, eids };
        await session.attempts.markCompleted(attemptId, prepared.value);
        if (!sessionCurrent(session)) return { kind: "outcome_unknown", key, attemptId, eids };
        return { kind: "completed", value: prepared.value, eids };
      } catch {
        // Once invoked, rejection can occur after encrypted append or local apply.
        if (!writeInvoked) {
          // The may_append record is already durable, so a restart must keep this key ambiguous.
          return { kind: "outcome_unknown", key, attemptId, eids };
        }
        return { kind: "outcome_unknown", key, attemptId, eids };
      }
    });
  } catch {
    // A queue can reject after running the callback; only the original key is certainly known.
    return { kind: "outcome_unknown", key };
  }
}
