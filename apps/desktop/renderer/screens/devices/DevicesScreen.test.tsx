// @vitest-environment jsdom
import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DevicesScreen } from "./DevicesScreen.js";

const bindings = vi.hoisted(() => ({
  vault: "a".repeat(32),
  connection: "online",
  privacy: false,
  bridge: null as unknown,
}));
vi.mock("@cashu/store-react", () => ({
  useProfile: () => bindings.vault,
  useConnection: () => bindings.connection,
}));
vi.mock("@cashu/ui-logic/core/incognito", () => ({
  isIncognito: () => bindings.privacy,
  onIncognitoChange: () => () => {},
}));
vi.mock("../../devicesBridge.js", () => ({ devicesBridge: () => bindings.bridge }));

const own = "b".repeat(32);
const target = "c".repeat(32);
const orphan = "d".repeat(32);
const metadata = {
  leader: {
    mode: "pinned",
    state: "ok",
    device: own,
    pendingFrom: null,
    lastActivityAt: Date.now(),
    silentForMs: 0,
    warn: false,
  },
  keyProvenance: { source: "own", sender: own, recipientsKnown: false },
} as const;
const device = (id: string, name: string) => ({
  id,
  name,
  trusted: true,
  revoked: false,
  behind: false,
  forked: false,
  forkAgreed: null,
  pairedBy: own,
  pairedAt: { seg: 1, offset: 0 },
});
const prepared = (selected: boolean) => ({
  kind: "prepared" as const,
  vault: bindings.vault,
  token: "e".repeat(32),
  operationId: "0".repeat(26),
  expiresAt: Date.now() + 300_000,
  targets: [{ device: target, cut: { seg: 1, offset: 0 }, head: "local_start" as const }],
  affected: [{ device: orphan, name: "Sibling", selected }],
  warning: "unseen_writes_possible" as const,
  localStartConfirmationRequired: true,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLanguageForTests("en");
  bindings.vault = "a".repeat(32);
  bindings.connection = "online";
  bindings.privacy = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  bindings.bridge = null;
});

