// @vitest-environment jsdom
import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DevicesScreen } from "./DevicesScreen.js";

const bindings = vi.hoisted(() => ({
  vault: "a".repeat(32),
  connection: "online",
  bridge: null as unknown,
  /** The device list the host pushes (the live `core.settings.deviceList` query). */
  list: null as unknown,
}));
vi.mock("@cashu/store-react", () => ({
  useProfile: () => bindings.vault,
  useConnection: () => bindings.connection,
  // One snapshot per pushed list, as the live query keeps its reference until the host pushes again.
  useQuery: () => {
    if (snapshot.list !== bindings.list)
      snapshot.value =
        bindings.list === null
          ? { status: "unavailable" }
          : { status: "ready", list: bindings.list };
    snapshot.list = bindings.list;
    return snapshot.value;
  },
}));
const snapshot = vi.hoisted(() => ({ list: undefined as unknown, value: undefined as unknown }));
vi.mock("../../devicesBridge.js", () => ({ devicesBridge: () => bindings.bridge }));

const own = "b".repeat(32);
const target = "c".repeat(32);
const orphan = "d".repeat(32);
const token = "e".repeat(32);
const leaderOk = {
  mode: "pinned",
  state: "ok",
  device: own,
  pendingFrom: null,
  lastActivityAt: Date.now(),
  silentForMs: 0,
  warn: false,
};
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
/** A ready device list for the current vault; `overrides` replaces top-level fields. */
const deviceList = (overrides: Record<string, unknown> = {}) => ({
  kind: "ready" as const,
  vault: bindings.vault,
  ownDevice: own,
  leader: leaderOk,
  keyProvenance: { source: "own", sender: own, recipientsKnown: false },
  operations: [],
  leaderOperations: [],
  evidence: {
    historyPending: false,
    overflow: false,
    authorityUncertain: false,
    writeAdmission: "ready" as const,
  },
  devices: [device(own, "This device"), device(target, "Target")],
  ...overrides,
});
/** A silent leader: the re-pin panel offers a change. */
const leaderList = (overrides: Record<string, unknown> = {}) =>
  deviceList({ leader: { ...leaderOk, state: "silent", warn: true }, ...overrides });
const prepared = (selected: boolean) => ({
  kind: "prepared" as const,
  vault: bindings.vault,
  token,
  operationId: "0".repeat(26),
  expiresAt: Date.now() + 300_000,
  targets: [{ device: target, cut: { seg: 1, offset: 0 }, head: "local_start" as const }],
  affected: [{ device: orphan, name: "Sibling", selected }],
  warning: "unseen_writes_possible" as const,
  localStartConfirmationRequired: true,
});
const leaderPrepared = (operationId: string, expiresIn = 300_000) => ({
  kind: "prepared" as const,
  vault: bindings.vault,
  token,
  operationId,
  expiresAt: Date.now() + expiresIn,
  leader: target,
  force: false,
  mayStillRun: own,
  confirmationText: "PIN TARGET",
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLanguageForTests("en");
  bindings.vault = "a".repeat(32);
  bindings.connection = "online";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  bindings.bridge = null;
  bindings.list = null;
});

const render = () => act(async () => root.render(<DevicesScreen />));
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label)) as
    | HTMLButtonElement
    | undefined;
const click = (label: string) => act(async () => button(label)?.click());
const leaderSelect = () =>
  container.querySelector('section[aria-label="Change fetch leader"] select') as HTMLSelectElement;
