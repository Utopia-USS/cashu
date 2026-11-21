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
const snapshot = vi.hoisted(() => ({ list: undefined as unknown, value: undefined as unknown }));
vi.mock("@cashu/store-react", () => ({
  useProfile: () => bindings.vault,
  useConnection: () => bindings.connection,
  useQuery: (query: { id?: string }) => {
    if (query?.id === "core.profileIdentity")
      return { slug: "anna", name: "Anna", baseCurrency: "PLN" };
    // One snapshot per pushed list, as the live query keeps its reference until the host pushes again.
    if (snapshot.list !== bindings.list)
      snapshot.value =
        bindings.list === null
          ? { status: "unavailable" }
          : { status: "ready", list: bindings.list };
    snapshot.list = bindings.list;
    return snapshot.value;
  },
}));
vi.mock("../../devicesBridge.js", () => ({ devicesBridge: () => bindings.bridge }));

const own = "b".repeat(32);
const target = "c".repeat(32);
const orphan = "d".repeat(32);
const token = "e".repeat(32);
const DAY = 86_400_000;
const leaderOk = {
  mode: "pinned",
  state: "ok",
  device: own,
  pendingFrom: null,
  lastActivityAt: Date.now(),
  silentForMs: 0,
  warn: false,
};
const device = (id: string, name: string, offset = 0) => ({
  id,
  name,
  trusted: true,
  revoked: false,
  behind: false,
  forked: false,
  forkAgreed: null,
  pairedBy: own,
  pairedAt: { seg: 1, offset },
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
  devices: [device(own, "Demo Mac"), device(target, "Target", 1)],
  ...overrides,
});
/** The other Mac fetches and has been silent for `silentForMs`: the 36-hour rule allows a change. */
const silentList = (silentForMs = 3 * DAY + 5) =>
  deviceList({
    leader: { ...leaderOk, state: "silent", device: target, silentForMs, warn: true },
  });
const prepared = (selected: boolean, overrides: Record<string, unknown> = {}) => ({
  kind: "prepared" as const,
  vault: bindings.vault,
  token,
  operationId: "0".repeat(26),
  expiresAt: Date.now() + 300_000,
  targets: [{ device: target, cut: { seg: 1, offset: 0 }, head: "trusted" as const }],
  affected: [{ device: orphan, name: "Sibling", selected }],
  warning: "unseen_writes_possible" as const,
  localStartConfirmationRequired: false,
  ...overrides,
});
const leaderPrepared = (operationId: string, force = false) => ({
  kind: "prepared" as const,
  vault: bindings.vault,
  token,
  operationId,
  expiresAt: Date.now() + 300_000,
  leader: own,
  force,
  mayStillRun: target,
  confirmationText: "PIN DEMO",
});
const revokeBridge = (overrides: Record<string, unknown> = {}) => ({
  revokePreview: vi.fn(async (input: { recertify: string[] }) =>
    prepared(input.recertify.includes(orphan)),
  ),
  revokeCancel: vi.fn(async () => ({ kind: "cancelled" as const })),
  revokeCommit: vi.fn(async () => ({ kind: "completed" as const, operationId: "0".repeat(26) })),
  revokeInspect: vi.fn(async () => ({ kind: "not_found" as const, operationId: "0".repeat(26) })),
  ...overrides,
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
  vi.unstubAllGlobals();
  bindings.bridge = null;
  bindings.list = null;
});

const render = () => act(async () => root.render(<DevicesScreen />));
/** Dialogs render in a portal: search the whole document. */
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((node) => node.textContent?.includes(label)) as
    | HTMLButtonElement
    | undefined;
const click = (label: string) => act(async () => button(label)?.click());
const rowOf = (name: string) =>
  [...container.querySelectorAll("li[data-device]")].find((row) =>
    row.querySelector(".font-strong")?.textContent?.startsWith(name),
  ) as HTMLLIElement | undefined;
const rowNames = () =>
  [...container.querySelectorAll("li[data-device] .font-strong > span:first-child")].map(
    (node) => node.textContent,
  );
