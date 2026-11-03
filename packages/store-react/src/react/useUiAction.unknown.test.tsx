import type { UiAction } from "@cashu/store/ui-actions";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import { ALWAYS_ONLINE } from "../client/connection.js";
import type { StoreClient } from "../client/types.js";
import { ProfileContext } from "./context.js";
import { StoreProvider } from "./StoreProvider.js";
import { useUiAction } from "./useUiAction.js";

afterEach(cleanup);

it("blocks a different action input after an unresolved delivery", async () => {
  const vault = "a".repeat(32);
  const action: UiAction<{ value: number }, number> = { id: "synthetic.action" };
  let calls = 0;
  const client = {
    async: false,
    connection: ALWAYS_ONLINE,
    vaults: [vault],
    async invoke() {
      calls++;
      return {
        status: "outcome_unknown",
        reason: "interrupted",
        attempt: { key: "00000000000000000000000000", command: "synthetic.command" },
      };
    },
  } as unknown as StoreClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StoreProvider client={client}>
      <ProfileContext value={vault}>{children}</ProfileContext>
    </StoreProvider>
  );
  const hook = renderHook(() => useUiAction(action), { wrapper });
  await act(async () => {
    expect(await hook.result.current.run({ value: 1 })).toMatchObject({
      status: "outcome_unknown",
      attempt: { command: "synthetic.command" },
    });
  });
  expect(await hook.result.current.run({ value: 2 })).toEqual({
    status: "not_started",
    reason: "pending_previous_attempt",
  });
  expect(calls).toBe(1);
});

it("keeps uncertainty on its vault across a mounted selection switch", async () => {
  const first = "a".repeat(32);
  const second = "b".repeat(32);
  let selected = first;
  const action: UiAction<{ value: number }, number> = { id: "synthetic.action" };
  const seen: string[] = [];
  const client = {
    async: false,
    connection: ALWAYS_ONLINE,
    vaults: [first, second],
    async invoke(target: { vault: string }) {
      seen.push(target.vault);
      return target.vault === first
        ? { status: "outcome_unknown", reason: "interrupted" }
        : { status: "completed", value: 2 };
    },
  } as unknown as StoreClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StoreProvider client={client}>
      <ProfileContext value={selected}>{children}</ProfileContext>
    </StoreProvider>
  );
  const hook = renderHook(() => useUiAction(action), { wrapper });
  await act(async () => {
    expect((await hook.result.current.run({ value: 1 })).status).toBe("outcome_unknown");
  });
  selected = second;
  hook.rerender();
  await act(async () => {
    expect(await hook.result.current.run({ value: 2 })).toEqual({ status: "completed", value: 2 });
  });
  selected = first;
  hook.rerender();
  expect(await hook.result.current.run({ value: 3 })).toEqual({
    status: "not_started",
    reason: "pending_previous_attempt",
  });
  expect(seen).toEqual([first, second]);
});
