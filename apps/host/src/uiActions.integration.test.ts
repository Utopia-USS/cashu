import type { StoreToClient } from "@cashu/host-protocol/store";
import { mintUlid, renameProfile, runCommand, setModules } from "@cashu/store";
import type { Read } from "@cashu/store/query";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { startLocalHost } from "./host.js";
import { cleanup, storeClient, tempDir, testHostOptions } from "./testing/harness.js";
import { defineUiAction, type UiActionRegistration } from "./uiActions.js";

afterEach(cleanup);

it("expires a beforeExecute read and retains the last key if the action throws after append", async () => {
  const dir = tempDir();
  const key = mintUlid(42);
  let escapedRead: Read | undefined;
  let executions = 0;
  const action = defineUiAction({
    id: "test.throwAfterAppend",
    module: "budget",
    input: z.strictObject({ name: z.string() }),
    commands: [renameProfile],
    bind: () => ({ generation: "test", capabilities: {}, isCurrent: () => true }),
    beforeExecute(read) {
      escapedRead = read;
      return true;
    },
    async run(context, input) {
      executions++;
      const result = await context.execute({
        command: renameProfile.id,
        input: { name: input.name },
        key,
      });
      expect(result.kind).toBe("completed");
      throw new Error("synthetic failure after append");
    },
  });
  const host = await startLocalHost({ ...testHostOptions(dir) });
  const vault = [...host.stores.vaults.values()][0];
  if (!vault) throw new Error("missing synthetic vault");
  try {
    await vault.queue.run(() =>
      runCommand(vault.store, vault.writer, setModules, { moduleIds: ["budget"] }, vault.env),
    );
    const first = await action.run(host.stores, vault.id, { name: "Synthetic changed" });
    expect(first).toMatchObject({
      status: "outcome_unknown",
      attempt: { key, command: renameProfile.id },
    });
    expect(() => escapedRead?.("SELECT name FROM profiles")).toThrow("expired_action_read");
    expect(await action.run(host.stores, vault.id, { name: "Synthetic changed" })).toEqual(first);
    expect(await action.run(host.stores, vault.id, { name: "Different" })).toEqual({
      status: "not_started",
      reason: "pending_previous_attempt",
    });
    expect(executions).toBe(1);
    expect(vault.store.read<{ name: string }>("SELECT name FROM profiles")).toEqual([
      { name: "Synthetic changed" },
    ]);
  } finally {
    await host.stop();
  }
});

