// @vitest-environment jsdom
import { act, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useSettingsScreen } from "./useSettingsScreen.js";

const testState = vi.hoisted(() => ({
  vault: "a".repeat(32),
  connectorRun: vi.fn(),
}));
vi.mock("@cashu/store-react", () => ({
  useProfile: () => testState.vault,
  useQuery: (query: { id: string }) => {
    switch (query.id) {
      case "core.profile":
        return { name: "Synthetic", baseCurrency: "PLN", mcpPrivacy: false };
      case "overview.moduleStates":
        return [];
      case "device.settings.mcpAudit":
        return { calls: [], count7d: 0, hidden: false };
      case "device.settings.connectorActivity":
        return { runs: [], bindings: [] };
      // The live connector list is a vault query: each profile reads its own.
      case "core.settings.connectorSettings":
        return {
          connectors: [
            testState.vault === "a".repeat(32)
              ? { id: "old", name: "Old profile connector" }
              : { id: "new", name: "Current profile connector" },
          ],
          accounts: [],
          bindings: [],
        };
      case "device.settings.hostInfo":
      case "device.updateStatus":
        return { availability: "unavailable" };
      case "device.preferences":
        return { theme: null, languagePin: null, updatesAuto: null };
      case "core.desktop.proposals":
        return [];
      default:
        return query.id.includes("module") ? [] : null;
    }
  },
  useUiAction: (action: { id: string }) => ({
    run:
      action.id === "core.settings.connectors"
        ? testState.connectorRun
        : async () => ({ status: "refused" }),
    isPending: false,
  }),
  useCommand: () => ({
    run: async () => ({ kind: "completed" }),
    isPending: false,
    input: { safeParse: () => ({ success: true }) },
  }),
}));
vi.mock("@cashu/ui", () => ({ useUiEnv: () => ({ privacy: false }) }));
vi.mock("../useDurableCommand.js", () => ({
  useDurableCommands: () => ({ run: async () => ({ kind: "completed" }), uncertain: () => false }),
  commandFailure: () => "failed",
}));
vi.mock("../../notificationBridge.js", () => ({
  onNotificationPermission: () => () => {},
  readNotificationPermission: async () => "unavailable",
  requestNotificationPermission: async () => "unavailable",
}));
vi.mock("../../serviceBridge.js", () => ({
  createServiceStatusCoordinator: () => ({
    load: async () => {},
    pushed: () => {},
    invalidate: () => {},
    busy: false,
  }),
  onServiceStatus: () => () => {},
}));

function Probe({ onState }: { onState: (value: ReturnType<typeof useSettingsScreen>) => void }) {
  const screen = useSettingsScreen(
    () => {},
    () => {},
  );
  useEffect(() => onState(screen), [onState, screen]);
  return <div>{screen.connectorSnapshot?.connectors[0]?.name ?? "empty"}</div>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  testState.connectorRun.mockReset();
  testState.vault = "a".repeat(32);
});

it("shows each profile's live connector list and an old vault's slow action never makes the new one busy", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let finishOld!: (result: unknown) => void;
  const oldResult = new Promise((resolve) => {
    finishOld = resolve;
  });
  testState.connectorRun.mockImplementation(() =>
    testState.vault === "a".repeat(32) ? oldResult : Promise.resolve({ status: "completed" }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let screen!: ReturnType<typeof useSettingsScreen>;
  const onState = (value: ReturnType<typeof useSettingsScreen>) => {
    screen = value;
  };
  try {
    await act(async () => root.render(<Probe onState={onState} />));
    expect(container.textContent).toBe("Old profile connector");
    await act(async () => {
      void screen.onConnectorAction({ op: "disable", id: "old" });
    });
    expect(testState.connectorRun).toHaveBeenCalledWith({ op: "disable", id: "old" });
    expect(screen.connectorBusy).toBe(true);
    testState.vault = "b".repeat(32);
    await act(async () => {
      flushSync(() => root.render(<Probe onState={onState} />));
    });
    expect(container.textContent).toBe("Current profile connector");
    expect(screen.connectorBusy).toBe(false);
    await act(async () => finishOld({ status: "completed" }));
    expect(screen.connectorBusy).toBe(false);
    // Nothing reads the list through the action any more.
    expect(testState.connectorRun.mock.calls.every(([input]) => input.op !== "list")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
