// The profile sheet of a paired phone over the real synchronous store (QA run 2, Observations 2, 3, 5):
// the profile's name is the one its vault holds now (not the "New profile" the services read before the
// first sync), the lock screen agrees, and the current profile's sync shows here too: the paused line
// after a pass that could not reach sync, and the sync-off notice after a pass the relay refused.
// Synthetic data only.
import { setLanguageForTests } from "@cashu/i18n";
import { setDeviceLock } from "@cashu/store/device";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import { cleanup, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AppState } from "react-native";
import { ServicesProvider } from "../../services/ServicesProvider";
import type { Services } from "../../services/services";
import type { VaultSyncStatus } from "../../services/vaultEngine";
import { LockGate } from "../../shell/LockGate";
import { MONEY_VAULT_A, moneyStore } from "../testing/moneyStore";
import { ProfileSheetView } from "./ProfileSheetView";
import { useProfileSheet } from "./useProfileSheet";

jest.mock("@expo/ui", () => require("../testing/expoUiMock").default);

const closers: (() => void)[] = [];
let restoreAppState: () => void = () => {};
beforeEach(() => {
  setLanguageForTests("en");
  const original = Object.getOwnPropertyDescriptor(AppState, "currentState");
  Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
  restoreAppState = () => {
    if (original) Object.defineProperty(AppState, "currentState", original);
  };
});
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
  restoreAppState();
});

/** 19:50 local time on the day of the QA run. */
const PAUSED_AT = new Date(2026, 10, 14, 19, 50).getTime();

/**
 * A paired phone right after the first sync: the services read "New profile" at boot (before the
 * profile arrived), the vault holds "Synthetic A" now; `status` is the current vault's sync status.
 */
function setup(status?: VaultSyncStatus, appLock?: boolean): Services {
  const fixture = moneyStore();
  closers.push(() => fixture.close());
  if (appLock !== undefined) fixture.device.run(setDeviceLock, { appLock });
  return {
    ...fixture.services,
    isDemo: false,
    profiles: fixture.services.profiles.map((p) =>
      p.vault === MONEY_VAULT_A ? { ...p, name: "New profile", slug: p.vault, modules: [] } : p,
    ),
    vaults: {
      ...fixture.services.vaults,
      unavailable: (vault) => (vault === MONEY_VAULT_A ? status : undefined),
    },
  };
}

function Frame({ services, children }: { services: Services; children: ReactNode }) {
  return (
    <ServicesProvider services={services}>
      <StoreProvider client={services.client}>
        <ProfileProvider>
          <UiEnvProvider locale="en-US" privacy={false}>
            {children}
          </UiEnvProvider>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}

function Sheet() {
  const state = useProfileSheet({
    close: () => {},
    openNotifications: () => {},
    openDiagnostics: () => {},
    openBench: () => {},
    removePhone: async () => {},
    removeCopy: async () => {},
  });
  return <ProfileSheetView {...state} />;
}

const base: VaultSyncStatus = {
  vault: MONEY_VAULT_A,
  phase: "ready",
  syncing: false,
  remote: true,
  unpushed: false,
};

it("names the profile as its vault holds it now, in the sheet and on the lock screen", async () => {
  const services = setup(base, true);
  await render(
    <Frame services={services}>
      <LockGate>
        <Sheet />
      </LockGate>
    </Frame>,
  );
  expect(screen.getByText("Synthetic A", { includeHiddenElements: true })).toBeOnTheScreen();
  expect(screen.queryByText("New profile", { includeHiddenElements: true })).toBeNull();
  // The lock screen's avatar: the profile's initial, not the placeholder's "N".
  expect(screen.getByTestId("lock-screen")).toBeOnTheScreen();
  expect(screen.queryByText("N", { includeHiddenElements: true })).toBeNull();
});

it("shows the paused line after a pass that could not reach sync", async () => {
  const services = setup({
    ...base,
    failure: "relay_unreachable",
    relay: { lastOk: PAUSED_AT, lastError: "unavailable", lastErrorAt: PAUSED_AT + 60_000 },
  });
  await render(
    <Frame services={services}>
      <Sheet />
    </Frame>,
  );
  expect(screen.getByText("Sync paused since 19:50 · cashU works as usual")).toBeOnTheScreen();
});

it("shows the sync-off notice after a pass the relay refused", async () => {
  const services = setup({
    ...base,
    failure: "relay_unreachable",
    relay: { lastOk: PAUSED_AT, lastError: "forbidden", lastErrorAt: PAUSED_AT + 60_000 },
  });
  await render(
    <Frame services={services}>
      <Sheet />
    </Frame>,
  );
  expect(
    screen.getByText(
      "Sync for Synthetic A was turned off on your Mac. The copy on this phone stays until you remove it.",
    ),
  ).toBeOnTheScreen();
  expect(screen.getByRole("button", { name: "Remove this copy" })).toBeOnTheScreen();
});

it("writes the day this phone was added like the desktop, on a US English phone", async () => {
  const services = setup({
    ...base,
    names: {
      self: { name: "Synthetic iPhone", addedAt: new Date(2026, 10, 14, 19, 40).getTime() },
      pairedBy: { deviceId: "synthetic-mac", name: "Synthetic Mac" },
    },
  });
  await render(
    <Frame services={services}>
      <Sheet />
    </Frame>,
  );
  expect(screen.getByText("added 14 Nov 2026 by Synthetic Mac")).toBeOnTheScreen();
});
