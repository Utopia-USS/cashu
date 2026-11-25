// @vitest-environment jsdom

import type { CommandAttempt, CommandOutcome } from "@cashu/store-react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commandFailure, useDurableCommands } from "./useDurableCommand.js";

const attempt: CommandAttempt = {
  key: "synthetic-attempt",
  target: { kind: "vault", vault: "synthetic-vault" },
  command: "synthetic.save",
};
const unknown: CommandOutcome<null> = {
  kind: "outcome_unknown",
  key: attempt.key,
  attempt,
};
function command() {
  return {
    run: vi.fn(async (_input: unknown): Promise<CommandOutcome<null>> => unknown),
    reconcile: vi.fn(
      async (_attempt: CommandAttempt): Promise<CommandOutcome<null>> => ({
        kind: "completed",
        value: null,
      }),
    ),
  };
}

function DurableProbe({
  onReady,
}: {
  onReady: (api: ReturnType<typeof useDurableCommands>) => void;
}) {
  onReady(useDurableCommands());
  return null;
}

/** A one-field draft saved through the durable helper, like the drawers' forms. */
function DraftForm({ handle }: { handle: ReturnType<typeof command> }) {
  const durable = useDurableCommands();
  const [open, setOpen] = useState(true);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const save = async () => {
    const result = await durable.run("draft", handle, { value: draft });
    if (result.kind === "completed") setOpen(false);
    else setNotice(commandFailure(result));
  };
  return (
    <div>
      <output data-testid="draft">{`${open}:${draft}:${notice}`}</output>
      <button type="button" onClick={() => setDraft("100")}>
        First value
      </button>
      <button type="button" onClick={() => setDraft("200")}>
        Changed value
      </button>
      <button type="button" onClick={() => void save()}>
        Save
      </button>
    </div>
  );
}

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

it("does not bind a second same-row input to the first in-flight result", async () => {
  let durable: ReturnType<typeof useDurableCommands> | undefined;
  let settle: ((outcome: CommandOutcome<null>) => void) | undefined;
  const handle = {
    run: vi.fn(
      () =>
        new Promise<CommandOutcome<null>>((resolve) => {
          settle = resolve;
        }),
    ),
    reconcile: vi.fn(async () => ({ kind: "completed", value: null }) as const),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <DurableProbe
          onReady={(api) => {
            durable = api;
          }}
        />,
      ),
    );
    if (durable === undefined) throw new Error("missing durable helper");
    const first = durable.run("row", handle, { name: "First" });
    expect(await durable.run("row", handle, { name: "Changed" })).toEqual({
      kind: "not_started",
      reason: "pending_previous_attempt",
    });
    expect(handle.run).toHaveBeenCalledTimes(1);
    await act(async () => settle?.({ kind: "completed", value: null }));
    expect(await first).toEqual({ kind: "completed", value: null });
    expect(handle.run).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("a form reconciles the original attempt and preserves a changed draft", async () => {
  const handle = command();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const click = async (text: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    );
    if (!button) throw new Error(`Missing ${text}`);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(<DraftForm handle={handle} />));
    await click("First value");
    await click("Save");
    expect(handle.run).toHaveBeenCalledTimes(1);
    expect(container.querySelector("output")?.textContent).toContain("true:");
    await click("Changed value");
    await click("Save");
    expect(handle.reconcile).toHaveBeenCalledExactlyOnceWith(attempt);
    expect(handle.run).toHaveBeenCalledTimes(1);
    expect(container.querySelector("output")?.textContent).toContain("true:");
    expect(container.querySelector("output")?.textContent).toContain("200");
    await click("Save");
    expect(handle.run).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("an unchanged draft completes after same-key reconciliation", async () => {
  const handle = command();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DraftForm handle={handle} />));
    const buttons = [...container.querySelectorAll("button")];
    await act(async () => buttons[0]?.click());
    await act(async () => buttons[2]?.click());
    await act(async () => buttons[2]?.click());
    expect(handle.run).toHaveBeenCalledTimes(1);
    expect(handle.reconcile).toHaveBeenCalledTimes(1);
    expect(container.querySelector("output")?.textContent).toContain("false:100:");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