/** Opens a row's "…" menu and returns its items. */
async function menu(name: string) {
  const row = rowOf(name);
  await act(async () => row?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click());
  return [...(row?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
}
const phrase = () =>
  document.body.querySelector('input[type="password"]') as HTMLInputElement | null;
const dialog = () => document.body.querySelector('[role="dialog"]');
/** The dialog's buttons by their exact text, in order. */
const dialogButtons = () =>
  [...(dialog()?.querySelectorAll("button") ?? [])]
    .map((node) => node.textContent ?? "")
    .filter((text) => text !== "✕");
const clickInDialog = (label: string) =>
  act(async () =>
    [...(dialog()?.querySelectorAll("button") ?? [])]
      .find((node) => node.textContent === label)
      ?.click(),
  );
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** The dialog's one fact checkbox (outside the "keep these devices" fieldset). */
const ackBox = () =>
  [...(dialog()?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])].find(
    (box) => !box.closest("fieldset"),
  );
async function openRemoval(name = "Target") {
  await render();
  const items = await menu(name);
  await act(async () =>
    items.find((item) => item.textContent?.includes("Remove from profile"))?.click(),
  );
}

it("states each device's facts on its row, this Mac first, never a log position", async () => {
  const today = new Date();
  const iso = (offsetDays: number) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offsetDays);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  };
  bindings.list = deviceList({
    devices: [
      {
        ...device(target, "Studio Mac", 765),
        pairedOn: iso(-1),
        forked: true,
        forkAgreed: { seg: 1, offset: 700 },
      },
      { ...device(own, "Demo Mac", 900), pairedBy: own },
      {
        ...device(orphan, "Phone", 2),
        pairedBy: "0".repeat(32),
        behind: true,
        pairedOn: "2024-03-05",
      },
    ],
  });
  await render();
  expect(rowNames()).toEqual(["Demo Mac", "Phone", "Studio Mac"]);
  const mac = rowOf("Demo Mac")?.textContent ?? "";
  expect(mac).toContain("This Mac");
  expect(mac).toContain("Fetches bank data");
  // The host cannot tell a fetch from the pin: the tag carries no time.
  expect(mac).not.toMatch(/last bank fetch|\d\d:\d\d/);
  // No device glyph until the list knows a device's kind: a row starts with its name.
  for (const row of container.querySelectorAll("li[data-device]")) {
    expect(row.firstElementChild?.textContent).toMatch(/^(Demo Mac|Phone|Studio Mac)/);
    expect([...row.querySelectorAll("svg")].filter((svg) => !svg.closest("button"))).toEqual([]);
  }
  expect(rowOf("Studio Mac")?.textContent).toContain("Added yesterday by Demo Mac");
  expect(rowOf("Studio Mac")?.textContent).toContain("doesn't match this Mac's");
  // A date outside the current year carries the year; added with the recovery words.
  expect(rowOf("Phone")?.textContent).toContain("Added 5 Mar 2024 with the recovery words");
  expect(rowOf("Phone")?.textContent).toContain(
    "Some changes from Phone haven't reached this Mac yet. Open cashU on Phone to send them.",
  );
  expect(container.textContent).not.toMatch(/segment|position|765|700/);
  // The list header counts the rows (the card already says "Devices"); the security details name
  // the key's origin.
  expect(container.querySelector("#devices-list-title")?.textContent).toBe("3 devices");
  expect(container.querySelector("details")?.textContent).toContain("Created on this Mac");
  setLanguageForTests("pl");
  await render();
  expect(rowOf("Studio Mac")?.textContent).toContain("Dodane wczoraj przez Demo Mac");
  expect(rowOf("Phone")?.textContent).toContain("Dodane 5 mar 2024 za pomocą słów odzyskiwania");
  expect(container.querySelector("#devices-list-title")?.textContent).toBe("3 urządzenia");
  // A Polish profile name stands in quotes (it is not inflected); a device name never does.
  expect(container.textContent).toContain("Urządzenia, które mogą otworzyć profil „Anna”.");
});

