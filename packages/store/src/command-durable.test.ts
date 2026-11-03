import { Decimal } from "@cashu/domain";
import type { SyncEngine, UnstampedEvent, WriteResult } from "@cashu/sync";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCommand, ok } from "./command.js";
import {
  type AttemptLookup,
  type AttemptRecord,
  type CommandAttemptPort,
  commandFingerprint,
  type DurableCommandSession,
  executeDurableCommand,
  type VaultCommandQueue,
} from "./command-durable.js";
import { testEnv } from "./testing/commands.js";
import { openTestStore } from "./testing/store.js";

class Attempts<R> implements CommandAttemptPort<R> {
  readonly rows = new Map<string, AttemptLookup<R>>();
  failSave = false;
  failComplete = false;
  failLookup = false;
  onSave?: () => void;
  onLookup?: () => Promise<void>;

  async lookup(_vault: string, key: string): Promise<AttemptLookup<R>> {
    if (this.failLookup) throw new Error("synthetic lookup fault");
    await this.onLookup?.();
    return this.rows.get(key) ?? { phase: "absent" };
  }

  async saveMayAppend(
    record: AttemptRecord & { readonly eids: readonly string[] },
  ): Promise<AttemptLookup<R>> {
    if (this.failSave) throw new Error("synthetic metadata fault");
    const existing = this.rows.get(record.key);
    if (existing) return existing;
    const row: AttemptLookup<R> = {
      phase: "may_append",
      attemptId: record.attemptId,
      fingerprint: record.fingerprint,
      eids: [...record.eids],
    };
    this.rows.set(record.key, row);
    this.onSave?.();
    return row;
  }

  async markCompleted(attemptId: string, receipt: R): Promise<void> {
    if (this.failComplete) throw new Error("synthetic receipt fault");
    for (const [key, row] of this.rows) {
      if (row.phase === "may_append" && row.attemptId === attemptId) {
        this.rows.set(key, { ...row, phase: "completed", receipt: { value: receipt } });
        return;
      }
    }
    throw new Error("attempt missing");
  }

  async recordTerminal(
    record: AttemptRecord & {
      readonly result: { readonly kind: "refused" | "not_started"; readonly reason: string };
    },
  ): Promise<AttemptLookup<R>> {
    const existing = this.rows.get(record.key);
    if (existing) return existing;
    const row: AttemptLookup<R> = {
      phase: "terminal",
      attemptId: record.attemptId,
      fingerprint: record.fingerprint,
      result: record.result,
    };
    this.rows.set(record.key, row);
    return row;
  }

  async unresolved(
    _vault: string,
  ): Promise<readonly (AttemptRecord & { readonly eids: readonly string[] })[]> {
    return [];
  }
}

