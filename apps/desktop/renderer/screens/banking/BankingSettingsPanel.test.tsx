// @vitest-environment jsdom
import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BankingSettingsPanel } from "./BankingSettingsPanel.js";
import { syntheticBankingPort } from "./BankingView.stories.js";
import type { BankingAction } from "./useBankingScreen.js";

// The panel as routes.tsx mounts it: the live device list and the host's UI action are synthetic, the
// paused-fetch hook, the banner and dialog F are the real ones Devices uses.
const bindings = vi.hoisted(() => ({
  vault: "a".repeat(32),
  list: null as unknown,
  run: null as unknown,
}));
const snapshot = vi.hoisted(() => ({ list: undefined as unknown, value: undefined as unknown }));
vi.mock("@cashu/store-react", () => ({
  useProfile: () => bindings.vault,
  useConnection: () => "online",
  useQuery: () => {
    // One snapshot per pushed list, as the live query keeps its reference until the host pushes again.
    if (snapshot.list !== bindings.list) snapshot.value = { status: "ready", list: bindings.list };
    snapshot.list = bindings.list;
    return snapshot.value;
  },
  useUiAction: () => ({ run: bindings.run }),
}));

const own = "b".repeat(32);
const other = "c".repeat(32);
const DAY = 86_400_000;
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
/** This Mac is the pinned fetch leader and the 7-day offline bound paused it. */
const pausedList = () => ({
  kind: "ready" as const,
  vault: bindings.vault,
  ownDevice: own,
  leader: {
    mode: "pinned",
    state: "ok",
    device: own,
    pendingFrom: null,
    lastActivityAt: Date.now() - 8 * DAY,
    silentForMs: 0,
    warn: false,
    paused: "offline_too_long",
    pausedPeer: other,
  },
  keyProvenance: { source: "own", sender: own, recipientsKnown: false },
  operations: [],
  leaderOperations: [],
  evidence: {
    historyPending: false,
    overflow: false,
    authorityUncertain: false,
    writeAdmission: "ready" as const,
  },
  devices: [device(own, "Demo Mac"), device(other, "Mac mini")],
});

let container: HTMLDivElement;
let root: Root;
let keepFetching: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLanguageForTests("en");
  // A configured Enable Banking app with one connected bank, answered like the host's UI action.
  const port = syntheticBankingPort(true);
  bindings.run = async (input: BankingAction) => {
    const reply = await port.invoke(input);
    return reply.ok
      ? { status: "completed", value: reply.value }
      : { status: "refused", reason: reply.error, preparation: "none" };
  };
  vi.stubGlobal("cashuBanking", {});
  keepFetching = vi.fn(async () => ({ kind: "done" as const }));
  vi.stubGlobal("cashuRelay", {
    status: vi.fn(async () => ({
      configured: true,
      enabled: true,
      devices: 2,
      identityLost: false,
      canReconnect: false,
      pausedSince: Date.now() - DAY,
    })),
    keepFetching,
  });
  bindings.list = pausedList();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.getElementById("set-devices")?.remove();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<BankingSettingsPanel />));
/** Dialogs render in a portal: search the whole document. */
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((node) => node.textContent === label);
const click = (label: string) => act(async () => button(label)?.click());
const dialog = () => document.body.querySelector('[role="dialog"]');

it("shows the Devices banner text for the paused bank fetch", async () => {
  await render();
  // Designer copy (DV2 item 4), the same sentence the Devices screen shows.
  expect(container.querySelector('[role="alert"] > p')?.textContent).toBe(
    "Bank fetch paused: this Mac hasn't heard from your other Mac for 7 days, so it can't be sure only one Mac fetches. Reconnect sync, or keep fetching on this Mac.",
  );
});

it("'Keep fetching on this Mac' opens dialog F and keeps fetching for this profile", async () => {
  await render();
  await click("Keep fetching on this Mac");
  expect(dialog()?.getAttribute("aria-label")).toBe("Keep fetching on this Mac?");
  expect(dialog()?.querySelector("p")?.textContent).toBe(
    "Mac mini hasn't reported for 7 days. If it is still running, both Macs may fetch once; duplicate transactions are filtered out. cashU asks again in 7 days.",
  );
  expect(keepFetching).not.toHaveBeenCalled();
  await act(async () =>
    [...(dialog()?.querySelectorAll("button") ?? [])]
      .find((node) => node.textContent === "Keep fetching")
      ?.click(),
  );
  expect(keepFetching).toHaveBeenCalledWith({ vault: bindings.vault });
});

it("the secondary action opens Settings > Devices instead of 'Go to sync'", async () => {
  const section = document.createElement("section");
  section.id = "set-devices";
  section.scrollIntoView = vi.fn();
  const first = document.createElement("button");
  first.textContent = "Pair a phone";
  section.append(first);
  document.body.append(section);
  await render();
  expect(button("Go to sync")).toBeUndefined();
  await click("Open Devices");
  expect(section.scrollIntoView).toHaveBeenCalled();
  expect(document.activeElement).toBe(first);
});