it("shows a device that removed its copy greyed in its place, its note opening the removal", async () => {
  const bridge = revokeBridge();
  bindings.bridge = bridge;
  bindings.list = deviceList({
    devices: [
      device(own, "Demo Mac"),
      { ...device(target, "iPhone", 1), leftAt: "2026-11-15" },
      device(orphan, "iPad", 9),
    ],
  });
  await render();
  expect(rowNames()).toEqual(["Demo Mac", "iPhone", "iPad"]);
  const left = rowOf("iPhone");
  expect(left?.querySelector(".text-fg-muted")?.textContent).toContain("iPhone");
  expect(left?.textContent).toMatch(/removed its copy on 15 Nov( 2026)?/);
  expect(rowOf("iPad")?.textContent).not.toContain("removed its copy");
  // The note's button is the action: no row menu on that row.
  expect(left?.querySelector("button[aria-expanded]")).toBeNull();
  await act(async () =>
    [...(left?.querySelectorAll("button") ?? [])]
      .find((node) => node.textContent === "Remove from profile")
      ?.click(),
  );
  expect(bridge.revokePreview).toHaveBeenCalledWith({
    vault: bindings.vault,
    targets: [target],
    recertify: [],
  });
  expect(dialog()?.textContent).toContain("Remove iPhone from Anna's profile?");
  await click("Cancel");
  setLanguageForTests("pl");
  await render();
  expect(rowOf("iPhone")?.textContent).toMatch(
    /Urządzenie iPhone usunęło swoją kopię 15 lis( 2026)?/,
  );
});

it("offers row actions by role: no removal on this Mac, the fetch change only after 36 hours", async () => {
  bindings.bridge = { ...revokeBridge(), leaderPreview: vi.fn(), leaderCommit: vi.fn() };
  bindings.list = deviceList({
    devices: [device(own, "Demo Mac"), device(target, "Studio Mac", 1)],
  });
  await render();
  // This Mac fetches: no fetch item and no removal, so no menu at all.
  expect(rowOf("Demo Mac")?.querySelector("button[aria-expanded]")).toBeNull();
  // Another device's menu only removes it: fetching moves to another Mac from that Mac.
  expect((await menu("Studio Mac")).map((item) => item.textContent)).toEqual([
    "Remove from profile…",
  ]);
  // Studio Mac fetches and reported recently: the item waits for the 36-hour rule.
  bindings.list = deviceList({
    leader: { ...leaderOk, device: target },
    devices: [device(own, "Demo Mac"), device(target, "Studio Mac", 1)],
  });
  await render();
  const waiting = await menu("Demo Mac");
  expect(waiting.map((item) => item.disabled)).toEqual([true]);
  expect(waiting[0]?.textContent).toContain("Available after 36 hours without a bank fetch");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  // Silent for three days: on this Mac the change is offered.
  bindings.list = silentList();
  await render();
  const mine = await menu("Demo Mac");
  expect(mine.map((item) => item.textContent)).toEqual(["Fetch bank data on this Mac"]);
  expect(mine[0]?.disabled).toBe(false);
});

it("changes which Mac fetches with the force checkbox, without a typed confirmation", async () => {
  const leaderPreview = vi.fn(async (input: { force: boolean }) =>
    leaderPrepared("2".repeat(26), input.force),
  );
  const leaderCommit = vi.fn(async () => ({
    kind: "completed" as const,
    operationId: "2".repeat(26),
  }));
  bindings.bridge = { leaderPreview, leaderCommit };
  bindings.list = silentList();
  await render();
  await act(async () => (await menu("Demo Mac"))[0]?.click());
  expect(dialog()?.textContent).toContain("Fetch bank data on this Mac?");
  expect(dialog()?.textContent).toContain(
    "Target fetches today. It hands over the next time it syncs",
  );
  const force = dialog()?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(force?.checked).toBe(false);
  expect(dialog()?.textContent).toContain("Target hasn't reported for 3 days.");
  expect(dialog()?.querySelector('input:not([type="checkbox"])')).toBeNull();
  await act(async () => force?.click());
  await click("Fetch on this Mac");
  expect(leaderPreview).toHaveBeenCalledWith({ vault: bindings.vault, leader: own, force: true });
  expect(leaderCommit).toHaveBeenCalledWith({
    vault: bindings.vault,
    token,
    confirmationText: "PIN DEMO",
  });
  expect(dialog()).toBeNull();
});