function serialQueue(): VaultCommandQueue {
  let tail = Promise.resolve();
  return {
    run(_vault, task) {
      const next = tail.then(task);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

function setup() {
  const store = openTestStore();
  const env = testEnv();
  const attempts = new Attempts<number>();
  let runs = 0;
  let writes = 0;
  let failWrite = false;
  let current = true;
  let attemptNumber = 0;
  const batches: UnstampedEvent[][] = [];
  const engine = {
    vault: store.vault,
    device: env.device,
    async write(events: readonly UnstampedEvent[]): Promise<WriteResult> {
      writes += 1;
      batches.push([...events]);
      if (failWrite) throw new Error("synthetic after-invocation fault");
      return { events: events.length, frames: 1, first: "", last: "" };
    },
  } as unknown as SyncEngine;
  const session: DurableCommandSession<number> = {
    vault: store.vault,
    device: env.device,
    store,
    engine,
    clock: env.clock,
    lease: env.lease,
    random: env.random,
    attempts,
    queue: serialQueue(),
    isCurrent: () => current,
    newAttemptId: () => `attempt-${++attemptNumber}`,
  };
  const cmd = defineCommand({
    id: "test.durableRule",
    input: z.object({ key: z.string().default("A") }),
    run(ctx, input) {
      runs += 1;
      ctx.emit("categoryRule.set", ctx.det("category_rules", [input.key]), {
        merchantKey: input.key,
        category: "groceries",
        source: "manual",
        locked: true,
      });
      return ok(runs);
    },
  });
  return {
    store,
    session,
    attempts,
    cmd,
    batches,
    get runs() {
      return runs;
    },
    get writes() {
      return writes;
    },
    setFailWrite(value: boolean) {
      failWrite = value;
    },
    setCurrent(value: boolean) {
      current = value;
    },
  };
}

describe("portable durable commands", () => {
  it("fingerprints canonical parsed input under an execution contract", () => {
    expect(commandFingerprint("vault", "cmd", { a: 1, b: { c: 2 } })).toBe(
      commandFingerprint("vault", "cmd", { b: { c: 2 }, a: 1 }),
    );
    expect(commandFingerprint("vault", "cmd", { a: 1 })).not.toBe(
      commandFingerprint("another", "cmd", { a: 1 }),
    );
    const fingerprint = (input: unknown) => commandFingerprint("vault", "cmd", input);
    expect(fingerprint({ amount: Decimal.parse("1.00") })).not.toBe(
      fingerprint({ amount: "1.00" }),
    );
    expect(fingerprint({ amount: Decimal.parse("1.00") })).not.toBe(
      fingerprint({ amount: Decimal.parse("1.0") }),
    );
    expect(fingerprint(new Uint8Array([1, 2]))).not.toBe(fingerprint([1, 2]));
    expect(fingerprint(new Date("2026-10-31T12:00:00.000Z"))).not.toBe(
      fingerprint("2026-10-31T12:00:00.000Z"),
    );
    expect(fingerprint(undefined)).not.toBe(fingerprint(null));
    expect(fingerprint(1n)).not.toBe(fingerprint(1));
    expect(() => fingerprint(new Map())).toThrow("unsupported command input object");
  });

  it("does not invoke the engine if pending metadata cannot be saved", async () => {
    const s = setup();
    s.attempts.failSave = true;
    expect(await executeDurableCommand(s.session, s.cmd, {}, "key-1")).toEqual({
      kind: "not_started",
      reason: "attempt_save_failed",
    });
    expect(s.runs).toBe(1);
    expect(s.writes).toBe(0);
    expect(s.attempts.rows.size).toBe(0);
  });

  it("retains original EIDs and never reruns an ambiguous same-key write", async () => {
    const s = setup();
    s.setFailWrite(true);
    const first = await executeDurableCommand(s.session, s.cmd, {}, "key-1");
    expect(first.kind).toBe("outcome_unknown");
    expect(s.writes).toBe(1);
    expect(s.batches[0]?.[0]?.i).toBe(
      first.kind === "outcome_unknown" ? first.eids?.[0] : undefined,
    );
    expect(s.batches[0]?.[0]).not.toHaveProperty("hlc");
    s.setFailWrite(false);
    expect(await executeDurableCommand(s.session, s.cmd, { key: "A" }, "key-1")).toEqual(first);
    expect(s.runs).toBe(1);
    expect(s.writes).toBe(1);
    expect(await executeDurableCommand(s.session, s.cmd, { key: "B" }, "key-1")).toEqual({
      kind: "refused",
      reason: "request_key_conflict",
    });
  });

  it("requires a completed receipt and keeps an expired key tombstone", async () => {
    const s = setup();
    const first = await executeDurableCommand(s.session, s.cmd, {}, "key-2");
    expect(first.kind).toBe("completed");
    expect(await executeDurableCommand(s.session, s.cmd, { key: "A" }, "key-2")).toEqual(first);
    expect(s.runs).toBe(1);
    const row = s.attempts.rows.get("key-2");
    if (row?.phase !== "completed") throw new Error("expected completed row");
    s.attempts.rows.set("key-2", { ...row, receipt: undefined });
    expect(await executeDurableCommand(s.session, s.cmd, {}, "key-2")).toEqual({
      kind: "outcome_unknown",
      key: "key-2",
      attemptId: row.attemptId,
      eids: row.eids,
    });
    expect(s.writes).toBe(1);
  });

  it("keeps a saved attempt unknown when session authority changes before invocation", async () => {
    const s = setup();
    s.attempts.onSave = () => s.setCurrent(false);
    const result = await executeDurableCommand(s.session, s.cmd, {}, "key-3");
    expect(result.kind).toBe("outcome_unknown");
    expect(s.writes).toBe(0);
    expect(s.attempts.rows.get("key-3")?.phase).toBe("may_append");
  });

  it("does not report success after a completed-receipt fault", async () => {
    const s = setup();
    s.attempts.failComplete = true;
    expect((await executeDurableCommand(s.session, s.cmd, {}, "key-4")).kind).toBe(
      "outcome_unknown",
    );
    expect(s.writes).toBe(1);
    expect(s.attempts.rows.get("key-4")?.phase).toBe("may_append");
  });

  it("preserves the key when lookup fails after a previous append", async () => {
    const s = setup();
    expect((await executeDurableCommand(s.session, s.cmd, {}, "key-5")).kind).toBe("completed");
    s.attempts.failLookup = true;
    expect(await executeDurableCommand(s.session, s.cmd, {}, "key-5")).toEqual({
      kind: "outcome_unknown",
      key: "key-5",
    });
    expect(s.runs).toBe(1);
    expect(s.writes).toBe(1);
  });

  it("keeps an unknown key if the queue rejects after invoking its callback", async () => {
    const s = setup();
    const session = {
      ...s.session,
      queue: {
        async run<T>(_vault: string, task: () => Promise<T>): Promise<T> {
          await task();
          throw new Error("synthetic queue reply fault");
        },
      },
    };
    expect(await executeDurableCommand(session, s.cmd, {}, "key-6")).toEqual({
      kind: "outcome_unknown",
      key: "key-6",
    });
    expect(s.writes).toBe(1);
    expect(s.attempts.rows.get("key-6")?.phase).toBe("completed");
  });

  it("settles unsupported typed input and attempt-id faults before writing", async () => {
    const s = setup();
    const opaque = defineCommand({
      id: "test.unsupportedInput",
      input: z.any(),
      run() {
        return ok(1);
      },
    });
    expect(await executeDurableCommand(s.session, opaque, new Map(), "key-7")).toEqual({
      kind: "refused",
      reason: "unsupported_input",
    });
    const session = {
      ...s.session,
      newAttemptId: () => {
        throw new Error("synthetic id fault");
      },
    };
    expect(await executeDurableCommand(session, s.cmd, {}, "key-8")).toEqual({
      kind: "not_started",
      reason: "attempt_id_failed",
    });
    expect(s.writes).toBe(0);
  });

  it("runs against the detached parsed input when a caller mutates during lookup", async () => {
    const s = setup();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.attempts.onLookup = async () => {
      entered();
      await waiting;
    };
    const input = {
      key: "A",
      amount: Decimal.parse("1.00"),
      bytes: new Uint8Array([1, 2]),
      date: new Date("2026-10-31T12:00:00.000Z"),
    };
    const originalFingerprint = commandFingerprint(s.store.vault, "test.mutableImport", input);
    let observed: unknown;
    const cmd = defineCommand({
      id: "test.mutableImport",
      input: z.custom<typeof input>(() => true),
      run(ctx, parsed) {
        observed = [
          parsed.key,
          parsed.amount.toString(),
          [...parsed.bytes],
          parsed.date.toISOString(),
        ];
        ctx.emit("categoryRule.set", ctx.det("category_rules", [parsed.key]), {
          merchantKey: parsed.key,
          category: "groceries",
          source: "manual",
          locked: true,
        });
        return ok(1);
      },
    });
    const result = executeDurableCommand(s.session, cmd, input, "key-9");
    await started;
    input.key = "B";
    input.amount = Decimal.parse("9.00");
    input.bytes[0] = 9;
    input.date.setUTCFullYear(2027);
    release();
    expect((await result).kind).toBe("completed");
    expect(observed).toEqual(["A", "1.00", [1, 2], "2026-10-31T12:00:00.000Z"]);
    expect(s.batches[0]?.[0]?.d).toMatchObject({ merchantKey: "A" });
    const row = s.attempts.rows.get("key-9");
    if (row === undefined || row.phase === "absent") throw new Error("expected recorded attempt");
    expect(row.fingerprint).toBe(originalFingerprint);
  });

  it("captures input before waiting for another task in the vault queue", async () => {
    const s = setup();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = s.session.queue.run(s.store.vault, async () => {
      entered();
      await waiting;
    });
    await started;
    const input = { key: "A" };
    const fingerprint = commandFingerprint(s.store.vault, "test.queuedInput", input);
    const cmd = defineCommand({
      id: "test.queuedInput",
      input: z.custom<typeof input>(() => true),
      run(ctx, parsed) {
        ctx.emit("categoryRule.set", ctx.det("category_rules", [parsed.key]), {
          merchantKey: parsed.key,
          category: "groceries",
          source: "manual",
          locked: true,
        });
        return ok(1);
      },
    });
    const result = executeDurableCommand(s.session, cmd, input, "key-10");
    input.key = "B";
    release();
    await blocker;
    expect((await result).kind).toBe("completed");
    expect(s.batches[0]?.[0]?.d).toMatchObject({ merchantKey: "A" });
    const row = s.attempts.rows.get("key-10");
    if (row === undefined || row.phase === "absent") throw new Error("expected recorded attempt");
    expect(row.fingerprint).toBe(fingerprint);
  });
});
