import { renameProfile } from "@cashu/store";
import { setCurrentVault } from "@cashu/store/device";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import { ALWAYS_ONLINE } from "../client/connection.js";
import type { CommandAttempt, StoreClient } from "../client/types.js";
import { ProfileContext } from "./context.js";
import { StoreProvider } from "./StoreProvider.js";
import { useCommand } from "./useCommand.js";

afterEach(cleanup);

it("settles rejection after a possible effect unknown with the original attempt key", async () => {
  let effectCount = 0;
  let dispatched: CommandAttempt | undefined;
  const client = {
    async: false,
    connection: ALWAYS_ONLINE,
    vaults: [],
    async run(_target: unknown, _command: unknown, _input: unknown, attempt: CommandAttempt) {
      dispatched = attempt;
      effectCount += 1;
      throw new Error("synthetic lost confirmation");
    },
    async reconcile(attempt: CommandAttempt) {
      return { kind: "outcome_unknown", key: attempt.key, attempt };
    },
  } as unknown as StoreClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StoreProvider client={client}>{children}</StoreProvider>
  );
  const hook = renderHook(() => useCommand(setCurrentVault), { wrapper });
  let outcome: Awaited<ReturnType<typeof hook.result.current.run>> | undefined;
  await act(async () => {
    const first = hook.result.current.run({ vault: null });
    expect(await hook.result.current.run({ vault: null })).toEqual({
      kind: "not_started",
      reason: "pending_previous_attempt",
    });
    outcome = await first;
  });
  expect(outcome?.kind).toBe("outcome_unknown");
  if (outcome?.kind !== "outcome_unknown") throw new Error("missing unknown result");
  expect(outcome.key).toBe(dispatched?.key);
  expect(effectCount).toBe(1);
  expect(await hook.result.current.run({ vault: null })).toEqual({
    kind: "not_started",
    reason: "pending_previous_attempt",
  });
  expect(effectCount).toBe(1);
});

it("scopes unresolved keys by vault across a mounted profile switch", async () => {
  const firstVault = "a".repeat(32);
  const secondVault = "b".repeat(32);
  let selected = firstVault;
  const dispatched: CommandAttempt[] = [];
  const client = {
    async: false,
    connection: ALWAYS_ONLINE,
    vaults: [firstVault, secondVault],
    async run(_target: unknown, _command: unknown, _input: unknown, attempt: CommandAttempt) {
      dispatched.push(attempt);
      return attempt.target.kind === "vault" && attempt.target.vault === firstVault
        ? { kind: "outcome_unknown", key: attempt.key, attempt }
        : { kind: "completed", value: null };
    },
  } as unknown as StoreClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StoreProvider client={client}>
      <ProfileContext value={selected}>{children}</ProfileContext>
    </StoreProvider>
  );
  const hook = renderHook(() => useCommand(renameProfile), { wrapper });
  let original: Awaited<ReturnType<typeof hook.result.current.run>> | undefined;
  await act(async () => {
    original = await hook.result.current.run({ name: "First" });
  });
  if (original?.kind !== "outcome_unknown") throw new Error("missing first-vault attempt");
  selected = secondVault;
  hook.rerender();
  await act(async () => {
    expect(await hook.result.current.run({ name: "Second" })).toEqual({
      kind: "completed",
      value: null,
    });
  });
  expect(dispatched).toHaveLength(2);
  selected = firstVault;
  hook.rerender();
  expect(await hook.result.current.run({ name: "Blind repeat" })).toEqual({
    kind: "not_started",
    reason: "pending_previous_attempt",
  });
  expect(dispatched).toHaveLength(2);
});