it("names the silence in the force option only from one whole day", async () => {
  bindings.bridge = { leaderPreview: vi.fn(), leaderCommit: vi.fn() };
  const forceText = async (silentForMs: number) => {
    bindings.list = silentList(silentForMs);
    await render();
    await act(async () => (await menu("Demo Mac"))[0]?.click());
    const text =
      dialog()?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.parentElement
        ?.textContent ?? "";
    await click("Cancel");
    return text;
  };
  const twoHours = await forceText(2 * 60 * 60 * 1000);
  expect(twoHours).toMatch(/^Switch now without waiting for Target\. If it is still running/);
  expect(twoHours).not.toMatch(/day/);
  expect(await forceText(DAY - 1)).not.toMatch(/day/);
  expect(await forceText(DAY)).toContain("Target hasn't reported for 1 day.");
  expect(await forceText(2 * DAY + 1)).toContain("Target hasn't reported for 2 days.");
});

it("keeps a leader change with an open outcome in its dialog and inspects its original key", async () => {
  const operationId = "3".repeat(26);
  const leaderInspect = vi.fn(async () => ({ kind: "completed" as const, operationId }));
  bindings.list = deviceList({ leaderOperations: [{ operationId, phase: "may_append" }] });
  bindings.bridge = { leaderPreview: vi.fn(), leaderInspect };
  await render();
  expect(dialog()?.textContent).toContain("It isn't known yet whether the change finished.");
  await click("Check outcome");
  expect(leaderInspect).toHaveBeenCalledWith({ vault: bindings.vault, operationId });
  expect(dialog()).toBeNull();
});

it("removes a device: the added ones start kept, one checkbox and the words gate the red button", async () => {
  const bridge = revokeBridge();
  bindings.bridge = bridge;
  bindings.list = deviceList();
  await openRemoval();
  // Asked once, then again with every added device kept (they start ticked).
  expect(bridge.revokePreview).toHaveBeenCalledTimes(2);
  expect(bridge.revokePreview.mock.calls[1]?.[0].recertify).toEqual([orphan]);
  expect(bridge.revokeCancel).toHaveBeenCalledWith({ vault: bindings.vault, token });
  const kept = dialog()?.querySelector<HTMLInputElement>("fieldset input");
  expect(kept?.checked).toBe(true);
  expect(dialog()?.textContent).toContain("Devices added by Target. Keep them in the profile:");
  // The recovery words take the focus, never the close glyph.
  expect(document.activeElement).toBe(phrase());
  expect(ackBox()?.parentElement?.textContent).toBe(
    "Changes from Target that haven't reached this Mac will be lost. Remove it anyway.",
  );
  const remove = () => button("Remove and change the key");
  expect(remove()?.disabled).toBe(true);
  await type(phrase() as HTMLInputElement, "synthetic recovery words for the test");
  expect(remove()?.disabled).toBe(true);
  await act(async () => ackBox()?.click());
  expect(remove()?.disabled).toBe(false);
  // Unticking a kept device asks for a new review first.
  await act(async () => kept?.click());
  expect(remove()?.disabled).toBe(true);
  await click("Review selected devices");
  expect(bridge.revokePreview.mock.calls.at(-1)?.[0].recertify).toEqual([]);
  await act(async () => ackBox()?.click());
  await type(phrase() as HTMLInputElement, "synthetic recovery words for the test");
  await click("Remove and change the key");
  expect(bridge.revokeCommit).toHaveBeenCalledWith({
    vault: bindings.vault,
    token,
    warningAcknowledgement: "revoke_risk_acknowledged",
    recoveryPhrase: "synthetic recovery words for the test",
  });
  expect(dialog()).toBeNull();
});

