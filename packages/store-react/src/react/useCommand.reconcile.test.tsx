// After an `outcome_unknown` the next run of the same command reconciles the earlier attempt first (S22): a
// completed attempt is reported without a second write, a refused or never-started one lets the new input
// run, one still unknown keeps the scope blocked; both handle kinds of the sync client (durable and plain).
// Real in-memory stores, synthetic data only.
import { renameProfile } from "@cashu/store";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import type {
  DurableOutcome,
  DurableVaultHandle,
  LocalStores,
  VaultHandle,
} from "../local/stores.js";
import { createSyncClient } from "../local/sync.js";
import { profileName } from "../testing/fixtures.js";
import { memoryStores, VAULT_A, VAULT_B } from "../testing/memory.js";
import { ProfileContext } from "./context.js";
import { StoreProvider } from "./StoreProvider.js";
import { PREVIOUS_ATTEMPT_COMPLETED, useCommand, VAULT_UNAVAILABLE } from "./useCommand.js";
import { useQuery } from "./useQuery.js";

const closers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
});

interface Scripted {
  /** Answers of `execute`, in order; when empty the call is a test failure. */
  readonly executes: DurableOutcome[];
  /** Answers of `reconcile`, in order. */
  readonly reconciles: DurableOutcome[];
  readonly calls: {
    readonly op: "execute" | "reconcile";
    readonly key: string;
    readonly input?: unknown;
  }[];
}