it("shows the warning and requires refreshed explicit orphan selection; clears words on vault change", async () => {
  const list = vi.fn(async () => ({
    kind: "ready" as const,
    vault: bindings.vault,
    ownDevice: own,
    ...metadata,
    operations: [],
    evidence: {
      historyPending: false,
      overflow: false,
      authorityUncertain: false,
      writeAdmission: "ready" as const,
    },
    devices: [device(own, "This device"), device(target, "Target")],
  }));
  const revokePreview = vi.fn(async (input: { recertify: string[] }) =>
    prepared(input.recertify.includes(orphan)),
  );
  const revokeCancel = vi.fn(async () => ({ kind: "cancelled" as const }));
  const revokeCommit = vi.fn(async () => ({
    kind: "completed" as const,
    operationId: "0".repeat(26),
  }));
  bindings.bridge = {
    list,
    revokePreview,
    revokeCancel,
    revokeCommit,
    revokeInspect: async () => ({ kind: "not_found", operationId: "0".repeat(26) }),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
  try {
    await act(async () => root.render(<DevicesScreen />));
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = target;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Review removal")?.click());
    expect(container.textContent?.includes("may exclude changes")).toBe(true);
    const orphanChoice = [...container.querySelectorAll("label")].find((node) =>
      node.textContent?.includes("Sibling"),
    );
    const orphanBox = orphanChoice?.querySelector("input") as HTMLInputElement | null;
    if (!orphanBox) throw new Error("synthetic orphan choice missing");
    expect(orphanBox.checked).toBe(false);
    await act(async () => orphanBox.click());
    expect((button("Remove device") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => button("Review selected devices")?.click());
    expect(revokePreview).toHaveBeenCalledTimes(2);
    expect(revokePreview.mock.calls[1]?.[0].recertify).toEqual([orphan]);
    const phrase = container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        phrase,
        "synthetic words",
      );
      phrase.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(phrase.value.length).toBeGreaterThan(0);
    bindings.vault = "f".repeat(32);
    await act(async () => {
      flushSync(() => root.render(<DevicesScreen />));
      // The old phrase and preview must be gone before effects or microtasks run.
      expect(container.querySelector('input[type="password"]')).toBeNull();
    });
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(revokeCommit).toHaveBeenCalledTimes(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("shows a silent leader's re-pin action with force unchecked and exact typed confirmation", async () => {
  const confirmationText = "PIN TARGET";
  const leaderPreview = vi.fn(async () => ({
    kind: "prepared" as const,
    vault: bindings.vault,
    token: "e".repeat(32),
    operationId: "2".repeat(26),
    expiresAt: Date.now() + 300_000,
    leader: target,
    force: false,
    mayStillRun: own,
    confirmationText,
  }));
  const leaderCommit = vi.fn(async () => ({
    kind: "completed" as const,
    operationId: "2".repeat(26),
  }));
  bindings.bridge = {
    list: async () => ({
      kind: "ready" as const,
      vault: bindings.vault,
      ownDevice: own,
      leader: { ...metadata.leader, state: "silent", silentForMs: 37 * 60 * 60 * 1000, warn: true },
      keyProvenance: metadata.keyProvenance,
      operations: [],
      leaderOperations: [],
      evidence: {
        historyPending: false,
        overflow: false,
        authorityUncertain: false,
        writeAdmission: "ready",
      },
      devices: [device(own, "This device"), device(target, "Target")],
    }),
    leaderPreview,
    leaderCommit,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
  try {
    await act(async () => root.render(<DevicesScreen />));
    const panel = [...container.querySelectorAll("section")].find(
      (node) => node.getAttribute("aria-label") === "Change fetch leader",
    );
    if (!panel) throw new Error("re-pin panel missing");
    const force = panel.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(force.checked).toBe(false);
    const select = panel.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = target;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Review change")?.click());
    expect(leaderPreview).toHaveBeenCalledWith({
      vault: bindings.vault,
      leader: target,
      force: false,
    });
    expect((button("Confirm change") as HTMLButtonElement).disabled).toBe(true);
    const typed = panel.querySelector('input[autocomplete="off"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        typed,
        confirmationText,
      );
      typed.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Confirm change")?.click());
    expect(leaderCommit).toHaveBeenCalledWith({
      vault: bindings.vault,
      token: "e".repeat(32),
      confirmationText,
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("reattaches a keyed unknown operation after disconnect and remount, then inspects the same id", async () => {
  const operationId = "1".repeat(26);
  let listed = 0;
  const list = vi.fn(async () => ({
    kind: "ready" as const,
    vault: bindings.vault,
    ownDevice: own,
    ...metadata,
    operations: listed++ === 0 ? [] : [{ operationId, phase: "may_append" as const }],
    evidence: {
      historyPending: false,
      overflow: false,
      authorityUncertain: false,
      writeAdmission: "ready" as const,
    },
    devices: [device(own, "This device"), device(target, "Target")],
  }));
  const revokePreview = vi.fn(async () => ({ ...prepared(false), operationId }));
  const revokeCancel = vi.fn(async () => ({ kind: "cancelled" as const }));
  let finishCommit: ((value: { kind: "outcome_unknown"; operationId: string }) => void) | undefined;
  const revokeCommit = vi.fn(
    () =>
      new Promise<{ kind: "outcome_unknown"; operationId: string }>((resolve) => {
        finishCommit = resolve;
      }),
  );
  const revokeInspect = vi.fn(async () => ({ kind: "completed" as const, operationId }));
  bindings.bridge = { list, revokePreview, revokeCancel, revokeCommit, revokeInspect };
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label));
  try {
    await act(async () => root.render(<DevicesScreen />));
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = target;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Review removal")?.click());
    const boxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    await act(async () => {
      boxes
        .filter((box) => !box.closest("fieldset"))
        .forEach((box) => {
          box.click();
        });
    });
    const phrase = container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        phrase,
        "synthetic recovery words",
      );
      phrase.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Remove device")?.click());
    expect(revokeCommit).toHaveBeenCalledTimes(1);
    expect(revokeCancel).toHaveBeenCalledTimes(0);
    bindings.connection = "offline";
    await act(async () => root.render(<DevicesScreen />));
    await act(async () => finishCommit?.({ kind: "outcome_unknown", operationId }));
    await act(async () => root.unmount());
    root = createRoot(container);
    bindings.connection = "online";
    await act(async () => root.render(<DevicesScreen />));
    expect(container.textContent?.includes("outcome is unknown")).toBe(true);
    expect((button("Review removal") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => button("Check outcome")?.click());
    expect(revokeInspect).toHaveBeenCalledWith({ vault: bindings.vault, operationId });
    expect(container.textContent?.includes("Device removed")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("cancels a preview that returns after the vault has changed", async () => {
  const list = vi.fn(async () => ({
    kind: "ready" as const,
    vault: bindings.vault,
    ownDevice: own,
    ...metadata,
    operations: [],
    evidence: {
      historyPending: false,
      overflow: false,
      authorityUncertain: false,
      writeAdmission: "ready" as const,
    },
    devices: [device(own, "This device"), device(target, "Target")],
  }));
  let finishPreview: ((value: ReturnType<typeof prepared>) => void) | undefined;
  const revokePreview = vi.fn(
    () =>
      new Promise<ReturnType<typeof prepared>>((resolve) => {
        finishPreview = resolve;
      }),
  );
  const revokeCancel = vi.fn(async () => ({ kind: "cancelled" as const }));
  bindings.bridge = {
    list,
    revokePreview,
    revokeCancel,
    revokeCommit: vi.fn(),
    revokeInspect: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DevicesScreen />));
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = target;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((node) => node.textContent?.includes("Review removal"))
        ?.click(),
    );
    const originalVault = bindings.vault;
    bindings.vault = "f".repeat(32);
    await act(async () => root.render(<DevicesScreen />));
    await act(async () => finishPreview?.({ ...prepared(false), vault: originalVault }));
    expect(revokeCancel).toHaveBeenCalledWith({ vault: originalVault, token: "e".repeat(32) });
    expect(container.querySelector('input[type="password"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([
  [
    {
      historyPending: true,
      overflow: false,
      authorityUncertain: true,
      writeAdmission: "authority-unresolved" as const,
    },
    "needs verification",
  ],
  [
    {
      historyPending: true,
      overflow: true,
      authorityUncertain: true,
      writeAdmission: "authority-unresolved" as const,
    },
    "evidence limit was reached",
  ],
])("shows unresolved device evidence and blocks removal preview", async (evidence, message) => {
  const revokePreview = vi.fn();
  bindings.bridge = {
    list: async () => ({
      kind: "ready",
      vault: bindings.vault,
      ownDevice: own,
      ...metadata,
      operations: [],
      evidence,
      devices: [device(own, "This device"), device(target, "Target")],
    }),
    revokePreview,
    revokeCancel: vi.fn(),
    revokeCommit: vi.fn(),
    revokeInspect: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DevicesScreen />));
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = target;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const review = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Review removal"),
    ) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    expect(container.textContent?.includes(message)).toBe(true);
    expect(revokePreview).toHaveBeenCalledTimes(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