it("states the local start in the one checkbox and sends both acknowledgements", async () => {
  const bridge = revokeBridge({
    revokePreview: vi.fn(async () =>
      prepared(false, {
        affected: [],
        targets: [{ device: target, cut: { seg: 1, offset: 0 }, head: "local_start" }],
        localStartConfirmationRequired: true,
      }),
    ),
  });
  bindings.bridge = bridge;
  bindings.list = deviceList();
  await openRemoval();
  expect(ackBox()?.parentElement?.textContent).toBe(
    "This Mac has nothing from Target yet. Anything only on Target will be lost. Remove it anyway.",
  );
  await act(async () => ackBox()?.click());
  await type(phrase() as HTMLInputElement, "synthetic recovery words for the test");
  await click("Remove and change the key");
  expect(bridge.revokeCommit).toHaveBeenCalledWith(
    expect.objectContaining({ localStartAcknowledgement: "local_target_stream_never_seen" }),
  );
});

it("names pending changes from the device in the checkbox", async () => {
  bindings.bridge = revokeBridge({
    revokePreview: vi.fn(async () => prepared(false, { affected: [] })),
  });
  bindings.list = deviceList({
    devices: [device(own, "Demo Mac"), { ...device(target, "Target", 1), behind: true }],
  });
  await openRemoval();
  expect(ackBox()?.parentElement?.textContent).toBe(
    "Some changes from Target haven't reached this Mac and will be lost. Remove it anyway.",
  );
});

it("shows why a removal cannot start inside the dialog, never asking the host", async () => {
  for (const [evidence, text] of [
    [{ historyPending: true }, "still checking this profile's device history"],
    [{ overflow: true }, "needs a repair before a device can be removed"],
    [{ writeAdmission: "own-tail-uncertain" }, "Changes on this Mac are paused"],
  ] as const) {
    const bridge = revokeBridge();
    bindings.bridge = bridge;
    bindings.list = deviceList({
      evidence: {
        historyPending: false,
        overflow: false,
        authorityUncertain: false,
        writeAdmission: "ready",
        ...evidence,
      },
    });
    await openRemoval();
    expect(dialog()?.textContent).toContain(text);
    expect(button("Remove and change the key")).toBeUndefined();
    expect(phrase()).toBeNull();
    expect(bridge.revokePreview).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(text);
    // The note replaces the button row: only "Close".
    expect(dialogButtons()).toEqual(["Close"]);
    await clickInDialog("Close");
  }
});

it("keeps the first answer unticked with the capacity note when every kept device does not fit", async () => {
  const revokePreview = vi.fn(async (input: { recertify: string[] }) =>
    input.recertify.length > 0
      ? { kind: "refused" as const, code: "recertify_capacity" as const }
      : prepared(false),
  );
  bindings.bridge = revokeBridge({ revokePreview });
  bindings.list = deviceList();
  await openRemoval();
  expect(dialog()?.querySelector<HTMLInputElement>("fieldset input")?.checked).toBe(false);
  expect(dialog()?.textContent).toContain("cashU can't keep every device you ticked.");
  expect(phrase()).not.toBeNull();
});

it("reattaches an unknown removal after a remount, in the dialog, and inspects the same id", async () => {
  const operationId = "1".repeat(26);
  bindings.list = deviceList();
  let finishCommit: ((value: { kind: "outcome_unknown"; operationId: string }) => void) | undefined;
  const revokeInspect = vi.fn(async () => ({ kind: "completed" as const, operationId }));
  bindings.bridge = revokeBridge({
    revokePreview: vi.fn(async () => ({ ...prepared(false, { affected: [] }), operationId })),
    revokeCommit: vi.fn(
      () =>
        new Promise<{ kind: "outcome_unknown"; operationId: string }>((resolve) => {
          finishCommit = resolve;
        }),
    ),
    revokeInspect,
  });
  await openRemoval();
  await act(async () => ackBox()?.click());
  await type(phrase() as HTMLInputElement, "synthetic recovery words for the test");
  await click("Remove and change the key");
  bindings.connection = "offline";
  await render();
  await act(async () => finishCommit?.({ kind: "outcome_unknown", operationId }));
  await act(async () => root.unmount());
  root = createRoot(container);
  // The host now records the removal as possibly appended and pushes that.
  bindings.list = deviceList({ operations: [{ operationId, phase: "may_append" }] });
  bindings.connection = "online";
  await render();
  expect(dialog()?.textContent).toContain("It isn't known yet whether the removal finished.");
  expect(container.textContent).not.toContain("It isn't known yet");
  await click("Check outcome");
  expect(revokeInspect).toHaveBeenCalledWith({ vault: bindings.vault, operationId });
  expect(dialog()).toBeNull();
});