function durableSetup() {
  const memory = memoryStores();
  const script: Scripted = { executes: [], reconciles: [], calls: [] };
  const plain = memory.vaults.get(VAULT_A) as VaultHandle;
  const durable: DurableVaultHandle = {
    store: plain.store,
    async execute(_command, input, key) {
      script.calls.push({ op: "execute", key, input });
      const next = script.executes.shift();
      if (next === undefined) throw new Error("unexpected execute");
      return next;
    },
    async reconcile(key) {
      script.calls.push({ op: "reconcile", key });
      const next = script.reconciles.shift();
      if (next === undefined) throw new Error("unexpected reconcile");
      return next;
    },
  };
  const stores: LocalStores = {
    device: memory.device,
    vaults: new Map<string, VaultHandle | DurableVaultHandle>([
      [VAULT_A, durable],
      [VAULT_B, memory.vaults.get(VAULT_B) as VaultHandle],
    ]),
  };
  const client = createSyncClient(stores, { lingerMs: 0 });
  closers.push(() => {
    client.dispose();
    memory.close();
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StoreProvider client={client}>
      <ProfileContext value={VAULT_A}>{children}</ProfileContext>
    </StoreProvider>
  );
  const hook = renderHook(() => useCommand(renameProfile), { wrapper });
  const run = async (name: string) => {
    let outcome: Awaited<ReturnType<typeof hook.result.current.run>> | undefined;
    await act(async () => {
      outcome = await hook.result.current.run({ name });
    });
    return outcome;
  };
  return { script, hook, run };
}

it("durable: a previous attempt that completed is reported and nothing is written twice", async () => {
  const { script, run } = durableSetup();
  script.executes.push({ kind: "outcome_unknown", attemptId: "a1" });
  const first = await run("Ela");
  expect(first?.kind).toBe("outcome_unknown");
  const firstKey = script.calls[0]?.key;

  script.reconciles.push({ kind: "completed", value: null });
  expect(await run("Ela")).toEqual({ kind: "completed", value: null });
  expect(script.calls).toEqual([
    { op: "execute", key: firstKey, input: { name: "Ela" } },
    { op: "reconcile", key: firstKey },
  ]);

  // The scope is clear again: the next tap runs a new attempt with a new key.
  script.executes.push({ kind: "completed", value: null });
  expect(await run("Ula")).toEqual({ kind: "completed", value: null });
  expect(script.calls[2]).toMatchObject({ op: "execute", input: { name: "Ula" } });
  expect(script.calls[2]?.key).not.toBe(firstKey);
});

it("durable: a previous attempt that never started lets the new input run at once", async () => {
  const { script, run } = durableSetup();
  script.executes.push({ kind: "outcome_unknown" });
  await run("Ela");
  const firstKey = script.calls[0]?.key;

  script.reconciles.push({ kind: "not_started", reason: "no_journal_entry" });
  script.executes.push({ kind: "completed", value: null });
  expect(await run("Ela")).toEqual({ kind: "completed", value: null });
  expect(script.calls.map((call) => call.op)).toEqual(["execute", "reconcile", "execute"]);
  expect(script.calls[1]?.key).toBe(firstKey);
  expect(script.calls[2]?.key).not.toBe(firstKey);
});

it("durable: a still unknown attempt blocks, a later tap reconciles again and proceeds", async () => {
  const { script, run } = durableSetup();
  script.executes.push({ kind: "outcome_unknown" });
  await run("Ela");
  const firstKey = script.calls[0]?.key;

  script.reconciles.push({ kind: "outcome_unknown" });
  expect(await run("Ela")).toEqual({ kind: "not_started", reason: "pending_previous_attempt" });

  script.reconciles.push({ kind: "refused", reason: "request_key_conflict" });
  script.executes.push({ kind: "completed", value: null });
  expect(await run("Ela")).toEqual({ kind: "completed", value: null });
  expect(script.calls.map((call) => [call.op, call.key === firstKey])).toEqual([
    ["execute", true],
    ["reconcile", true],
    ["reconcile", true],
    ["execute", false],
  ]);
});

it("durable: a double tap while the reconcile runs starts nothing", async () => {
  const { script, hook } = durableSetup();
  script.executes.push({ kind: "outcome_unknown" });
  await act(async () => {
    await hook.result.current.run({ name: "Ela" });
  });
  script.reconciles.push({ kind: "not_started", reason: "no_journal_entry" });
  script.executes.push({ kind: "completed", value: null });
  await act(async () => {
    const first = hook.result.current.run({ name: "Ela" });
    expect(await hook.result.current.run({ name: "Ela" })).toEqual({
      kind: "not_started",
      reason: "pending_previous_attempt",
    });
    expect(await first).toEqual({ kind: "completed", value: null });
  });
  expect(script.calls.map((call) => call.op)).toEqual(["execute", "reconcile", "execute"]);
});

it("plain: an attempt the in-process store cannot answer for stays blocked and is never written twice", async () => {
  const memory = memoryStores();
  const plain = memory.vaults.get(VAULT_A) as VaultHandle;
  let appends = 0;
  let failNext = true;
  const flaky: VaultHandle = {
    ...plain,
    writer: {
      append(envelopes) {
        appends += 1;
        if (failNext) {
          failNext = false;
          throw new Error("synthetic write failure");
        }
        plain.writer.append(envelopes);
      },
    },
  };
  const stores: LocalStores = {
    device: memory.device,
    vaults: new Map<string, VaultHandle | DurableVaultHandle>([[VAULT_A, flaky]]),
  };
  const client = createSyncClient(stores, { lingerMs: 0 });
  closers.push(() => {
    client.dispose();
    memory.close();
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StoreProvider client={client}>
      <ProfileContext value={VAULT_A}>{children}</ProfileContext>
    </StoreProvider>
  );
  const hook = renderHook(
    () => ({ run: useCommand(renameProfile).run, name: useQuery(profileName) }),
    {
      wrapper,
    },
  );
  await act(async () => {
    expect((await hook.result.current.run({ name: "Ela" })).kind).toBe("outcome_unknown");
  });
  await act(async () => {
    expect(await hook.result.current.run({ name: "Ela" })).toEqual({
      kind: "not_started",
      reason: "pending_previous_attempt",
    });
  });
  expect(appends).toBe(1);
  expect(hook.result.current.name).toBe("Ala");
});

it("durable: a corrected input after an unknown attempt that completed is not reported as saved nor written", async () => {
  const { script, run } = durableSetup();
  script.executes.push({ kind: "outcome_unknown" });
  await run("Ela");
  const firstKey = script.calls[0]?.key;

  // The owner corrected the input after "Could not save"; the earlier attempt had gone through.
  script.reconciles.push({ kind: "completed", value: null });
  expect(await run("Ula")).toEqual({ kind: "not_started", reason: PREVIOUS_ATTEMPT_COMPLETED });
  expect(script.calls).toEqual([
    { op: "execute", key: firstKey, input: { name: "Ela" } },
    { op: "reconcile", key: firstKey },
  ]);

  // The scope is clear: saving the correction again writes it once, under a new key.
  script.executes.push({ kind: "completed", value: null });
  expect(await run("Ula")).toEqual({ kind: "completed", value: null });
  expect(script.calls[2]).toMatchObject({ op: "execute", input: { name: "Ula" } });
  expect(script.calls[2]?.key).not.toBe(firstKey);
  expect(script.calls).toHaveLength(3);
});

it("durable: a corrected input after an unknown attempt that never started runs the correction", async () => {
  const { script, run } = durableSetup();
  script.executes.push({ kind: "outcome_unknown" });
  await run("Ela");
  script.reconciles.push({ kind: "not_started", reason: "no_journal_entry" });
  script.executes.push({ kind: "completed", value: null });
  expect(await run("Ula")).toEqual({ kind: "completed", value: null });
  expect(script.calls[2]).toMatchObject({ op: "execute", input: { name: "Ula" } });
});

function pinnedSetup(pin: string) {
  const memory = memoryStores();
  const client = createSyncClient(
    { device: memory.device, vaults: memory.vaults },
    { lingerMs: 0 },
  );
  closers.push(() => {
    client.dispose();
    memory.close();
  });
  // The current profile is A; the handle is pinned to `pin`.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StoreProvider client={client}>
      <ProfileContext value={VAULT_A}>{children}</ProfileContext>
    </StoreProvider>
  );
  const names = (vault: string) =>
    renderHook(() => useQuery(profileName), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StoreProvider client={client}>
          <ProfileContext value={vault}>{children}</ProfileContext>
        </StoreProvider>
      ),
    }).result;
  const hook = renderHook(() => useCommand(renameProfile, { vault: pin }), { wrapper });
  return { hook, names };
}

it("a handle pinned to a vault writes to that vault, never to the current profile", async () => {
  const { hook, names } = pinnedSetup(VAULT_B);
  await act(async () => {
    expect(await hook.result.current.run({ name: "Iza" })).toMatchObject({ kind: "completed" });
  });
  expect(names(VAULT_B).current).toBe("Iza");
  expect(names(VAULT_A).current).toBe("Ala");
});

it("a handle pinned to a vault that is not open refuses quietly and writes nothing", async () => {
  const { hook, names } = pinnedSetup("c3000000000000000000000000000003");
  await act(async () => {
    expect(await hook.result.current.run({ name: "Iza" })).toEqual({
      kind: "not_started",
      reason: VAULT_UNAVAILABLE,
    });
  });
  expect(names(VAULT_A).current).toBe("Ala");
  expect(names(VAULT_B).current).toBe("Ola");
});