it("retains an uncertain action only for its original parsed input", async () => {
  let dispatched = 0;
  const action = defineUiAction({
    id: "test.uncertain",
    module: "budget",
    input: z.strictObject({ value: z.number() }),
    bind: () => ({ generation: "test", capabilities: {}, isCurrent: () => true }),
    async run() {
      dispatched++;
      return {
        status: "outcome_unknown" as const,
        reason: "interrupted" as const,
        attempt: { key: mintUlid(1), command: "synthetic.command" },
      };
    },
  });
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    uiActions: [action],
  });
  const vault = [...host.stores.vaults.values()][0];
  if (!vault) throw new Error("missing synthetic vault");
  try {
    await vault.queue.run(() =>
      runCommand(vault.store, vault.writer, setModules, { moduleIds: ["budget"] }, vault.env),
    );
    const first = await action.run(host.stores, vault.id, { value: 1 });
    expect(await action.run(host.stores, vault.id, { value: 1 })).toEqual(first);
    expect(await action.run(host.stores, vault.id, { value: 2 })).toEqual({
      status: "not_started",
      reason: "pending_previous_attempt",
    });
    expect(dispatched).toBe(1);
  } finally {
    await host.stop();
  }
});
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("snapshots command identity before queueing and rejects stale privacy after awaited preparation", async () => {
  let wait = deferred();
  let started = false;
  let guarded = false;
  const action = defineUiAction({
    id: "test.prepared",
    module: "budget",
    input: z.strictObject({}),
    commands: [renameProfile],
    bind: () => ({ generation: "test", capabilities: {}, isCurrent: () => true }),
    beforeExecute(_read, prepared) {
      guarded =
        prepared.command === renameProfile.id &&
        (prepared.input as { name: string }).name === "Prepared";
      return guarded;
    },
    async run(context) {
      started = true;
      await wait.promise;
      const intent = { command: renameProfile.id, input: { name: "Prepared" }, key: mintUlid(1) };
      const result = context.execute(intent);
      intent.command = "unregistered";
      intent.input.name = "Mutated";
      return { status: "completed", value: await result };
    },
  });
  const dir = tempDir();
  const throwing: UiActionRegistration = {
    id: "test.throw",
    run() {
      throw new Error("private internal text");
    },
  };
  const host = await startLocalHost({
    ...testHostOptions(dir),
    uiActions: [action, throwing],
  });
  const client = await storeClient(dir);
  const replies: StoreToClient[] = [];
  client.conn.onFrame((frame) => {
    if (frame.t === "store") replies.push(frame.m as StoreToClient);
  });
  const vault = client.vaults[0];
  if (vault === undefined) throw new Error("missing test vault");
  const send = (m: unknown) => client.conn.send({ t: "store", m } as never);
  let nextRun = 500;
  const runName = async (name: string) => {
    const rid = nextRun++;
    send({
      t: "run",
      rid,
      generation: 0,
      key: mintUlid(rid),
      target: { kind: "vault", vault },
      command: renameProfile.id,
      input: { name },
    });
    await expect
      .poll(() => replies.find((message) => message.t === "result" && message.rid === rid))
      .toBeDefined();
  };
  try {
    const target = host.stores.vaults.get(vault);
    if (target === undefined) throw new Error("missing target");
    await target.queue.run(() =>
      runCommand(target.store, target.writer, setModules, { moduleIds: ["budget"] }, target.env),
    );
    send({ t: "uiPolicy", generation: 0, privacy: false });
    send({ t: "action", rid: 100, target: { kind: "vault", vault }, action: action.id, input: {} });
    await expect.poll(() => started).toBe(true);
    // Another actual queued command completes while the action's capability I/O waits.
    await runName("Independent");
    wait.resolve();
    await expect
      .poll(() => replies.some((m) => m.t === "actionResult" && m.rid === 100))
      .toBe(true);
    expect(guarded).toBe(true);
    expect(
      host.stores.vaults.get(vault)?.store.read<{ name: string }>("SELECT name FROM profiles")[0]
        ?.name,
    ).toBe("Prepared");
    wait = deferred();
    started = false;
    send({ t: "action", rid: 101, target: { kind: "vault", vault }, action: action.id, input: {} });
    await expect.poll(() => started).toBe(true);
    send({ t: "uiPolicy", generation: 1, privacy: true });
    await runName("After privacy");
    wait.resolve();
    await expect
      .poll(() => replies.find((m) => m.t === "actionResult" && m.rid === 101))
      .toMatchObject({ result: { status: "outcome_unknown" } });
    send({ t: "uiPolicy", generation: 2, privacy: false });
    send({
      t: "action",
      rid: 102,
      target: { kind: "vault", vault },
      action: throwing.id,
      input: {},
    });
    await expect
      .poll(() => replies.find((m) => m.t === "actionResult" && m.rid === 102))
      .toMatchObject({ result: { status: "outcome_unknown", reason: "unexpected_failure" } });
    const late = deferred();
    const rejectedRead = defineUiAction({
      id: "test.accidentalAsync",
      module: "budget",
      input: z.strictObject({}),
      bind: () => ({ generation: "test", capabilities: {}, isCurrent: () => true }),
      async run(context) {
        await expect(
          context.readStep(async (read) => {
            await late.promise;
            return read("SELECT name FROM profiles");
          }),
        ).rejects.toThrow("async_action_read");
        late.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        return { status: "completed", value: null };
      },
    });
    expect(await rejectedRead.run(host.stores, vault, {})).toEqual({
      status: "completed",
      value: null,
    });
  } finally {
    client.close();
    await host.stop();
  }
});