it("drops the words before a vault change reaches the View and cancels a late preview", async () => {
  bindings.list = deviceList();
  let finishPreview: ((value: ReturnType<typeof prepared>) => void) | undefined;
  const bridge = revokeBridge({
    revokePreview: vi.fn(
      () =>
        new Promise<ReturnType<typeof prepared>>((resolve) => {
          finishPreview = resolve;
        }),
    ),
  });
  bindings.bridge = bridge;
  await openRemoval();
  const originalVault = bindings.vault;
  bindings.vault = "f".repeat(32);
  await act(async () => {
    flushSync(() => root.render(<DevicesScreen />));
    expect(phrase()).toBeNull();
  });
  await act(async () => finishPreview?.({ ...prepared(false), vault: originalVault }));
  expect(bridge.revokeCancel).toHaveBeenCalledWith({ vault: originalVault, token });
  expect(phrase()).toBeNull();
  expect(bridge.revokeCommit).not.toHaveBeenCalled();
});

/** The host's relay status for a profile with sync on (`overrides` on top). */
const relayOn = (overrides: Record<string, unknown> = {}) => ({
  configured: true,
  enabled: true,
  devices: 2,
  identityLost: false,
  canReconnect: false,
  ...overrides,
});

it("while this Mac's fetch is paused, tags it, explains the bound and asks before keeping on", async () => {
  const keepFetching = vi.fn(async () => ({ kind: "done" as const }));
  vi.stubGlobal("cashuRelay", {
    status: vi.fn(async () => relayOn({ pausedSince: Date.now() - 8 * DAY })),
    keepFetching,
  });
  bindings.list = deviceList({
    leader: { ...leaderOk, paused: "offline_too_long", pausedPeer: target },
    devices: [device(own, "Demo Mac"), device(target, "Mac mini", 1)],
  });
  bindings.bridge = {};
  await render();
  const mine = rowOf("Demo Mac")?.textContent ?? "";
  expect(mine).toContain("Fetch paused");
  expect(mine).not.toContain("Fetches bank data");
  expect(container.querySelector('[role="alert"] > p')?.textContent).toBe(
    "Bank fetch paused: this Mac hasn't heard from your other Mac for 7 days, so it can't be sure only one Mac fetches. Reconnect sync, or keep fetching on this Mac.",
  );
  expect(button("Fetch bank data on this Mac")).toBeUndefined();
  await click("Keep fetching on this Mac");
  expect(dialog()?.getAttribute("aria-label")).toBe("Keep fetching on this Mac?");
  // The body does not ask the title's question again; the other Mac's name stands alone.
  const body = dialog()?.querySelector("p")?.textContent;
  expect(body).toBe(
    "Mac mini hasn't reported for 7 days. If it is still running, both Macs may fetch once; duplicate transactions are filtered out.",
  );
  expect(dialogButtons()).toEqual(["Cancel", "Keep fetching"]);
  // The primary button takes the focus.
  expect(document.activeElement?.textContent).toBe("Keep fetching");
  await clickInDialog("Cancel");
  expect(keepFetching).not.toHaveBeenCalled();
  await click("Keep fetching on this Mac");
  await clickInDialog("Keep fetching");
  expect(keepFetching).toHaveBeenCalledWith({ vault: bindings.vault });
  setLanguageForTests("pl");
  await render();
  expect(rowOf("Demo Mac")?.textContent).toContain("Pobieranie wstrzymane");
});

