// @vitest-environment jsdom
import type { RelayStatusResult } from "@cashu/host-protocol";
import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SyncRowView } from "./SyncRowView.js";
import { useSyncRow } from "./useSyncRow.js";

const bindings = vi.hoisted(() => ({
  vault: "a".repeat(32),
  bridge: null as unknown,
  /** One snapshot, as the live query keeps its reference until the host pushes again. */
  list: { status: "unavailable" },
}));
vi.mock("@cashu/store-react", () => ({
  useProfile: () => bindings.vault,
  useConnection: () => "online",
  useQuery: () => bindings.list,
}));
vi.mock("./relayBridge.js", () => ({ relayBridge: () => bindings.bridge }));

function Harness() {
  return <SyncRowView state={useSyncRow().state} />;
}

const healthy: RelayStatusResult = {
  configured: true,
  enabled: true,
  devices: 3,
  // Today 10:12 (local), so the line reads "Synced at 10:12" whatever the time of the run.
  lastSyncAt: new Date(new Date().setHours(0, 0, 0, 0)).getTime() + (10 * 60 + 12) * 60_000,
  identityLost: false,
  canReconnect: false,
};

async function mount(bridge: Record<string, unknown>) {
  bindings.bridge = bridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));
  return {
    container,
    button: (label: string) =>
      [...document.querySelectorAll("button")].find((node) => node.textContent === label),
    /** A host push: a new device list snapshot (the host checked the vault again). */
    async push() {
      bindings.list = { status: "unavailable" };
      await act(async () => root.render(<Harness />));
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLanguageForTests("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
  bindings.bridge = null;
});

it("hides the whole row without a sync config", async () => {
  const view = await mount({ status: vi.fn(async () => ({ ...healthy, configured: false })) });
  try {
    expect(view.container.textContent).toBe("");
  } finally {
    await view.close();
  }
});

it("shows the switch, the details line and one status line, never the word relay", async () => {
  const view = await mount({ status: vi.fn(async () => healthy) });
  try {
    const text = view.container.textContent ?? "";
    expect(text).toContain("Through Google Firebase, end-to-end encrypted");
    expect(text).toContain("Synced at 10:12 · 3 devices");
    expect(text.toLowerCase()).not.toContain("relay");
    expect(view.container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe(
      "true",
    );
  } finally {
    await view.close();
  }
});

it("purges only after the confirm and offers to run an unfinished purge again", async () => {
  const purge = vi
    .fn()
    .mockResolvedValueOnce({ kind: "refused", reason: "retry" })
    .mockResolvedValueOnce({ kind: "done" });
  const view = await mount({ status: vi.fn(async () => healthy), purge });
  try {
    await act(async () => view.button("Remove from sync")?.click());
    expect(purge).not.toHaveBeenCalled();
    await act(async () => view.button("Yes, remove")?.click());
    expect(purge).toHaveBeenCalledWith({ vault: bindings.vault });
    expect(view.container.textContent).toContain("did not finish");
    await act(async () => view.button("Try again")?.click());
    expect(purge).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain("This profile's data was removed from sync.");
  } finally {
    await view.close();
  }
});

it("offers Reconnect sync after an identity loss and reads the status again", async () => {
  const status = vi
    .fn()
    .mockResolvedValueOnce({ ...healthy, identityLost: true, canReconnect: true })
    .mockResolvedValue(healthy);
  const reconnect = vi.fn(async () => ({ kind: "done" as const }));
  const view = await mount({ status, reconnect });
  try {
    await act(async () => view.button("Reconnect sync")?.click());
    expect(reconnect).toHaveBeenCalledWith({ vault: bindings.vault });
    expect(view.button("Reconnect sync")).toBeUndefined();
    expect(view.container.textContent).toContain("Synced");
  } finally {
    await view.close();
  }
});

it("says a removed device can still receive data and tries again on Try now", async () => {
  const failing = { devices: 1, since: Date.now() - 60_000, ids: ["c".repeat(32)] };
  const status = vi
    .fn()
    .mockResolvedValueOnce({ ...healthy, removalsFailing: failing })
    .mockResolvedValue(healthy);
  const syncNow = vi.fn(async () => ({ kind: "done" as const }));
  const view = await mount({ status, syncNow });
  try {
    // No device list here: the device-less subject, never the id.
    expect(view.container.textContent).toContain(
      "A removed device is removed on this Mac, but sync hasn't confirmed it yet",
    );
    expect(view.container.textContent).not.toContain("c".repeat(32));
    await act(async () => view.button("Try now")?.click());
    expect(syncNow).toHaveBeenCalledWith({ vault: bindings.vault });
    expect(view.button("Try now")).toBeUndefined();
    expect(view.container.textContent).toContain("Synced at 10:12");
  } finally {
    await view.close();
  }
});

it("keeps the purge result and the switch off when the host pushes the device list mid-purge", async () => {
  let finish!: (result: { kind: "done" }) => void;
  const purge = vi.fn(
    () =>
      new Promise<{ kind: "done" }>((resolve) => {
        finish = resolve;
      }),
  );
  let purged = false;
  const status = vi.fn(async () => (purged ? { ...healthy, enabled: false, devices: 1 } : healthy));
  const view = await mount({ status, purge });
  try {
    await act(async () => view.button("Remove from sync")?.click());
    await act(async () => view.button("Yes, remove")?.click());
    expect(purge).toHaveBeenCalledWith({ vault: bindings.vault });
    // The purge writes the switch off: the host re-checks the vault and pushes the list before it replies.
    purged = true;
    await view.push();
    await act(async () => finish({ kind: "done" }));
    expect(view.container.textContent).toContain("This profile's data was removed from sync.");
    const toggle = view.container.querySelector('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    // Not stuck busy: the switch takes input again.
    expect(
      toggle?.hasAttribute("disabled") || toggle?.getAttribute("aria-disabled") === "true",
    ).toBe(false);
  } finally {
    await view.close();
  }
});
