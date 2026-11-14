// A notification tap under expo-router's test router with a fake tap: it switches to the tap's profile
// and opens its screen, waits while navigation is held (the app lock) and while the start route has not
// gone on, and clears the tap only after it navigated. Synthetic data only.
import { setLanguageForTests } from "@cashu/i18n";
import { ProfileProvider, StoreProvider, useProfile } from "@cashu/store-react";
import { Slot } from "expo-router";
import { act, renderRouter, screen } from "expo-router/testing-library";
import type { ReactNode } from "react";
import { Text } from "react-native";
import { MONEY_VAULT_A, MONEY_VAULT_B, moneyStore } from "../screens/testing/moneyStore";
import { ServicesProvider } from "../services/ServicesProvider";
import { holdNavigation } from "../shell/navigationHold";
import { useNotificationResponse } from "./useNotificationResponse";

/** The platform half replaced by a tap the test sets (no expo-notifications in Jest). */
jest.mock("../platform/notifications", () => {
  const { useSyncExternalStore } = require("react");
  let tap: { key: string; data: Record<string, string> } | null = null;
  const listeners = new Set<() => void>();
  const set = (next: typeof tap) => {
    tap = next;
    for (const listener of listeners) listener();
  };
  return {
    useNotificationTap: () =>
      useSyncExternalStore(
        (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => tap,
      ),
    clearNotificationTap: jest.fn(() => set(null)),
    mockSetTap: set,
  };
});

const platform = jest.requireMock("../platform/notifications") as {
  clearNotificationTap: jest.Mock;
  mockSetTap(tap: { key: string; data: Record<string, string> } | null): void;
};

function Taps() {
  useNotificationResponse();
  return <Text>{`profile ${useProfile()}`}</Text>;
}

const routes = {
  _layout: () => (
    <>
      <Taps />
      <Slot />
    </>
  ),
  index: () => <Text>start</Text>,
  "(tabs)/today/index": () => <Text>today</Text>,
  "(tabs)/today/closed": () => <Text>closed</Text>,
  "(tabs)/investments/index": () => <Text>investments</Text>,
  "sheet/profile": () => <Text>profile sheet</Text>,
};

async function show(initialUrl: string) {
  const fixture = moneyStore();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesProvider services={fixture.services}>
      <StoreProvider client={fixture.client}>
        <ProfileProvider>{children}</ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
  await renderRouter(routes, { initialUrl, wrapper });
  return fixture;
}

const tap = (vault: string, kind: string, extra: Record<string, string> = {}) =>
  act(async () => {
    platform.mockSetTap({ key: `cashu.${vault}.${kind}@1`, data: { vault, kind, ...extra } });
  });

const releases: (() => void)[] = [];
beforeEach(() => {
  setLanguageForTests("en");
  platform.clearNotificationTap.mockClear();
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
  platform.mockSetTap(null);
});

it("switches to the tap's profile, opens its screen and clears the tap after", async () => {
  const fixture = await show("/today");
  expect(screen.getByText(`profile ${MONEY_VAULT_A}`)).toBeOnTheScreen();
  await tap(MONEY_VAULT_B, "month_closed", { month: "2026-10" });
  expect(screen.getByText(`profile ${MONEY_VAULT_B}`)).toBeOnTheScreen();
  expect(screen).toHavePathname("/today/closed");
  expect(platform.clearNotificationTap).toHaveBeenCalledTimes(1);
  fixture.close();
});

it("waits while navigation is held and opens the screen once it is free", async () => {
  const fixture = await show("/today");
  let release: () => void = () => undefined;
  await act(async () => {
    release = holdNavigation("lock");
  });
  releases.push(release);
  await tap(MONEY_VAULT_A, "device_change");
  expect(screen).toHavePathname("/today");
  expect(platform.clearNotificationTap).not.toHaveBeenCalled();
  await act(async () => {
    release();
  });
  expect(screen).toHavePathname("/sheet/profile");
  expect(platform.clearNotificationTap).toHaveBeenCalledTimes(1);
  fixture.close();
});

it("keeps a cold start's tap until the start route has gone on", async () => {
  const fixture = await show("/");
  await tap(MONEY_VAULT_A, "alerts_fired");
  expect(screen.getByText("start")).toBeOnTheScreen();
  expect(platform.clearNotificationTap).not.toHaveBeenCalled();
  // The start route's redirect to Today.
  await act(async () => {
    const { router } = require("expo-router") as typeof import("expo-router");
    router.replace("/today");
  });
  expect(screen).toHavePathname("/investments");
  expect(platform.clearNotificationTap).toHaveBeenCalledTimes(1);
  fixture.close();
});

it("drops a tap for a profile this phone no longer holds, and clears it", async () => {
  const fixture = await show("/today");
  await tap("c3000000000000000000000000000003", "weekly");
  expect(screen).toHavePathname("/today");
  expect(platform.clearNotificationTap).toHaveBeenCalledTimes(1);
  fixture.close();
});