const leaderTyped = () => container.querySelector('input[autocomplete="off"]');
const phrase = () => container.querySelector('input[type="password"]') as HTMLInputElement | null;
async function choose(select: HTMLSelectElement) {
  await act(async () => {
    select.value = target;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** Opens the removal review for the target device. */
async function reviewRemoval() {
  await render();
  await choose(container.querySelector("select") as HTMLSelectElement);
  await click("Review removal");
}
/** Opens the leader change review for the target device. */
async function reviewLeaderChange() {
  await render();
  await choose(leaderSelect());
  await click("Review change");
}

it("shows the warning and requires refreshed explicit orphan selection; clears words on vault change", async () => {
  bindings.list = deviceList();
  const revokePreview = vi.fn(async (input: { recertify: string[] }) =>
    prepared(input.recertify.includes(orphan)),
  );
  const revokeCommit = vi.fn();
  bindings.bridge = {
    revokePreview,
    revokeCancel: vi.fn(async () => ({ kind: "cancelled" as const })),
    revokeCommit,
    revokeInspect: async () => ({ kind: "not_found", operationId: "0".repeat(26) }),
  };
  await reviewRemoval();
  expect(container.textContent).toContain("may exclude changes");
  const orphanBox = [...container.querySelectorAll("label")]
    .find((node) => node.textContent?.includes("Sibling"))
    ?.querySelector("input") as HTMLInputElement | null;
  if (!orphanBox) throw new Error("synthetic orphan choice missing");
  expect(orphanBox.checked).toBe(false);
  await act(async () => orphanBox.click());
  expect(button("Remove device")?.disabled).toBe(true);
  await click("Review selected devices");
  expect(revokePreview).toHaveBeenCalledTimes(2);
  expect(revokePreview.mock.calls[1]?.[0].recertify).toEqual([orphan]);
  await type(phrase() as HTMLInputElement, "synthetic words");
  bindings.vault = "f".repeat(32);
  await act(async () => {
    flushSync(() => root.render(<DevicesScreen />));
    // The old phrase and preview must be gone before effects or microtasks run.
    expect(phrase()).toBeNull();
  });
  expect(phrase()).toBeNull();
  expect(revokeCommit).not.toHaveBeenCalled();
});

it("cancels a removal preview that returns after the vault has changed", async () => {
  bindings.list = deviceList();
  let finishPreview: ((value: ReturnType<typeof prepared>) => void) | undefined;
  const revokeCancel = vi.fn(async () => ({ kind: "cancelled" as const }));
  bindings.bridge = {
    revokePreview: vi.fn(
      () =>
        new Promise<ReturnType<typeof prepared>>((resolve) => {
          finishPreview = resolve;
        }),
    ),
    revokeCancel,
    revokeCommit: vi.fn(),
    revokeInspect: vi.fn(),
  };
  await reviewRemoval();
  const originalVault = bindings.vault;
  bindings.vault = "f".repeat(32);
  await render();
  await act(async () => finishPreview?.({ ...prepared(false), vault: originalVault }));
  expect(revokeCancel).toHaveBeenCalledWith({ vault: originalVault, token });
  expect(phrase()).toBeNull();
});

it("reattaches a keyed unknown removal after disconnect and remount, then inspects the same id", async () => {
  const operationId = "1".repeat(26);
  bindings.list = deviceList();
  const revokeCancel = vi.fn(async () => ({ kind: "cancelled" as const }));
  let finishCommit: ((value: { kind: "outcome_unknown"; operationId: string }) => void) | undefined;
  const revokeCommit = vi.fn(
    () =>
      new Promise<{ kind: "outcome_unknown"; operationId: string }>((resolve) => {
        finishCommit = resolve;
      }),
  );
  const revokeInspect = vi.fn(async () => ({ kind: "completed" as const, operationId }));
  bindings.bridge = {
    revokePreview: vi.fn(async () => ({ ...prepared(false), operationId })),
    revokeCancel,
    revokeCommit,
    revokeInspect,
  };
  await reviewRemoval();
  await act(async () => {
    for (const box of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      if (!box.closest("fieldset")) box.click();
  });
  await type(phrase() as HTMLInputElement, "synthetic recovery words");
  await click("Remove device");
  expect(revokeCommit).toHaveBeenCalledTimes(1);
  expect(revokeCancel).not.toHaveBeenCalled();
  bindings.connection = "offline";
  await render();
  await act(async () => finishCommit?.({ kind: "outcome_unknown", operationId }));
  await act(async () => root.unmount());
  root = createRoot(container);
  // The host now records the removal as possibly appended and pushes that.
  bindings.list = deviceList({ operations: [{ operationId, phase: "may_append" }] });
  bindings.connection = "online";
  await render();
  expect(container.textContent).toContain("outcome is unknown");
  expect(button("Review removal")?.disabled).toBe(true);
  await click("Check outcome");
  expect(revokeInspect).toHaveBeenCalledWith({ vault: bindings.vault, operationId });
  expect(container.textContent).toContain("Device removed");
});

it("shows unresolved device evidence and blocks the removal preview", async () => {
  const revokePreview = vi.fn();
  bindings.list = deviceList({
    evidence: {
      historyPending: true,
      overflow: false,
      authorityUncertain: true,
      writeAdmission: "authority-unresolved",
    },
  });
  bindings.bridge = {
    revokePreview,
    revokeCancel: vi.fn(),
    revokeCommit: vi.fn(),
    revokeInspect: vi.fn(),
  };
  await render();
  await choose(container.querySelector("select") as HTMLSelectElement);
  expect(button("Review removal")?.disabled).toBe(true);
  expect(container.textContent).toContain("needs verification");
  expect(revokePreview).not.toHaveBeenCalled();
});

it("shows a silent leader's re-pin action with force unchecked and exact typed confirmation", async () => {
  const leaderPreview = vi.fn(async () => leaderPrepared("2".repeat(26)));
  const leaderCommit = vi.fn(async () => ({
    kind: "completed" as const,
    operationId: "2".repeat(26),
  }));
  bindings.list = leaderList({
    leader: { ...leaderOk, state: "silent", silentForMs: 37 * 60 * 60 * 1000, warn: true },
  });
  bindings.bridge = { leaderPreview, leaderCommit };
  await render();
  const panel = container.querySelector('section[aria-label="Change fetch leader"]');
  if (!panel) throw new Error("re-pin panel missing");
  expect((panel.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  await choose(leaderSelect());
  await click("Review change");
  expect(leaderPreview).toHaveBeenCalledWith({
    vault: bindings.vault,
    leader: target,
    force: false,
  });
  expect(button("Confirm change")?.disabled).toBe(true);
  await type(leaderTyped() as HTMLInputElement, "PIN TARGET");
  await click("Confirm change");
  expect(leaderCommit).toHaveBeenCalledWith({
    vault: bindings.vault,
    token,
    confirmationText: "PIN TARGET",
  });
});

it("recovers a pending leader operation and inspects its original key", async () => {
  const operationId = "3".repeat(26);
  const leaderInspect = vi.fn(async () => ({ kind: "completed" as const, operationId }));
  bindings.list = leaderList({ leaderOperations: [{ operationId, phase: "may_append" }] });
  bindings.bridge = { leaderPreview: vi.fn(), leaderInspect };
  await render();
  expect(container.textContent).toContain("outcome is unknown");
  expect(button("Review change")?.disabled).toBe(true);
  await click("Check outcome");
  expect(leaderInspect).toHaveBeenCalledWith({ vault: bindings.vault, operationId });
  expect(container.textContent).toContain("Fetch leader changed");
});

it("drops a leader preview that returns after a profile switch", async () => {
  const oldVault = bindings.vault;
  let finishPreview: ((value: unknown) => void) | undefined;
  const leaderPreview = vi.fn(
    () =>
      new Promise((resolve) => {
        finishPreview = resolve;
      }),
  );
  bindings.list = leaderList();
  bindings.bridge = { leaderPreview };
  await reviewLeaderChange();
  bindings.vault = "f".repeat(32);
  await render();
  await act(async () => finishPreview?.({ ...leaderPrepared("4".repeat(26)), vault: oldVault }));
  expect(leaderSelect().value).toBe("");
  expect(leaderTyped()).toBeNull();
  expect(leaderPreview).toHaveBeenCalledTimes(1);
});

it("clears a leader preview when the same vault gets a new bridge session", async () => {
  bindings.list = leaderList();
  const leaderPreview = async () => leaderPrepared("6".repeat(26));
  bindings.bridge = { leaderPreview };
  await reviewLeaderChange();
  expect(leaderTyped()).not.toBeNull();
  bindings.bridge = { leaderPreview };
  await render();
  expect(leaderTyped()).toBeNull();
  expect(leaderSelect().value).toBe("");
});

it("disables an expired leader preview before commit", async () => {
  const leaderCommit = vi.fn();
  bindings.list = leaderList();
  bindings.bridge = {
    leaderPreview: async () => leaderPrepared("5".repeat(26), 1_000),
    leaderCommit,
  };
  await render();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  await choose(leaderSelect());
  await click("Review change");
  await type(leaderTyped() as HTMLInputElement, "PIN TARGET");
  expect(button("Confirm change")?.disabled).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(button("Confirm change")?.disabled).toBe(true);
  await click("Confirm change");
  expect(leaderCommit).not.toHaveBeenCalled();
});

it("while this Mac's fetch is paused, offers Keep fetching on this Mac instead of the re-pin, after a confirm", async () => {
  const keepFetching = vi.fn(async () => ({ kind: "done" as const }));
  vi.stubGlobal("cashuRelay", {
    status: vi.fn(async () => ({
      configured: true,
      enabled: true,
      devices: 2,
      identityLost: false,
      canReconnect: false,
      pausedSince: Date.now() - 8 * 24 * 60 * 60_000,
    })),
    keepFetching,
  });
  bindings.list = deviceList({
    leader: { ...leaderOk, paused: "offline_too_long", pausedPeer: target },
    devices: [device(own, "This device"), device(target, "Mac mini")],
  });
  bindings.bridge = {};
  await render();
  const anywhere = (label: string) =>
    [...document.body.querySelectorAll("button")].find((node) => node.textContent === label);
  expect(container.textContent).toContain("Bank fetch paused");
  expect(button("Make this Mac the one that fetches")).toBeUndefined();
  expect(container.querySelector('section[aria-label="Change fetch leader"]')).toBeNull();
  await click("Keep fetching on this Mac");
  expect(document.body.textContent).toContain(
    "Keep fetching on this Mac? Make sure your other Mac “Mac mini” doesn't fetch too. cashU asks again in 7 days.",
  );
  await act(async () => anywhere("Cancel")?.click());
  expect(keepFetching).not.toHaveBeenCalled();
  await click("Keep fetching on this Mac");
  await act(async () => anywhere("Keep fetching")?.click());
  expect(keepFetching).toHaveBeenCalledWith({ vault: bindings.vault });
});

it("names who added each device and never shows its log position", async () => {
  bindings.list = deviceList({
    devices: [
      device(own, "This device"),
      {
        ...device(target, "Target"),
        pairedAt: { seg: 1, offset: 765 },
        forked: true,
        forkAgreed: { seg: 1, offset: 700 },
      },
    ],
  });
  await render();
  expect(container.textContent).toContain("Target: Added by This device");
  expect(container.textContent).not.toMatch(/segment|position|765|700/);
});

it("adds the day a device was added when the host knows it, in both languages", async () => {
  bindings.list = deviceList({
    devices: [device(own, "This device"), { ...device(target, "Target"), pairedOn: "2026-11-12" }],
  });
  await render();
  const origins = () =>
    [...container.querySelectorAll("section[aria-label] li")].map((node) => node.textContent);
  expect(origins()).toContain("This device: Added by This device");
  expect(origins()).toContainEqual(
    expect.stringMatching(/^Target: Added by This device · (Nov 12, 2026|12 Nov 2026)$/),
  );
  setLanguageForTests("pl");
  bindings.list = deviceList({
    devices: [device(own, "This device"), { ...device(target, "Target"), pairedOn: "2026-11-12" }],
  });
  await render();
  expect(origins()).toContain("Target: Dodane przez This device · 12 lis 2026");
});

it("says in plain words what a removal keeps from a device this Mac has changes from", async () => {
  bindings.list = deviceList();
  const trusted = {
    ...prepared(false),
    targets: [{ device: target, cut: { seg: 1, offset: 0 }, head: "trusted" as const }],
    affected: [],
    localStartConfirmationRequired: false,
  };
  bindings.bridge = {
    revokePreview: vi.fn(async () => trusted),
    revokeCancel: vi.fn(async () => ({ kind: "cancelled" as const })),
    revokeCommit: vi.fn(),
    revokeInspect: async () => ({ kind: "not_found", operationId: "0".repeat(26) }),
  };
  await reviewRemoval();
  const text = container.textContent ?? "";
  expect(text).toContain("Target: Changes that already reached this Mac stay.");
  expect(text.toLowerCase()).not.toContain("cut head");
});