it("bounds outstanding hydration including replaced subscriptions and catches sync preparation failure", async () => {
  const gate = deferred();
  let calls = 0;
  const dir = tempDir();
  const host = await startLocalHost({
    ...testHostOptions(dir),
    maxInFlight: 1,
    prepareUiQuery: () => {
      calls++;
      if (calls === 2) throw new Error("private internal text");
      return gate.promise;
    },
  });
  const client = await storeClient(dir);
  const replies: StoreToClient[] = [];
  client.conn.onFrame((frame) => {
    if (frame.t === "store") replies.push(frame.m as StoreToClient);
  });
  const vault = client.vaults[0];
  const send = (m: unknown) => client.conn.send({ t: "store", m } as never);
  try {
    const subscription = {
      t: "sub",
      sid: 300,
      generation: 0,
      resume: false,
      target: { kind: "vault", vault },
      query: "core.profileIdentity",
      args: null,
    };
    send({ ...subscription, target: { kind: "vault", vault: "f".repeat(32) } });
    await expect.poll(() => replies.length).toBe(1);
    expect(calls).toBe(0);
    send(subscription);
    await expect.poll(() => calls).toBe(1);
    send(subscription);
    await expect
      .poll(() => replies.some((m) => m.t === "error" && m.error.name === "Busy"))
      .toBe(true);
    expect(calls).toBe(1);
    gate.resolve();
    await host.stores.vaults.values().next().value?.queue.idle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    send({ ...subscription, sid: 301 });
    await expect
      .poll(() => replies.find((m) => m.t === "error" && m.sid === 301))
      .toMatchObject({
        error: { name: "QueryPreparationFailed", message: "query preparation failed" },
      });
  } finally {
    client.close();
    await host.stop();
  }
});

it("parks resumed private reads while public and pending reads recover across policy generations", async () => {
  const gate = deferred();
  const dir = tempDir();
  const host = await startLocalHost({
    ...testHostOptions(dir),
    privateUiQuery: (_query, args) => (args as { private?: boolean } | null)?.private === true,
    prepareUiQuery: (_vault, _query, args) =>
      (args as { pending?: boolean } | null)?.pending === true ? gate.promise : Promise.resolve(),
  });
  const client = await storeClient(dir);
  const replies: StoreToClient[] = [];
  client.conn.onFrame((frame) => {
    if (frame.t === "store") replies.push(frame.m as StoreToClient);
  });
  const vault = client.vaults[0];
  if (vault === undefined) throw new Error("missing test vault");
  const send = (m: unknown) => client.conn.send({ t: "store", m } as never);
  const sub = (sid: number, generation: number, args: unknown, resume: boolean) =>
    send({
      t: "sub",
      sid,
      generation,
      resume,
      target: { kind: "vault", vault },
      query: "core.profileIdentity",
      args,
    });
  try {
    sub(400, 0, { private: true }, false);
    sub(401, 0, { pending: true }, false);
    await expect.poll(() => replies.some((m) => m.t === "value" && m.sid === 400)).toBe(true);
    send({ t: "uiPolicy", generation: 1, privacy: true });
    sub(400, 1, { private: true }, true);
    sub(401, 1, { pending: true }, true);
    sub(402, 1, { private: true }, false);
    await expect.poll(() => replies.some((m) => m.t === "error" && m.sid === 402)).toBe(true);
    expect(replies.find((m) => m.t === "error" && m.sid === 402)).toMatchObject({
      generation: 1,
      error: { name: "PrivacyRestricted" },
    });
    gate.resolve();
    await expect
      .poll(() => replies.some((m) => m.t === "value" && m.sid === 401 && m.generation === 1))
      .toBe(true);
    expect(replies.some((m) => m.t === "value" && m.sid === 400 && m.generation === 1)).toBe(false);
    const beforeMutation = replies.filter(
      (m) => m.t === "value" && m.sid === 401 && m.generation === 1,
    ).length;
    send({
      t: "run",
      rid: 500,
      generation: 1,
      key: mintUlid(500),
      target: { kind: "vault", vault },
      command: renameProfile.id,
      input: { name: "Public during privacy" },
    });
    await expect.poll(() => replies.some((m) => m.t === "result" && m.rid === 500)).toBe(true);
    expect(replies.find((m) => m.t === "result" && m.rid === 500)).toMatchObject({
      outcome: { kind: "not_started", reason: "policy_unavailable" },
    });
    expect(
      replies.filter((m) => m.t === "value" && m.sid === 401 && m.generation === 1),
    ).toHaveLength(beforeMutation);
    send({ t: "uiPolicy", generation: 2, privacy: false });
    sub(400, 2, { private: true }, true);
    await expect
      .poll(() => replies.some((m) => m.t === "value" && m.sid === 400 && m.generation === 2))
      .toBe(true);
  } finally {
    client.close();
    await host.stop();
  }
});