it("offers 'Pair a phone' only with a sync config, and 'Go to sync' focuses the Sync switch", async () => {
  bindings.list = deviceList();
  await render();
  // No sync config on this host: no Sync card, so pairing would be a dead end.
  expect(button("Pair a phone")).toBeUndefined();
  vi.stubGlobal("cashuRelay", { status: vi.fn(async () => relayOn()) });
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(button("Pair a phone")).toBeDefined();
  // The paused banner's "Go to sync" (the same move as the pairing dialog's) lands on the switch.
  bindings.list = deviceList({
    leader: { ...leaderOk, paused: "offline_too_long", pausedPeer: target },
  });
  await render();
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  try {
    await click("Go to sync");
  } finally {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
  expect(scrolled).toHaveBeenCalled();
  expect(document.activeElement?.getAttribute("role")).toBe("switch");
});

it("replaces the button row of a failed step with Close and 'Try again', which re-runs that step", async () => {
  // Dialog R: the preview fails once, then succeeds.
  const revokePreview = vi
    .fn()
    .mockRejectedValueOnce(new Error("host away"))
    .mockImplementation(async () => prepared(false, { affected: [] }));
  bindings.bridge = revokeBridge({ revokePreview });
  bindings.list = deviceList();
  await openRemoval();
  expect(dialog()?.textContent).toContain("That didn't finish. Try again.");
  expect(dialogButtons()).toEqual(["Close", "Try again"]);
  expect(phrase()).toBeNull();
  await clickInDialog("Try again");
  expect(revokePreview).toHaveBeenCalledTimes(2);
  expect(revokePreview.mock.calls[1]?.[0]).toEqual(revokePreview.mock.calls[0]?.[0]);
  expect(phrase()).not.toBeNull();
  expect(dialogButtons()).toEqual(["Cancel", "Remove and change the key"]);
  await clickInDialog("Cancel");
  // Dialog F: the host refuses the change once, then prepares it.
  const leaderPreview = vi
    .fn()
    .mockResolvedValueOnce({ kind: "refused", code: "busy" })
    .mockImplementation(async () => leaderPrepared("4".repeat(26)));
  const leaderCommit = vi.fn(async () => ({
    kind: "completed" as const,
    operationId: "4".repeat(26),
  }));
  bindings.bridge = { leaderPreview, leaderCommit };
  bindings.list = silentList();
  await render();
  await act(async () => (await menu("Demo Mac"))[0]?.click());
  // Its primary button has the focus on open.
  expect(document.activeElement?.textContent).toBe("Fetch on this Mac");
  await clickInDialog("Fetch on this Mac");
  expect(dialog()?.textContent).toContain("That didn't finish. Try again.");
  expect(dialogButtons()).toEqual(["Close", "Try again"]);
  await clickInDialog("Try again");
  expect(leaderPreview).toHaveBeenCalledTimes(2);
  expect(leaderPreview.mock.calls[1]?.[0]).toEqual(leaderPreview.mock.calls[0]?.[0]);
  expect(leaderCommit).toHaveBeenCalledTimes(1);
  expect(dialog()).toBeNull();
});

it("keeps the last list through a host handover and reveals 'unavailable' only after 3 s, without a timer", async () => {
  bindings.list = deviceList();
  await render();
  const message = () =>
    [...container.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("Device management is unavailable."),
    );
  expect(message()).toBeUndefined();
  bindings.connection = "offline";
  await render();
  expect(rowNames()).toEqual(["Demo Mac", "Target"]);
  expect(rowOf("Target")?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.disabled).toBe(
    true,
  );
  expect(message()?.className).toContain("3s");
  bindings.connection = "recovered";
  bindings.list = { kind: "refused", code: "unavailable" };
  await render();
  expect(rowNames()).toEqual(["Demo Mac", "Target"]);
  bindings.list = deviceList();
  await render();
  expect(message()).toBeUndefined();
  expect(rowOf("Target")?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.disabled).toBe(
    false,
  );
});

it("with no list ever, the message is the delayed one", async () => {
  bindings.list = { kind: "refused", code: "unavailable" };
  await render();
  const message = [...container.querySelectorAll("p")].find(
    (p) => p.textContent === "Device management is unavailable.",
  );
  expect(message?.className).toContain("3s");
});
