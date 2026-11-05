// @vitest-environment jsdom

import type { NativeCreationPrepareResult } from "@cashu/host-protocol";
import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CreationBridge } from "../../creationBridge.js";
import { CreationScreen } from "./CreationScreen.js";
import type { CreationWorkspacePort } from "./workspacePort.js";

const operationId = "1".repeat(32);
const phraseSession = "2".repeat(32);
const words = Array.from({ length: 24 }, (_, index) => `synthetic${index + 1}`).join(" ");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLanguageForTests("en");
});

it("discards a delayed phrase from a replaced bridge lifetime", async () => {
  let finishPrepare: (value: NativeCreationPrepareResult) => void = () => {};
  const oldBridge: CreationBridge = {
    current: async () => ({ kind: "none" }),
    prepare: () =>
      new Promise((resolve) => {
        finishPrepare = resolve;
      }),
    commit: async () => ({ kind: "refused", code: "prepare_missing" }),
    inspect: async ({ operationId: id }) => ({ kind: "not_found", operationId: id }),
  };
  const newBridge: CreationBridge = {
    ...oldBridge,
    current: async () => ({ kind: "none" }),
    prepare: async () => ({ kind: "refused", code: "setup_unavailable" }),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const view = (bridge: CreationBridge) => (
    <CreationScreen mode="first" bridge={bridge} onReady={async () => false} />
  );
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  try {
    await act(async () => root.render(view(oldBridge)));
    const name = container.querySelector('input[name="profileName"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        name,
        "Synthetic Home",
      );
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Next")?.click());
    await act(async () => button("Next")?.click());
    const radios = [
      ...container.querySelectorAll('input[name="mcpPrivacy"]'),
    ] as HTMLInputElement[];
    await act(async () => radios[0]?.click());
    await act(async () => button("Next")?.click());
    await act(async () => root.render(view(newBridge)));
    await act(async () =>
      finishPrepare({
        kind: "prepared",
        operationId,
        phraseSession,
        words,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    );
    expect(container.textContent).not.toContain(words);
    expect(container.querySelector('input[name="profileName"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recovery-phrase"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
afterEach(() => vi.unstubAllGlobals());

it("prepares once, clears the phrase before commit, and reconciles unknown without replay", async () => {
  const prepare = vi.fn(async () => ({
    kind: "prepared" as const,
    operationId,
    phraseSession,
    words,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  }));
  const commit = vi.fn(async () => ({
    kind: "outcome_unknown" as const,
    operationId,
    stage: "history" as const,
  }));
  const inspect = vi.fn(async () => ({
    kind: "pending" as const,
    operationId,
    stage: "history" as const,
  }));
  const current = vi.fn(async () => ({ kind: "none" as const }));
  const bridge: CreationBridge = { prepare, commit, inspect, current };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  try {
    await act(async () =>
      root.render(<CreationScreen mode="first" bridge={bridge} onReady={async () => false} />),
    );
    const name = container.querySelector('input[name="profileName"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        name,
        "Synthetic Home",
      );
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Next")?.click());
    await act(async () => button("Next")?.click());
    const strict = container.querySelector('input[value="strict"]') as HTMLInputElement | null;
    // Radio inputs are controlled by the selected option, not by a persisted default.
    expect(strict?.checked ?? false).toBe(false);
    const radios = [
      ...container.querySelectorAll('input[name="mcpPrivacy"]'),
    ] as HTMLInputElement[];
    await act(async () => radios[0]?.click());
    await act(async () => button("Next")?.click());
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(words);
    const backup = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => backup.click());
    await act(async () => button("Create secure profile")?.click());
    expect(commit).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain(words);
    expect(container.textContent).toContain("result is not confirmed");
    await act(async () => button("Check status")?.click());
    expect(inspect).toHaveBeenCalledWith({ operationId });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("in progress");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("retains the verified profile through uncertain workspace publication and retries workspace only", async () => {
  const ready = {
    kind: "ready" as const,
    operationId,
    vaultId: "a".repeat(32),
    profileSlug: "synthetic",
    reconnectRequired: true as const,
  };
  const prepare = vi.fn(async () => ({
    kind: "prepared" as const,
    operationId,
    phraseSession,
    words,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  }));
  const commit = vi.fn(async () => ready);
  const inspect = vi.fn(async () => ({
    availability: "ready" as const,
    path: "/tmp/old-workspace",
    defaultPath: "/tmp/synthetic-workspace",
    configured: true,
    upToDate: true,
    routinePermissions: true,
  }));
  const apply = vi.fn(async () => ({ kind: "outcome_unknown" as const, code: "inspect_failed" }));
  const workspace: CreationWorkspacePort = { isCurrent: () => true, inspect, apply };
  const onReady = vi.fn(async () => true);
  const onComplete = vi.fn(async () => {});
  const bridge: CreationBridge = {
    current: async () => ({ kind: "none" }),
    inspect: async ({ operationId: id }) => ({ kind: "not_found", operationId: id }),
    prepare,
    commit,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  try {
    await act(async () =>
      root.render(
        <CreationScreen
          mode="first"
          bridge={bridge}
          onReady={onReady}
          workspace={workspace}
          onComplete={onComplete}
        />,
      ),
    );
    const name = container.querySelector('input[name="profileName"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        name,
        "Synthetic Home",
      );
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Next")?.click());
    await act(async () => button("Next")?.click());
    await act(async () =>
      (container.querySelector('input[name="mcpPrivacy"]') as HTMLInputElement)?.click(),
    );
    await act(async () => button("Next")?.click());
    await act(async () =>
      (container.querySelector('input[type="checkbox"]') as HTMLInputElement)?.click(),
    );
    await act(async () => button("Create secure profile")?.click());
    expect(onReady).toHaveBeenCalledWith(ready);
    expect(container.textContent).toContain("Create workspace");
    const path = container.querySelector('[data-testid="workspace-path"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        path,
        "/tmp/new-workspace",
      );
      path.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Create workspace")?.click());
    expect(apply).toHaveBeenCalledWith(ready, {
      path: "/tmp/new-workspace",
      routinePermissions: false,
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(onComplete).not.toHaveBeenCalled();
    expect(button("Retry workspace only")).toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    await act(async () => button("Skip workspace")?.click());
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledWith(ready);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
