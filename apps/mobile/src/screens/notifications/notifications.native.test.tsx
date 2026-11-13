// The notifications settings over the real synchronous stores and an in-memory scheduler: a switch
// writes the profile's choice, the permission is asked on the first open and its denied state offers
// iOS Settings, an owner with investments lists the marked alert, a partner gets the digests only; and
// every story of the View. Synthetic data only.
import { setLanguageForTests } from "@cashu/i18n";
import {
  markedAlerts,
  notificationPrefs,
  setAlertMarked,
  setCurrentVault,
} from "@cashu/store/device";
import type { Read } from "@cashu/store/query";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import type { ComponentType, ReactNode } from "react";
import { AppState } from "react-native";
import { companionMarkedAlert } from "../../fixture/companionInvestments";
import { onReplanRequested } from "../../notifications/replan";
import { type MemoryScheduler, memoryScheduler } from "../../notifications/testing/memoryScheduler";
import { ServicesProvider } from "../../services/ServicesProvider";
import type { Services } from "../../services/services";
import { ProfileSheetView } from "../profile/ProfileSheetView";
import profileMeta, { NotificationsOff } from "../profile/ProfileSheetView.stories";
import { investmentsStore } from "../testing/investmentsStore";
import { MONEY_VAULT_A, MONEY_VAULT_B, moneyStore } from "../testing/moneyStore";
import { NotificationsView } from "./NotificationsView";
import meta, {
  AllRowsAvailable,
  Denied,
  NoneMarked,
  NotAskedYet,
  Owner,
  Partner,
  PartnerWithDeviceChanges,
  Release,
} from "./NotificationsView.stories";
import { useNotificationsScreen } from "./useNotificationsScreen";

jest.mock("@expo/ui", () => require("../testing/expoUiMock").default);

const closers: (() => void)[] = [];
beforeEach(() => setLanguageForTests("en"));
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
});

function Screen(props: { scheduler: MemoryScheduler; openSettings(): void }) {
  return <NotificationsView {...useNotificationsScreen(props)} />;
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

async function show(services: Services, scheduler: MemoryScheduler) {
  const openSettings = jest.fn();
  await render(
    <Frame services={services}>
      <Screen scheduler={scheduler} openSettings={openSettings} />
    </Frame>,
  );
  // The permission read resolves after the first render.
  await act(async () => {});
  return { openSettings };
}

const deviceRead =
  (services: Services): Read =>
  (sql, ...params) =>
    services.device.read(sql, ...params);

describe("the notifications settings", () => {
  it("writes a switched choice for the current profile only", async () => {
    const fixture = moneyStore();
    closers.push(fixture.close);
    await show(fixture.services, memoryScheduler("granted"));
    expect(screen.getByRole("switch", { name: "Evening, 7:00 PM" })).not.toBeChecked();
    await fireEvent.press(screen.getByRole("switch", { name: "Evening, 7:00 PM" }));
    const read = deviceRead(fixture.services);
    expect(notificationPrefs.run(read, { vault: MONEY_VAULT_A }).evening).toBe(true);
    expect(notificationPrefs.run(read, { vault: MONEY_VAULT_B }).evening).toBe(false);
    expect(screen.getByRole("switch", { name: "Evening, 7:00 PM" })).toBeChecked();
    await fireEvent.press(screen.getByRole("switch", { name: "Sunday, 6:00 PM" }));
    expect(notificationPrefs.run(read, { vault: MONEY_VAULT_A }).weekly).toBe(false);
  });

  it("asks for the permission on the first open and re-plans once it is granted", async () => {
    const fixture = moneyStore();
    closers.push(fixture.close);
    const scheduler = memoryScheduler("undetermined");
    const replans = jest.fn();
    const off = onReplanRequested(replans);
    await show(fixture.services, scheduler);
    off();
    expect(await scheduler.permission()).toBe("granted");
    expect(replans).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Allow notifications" })).toBeNull();
  });

  it("re-plans when the permission turns granted in iOS Settings and the app comes back", async () => {
    const fixture = moneyStore();
    closers.push(fixture.close);
    const scheduler = memoryScheduler("denied");
    const replans = jest.fn();
    const off = onReplanRequested(replans);
    await show(fixture.services, scheduler);
    const returned = async () => {
      const listeners = (AppState.addEventListener as jest.Mock).mock.calls
        .filter(([event]) => event === "change")
        .map(([, listener]) => listener as (state: string) => void);
      await act(async () => {
        listeners.at(-1)?.("active");
      });
    };
    await returned();
    expect(replans).not.toHaveBeenCalled();
    scheduler.setPermission("granted");
    await returned();
    expect(replans).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Notifications are off for cashU in iOS Settings.")).toBeNull();
    await returned();
    expect(replans).toHaveBeenCalledTimes(1);
    off();
  });

  it("offers iOS Settings when notifications are denied", async () => {
    const fixture = moneyStore();
    closers.push(fixture.close);
    const { openSettings } = await show(fixture.services, memoryScheduler("denied"));
    expect(screen.getByText("Notifications are off for cashU in iOS Settings.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Open Settings" }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("shows an owner without investments no alert row and the warnings", async () => {
    const fixture = moneyStore();
    closers.push(fixture.close);
    await show(fixture.services, memoryScheduler("granted"));
    expect(screen.queryByText("When the phone next syncs")).toBeNull();
    expect(screen.getByRole("switch", { name: "Bank data is getting old" })).toBeChecked();
    expect(screen.queryByRole("switch", { name: "A bank permission ends soon" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "A device joins or leaves" })).toBeNull();
    expect(screen.getByText(/agent suggestions, streaks\.$/u)).toBeOnTheScreen();
  });

  it("gives a partner the digests only", async () => {
    const fixture = moneyStore();
    closers.push(fixture.close);
    fixture.services.device.run(setCurrentVault, { vault: MONEY_VAULT_B });
    await show(fixture.services, memoryScheduler("granted"));
    expect(
      screen
        .getAllByRole("switch")
        .flatMap((s) => (s.props.accessibilityLabel ? [s.props.accessibilityLabel] : [])),
    ).toEqual(["Sunday, 6:00 PM", "Month closed", "Evening, 7:00 PM"]);
    expect(screen.queryByText("Warnings, once")).toBeNull();
    expect(
      screen.getByText("Never sent: single payments, daily portfolio moves, market news, streaks."),
    ).toBeOnTheScreen();
  });

  it("lists an owner's marked alerts by title", async () => {
    const fixture = investmentsStore();
    closers.push(fixture.close);
    const vault = fixture.services.profiles[0]?.vault ?? "";
    const alert = companionMarkedAlert(
      (sql, ...params) => fixture.store.read(sql, ...params),
      fixture.now,
    );
    if (alert === null) throw new Error("the synthetic portfolio fired no action alert");
    await show(fixture.services, memoryScheduler("granted"));
    expect(screen.getByText("Mark an alert in its sheet")).toBeOnTheScreen();
    await act(async () => {
      fixture.services.device.run(setAlertMarked, { vault, alert, marked: true });
    });
    expect(markedAlerts.run(deviceRead(fixture.services), { vault })).toEqual([alert]);
    expect(screen.getByText("CDR -8% in 5 sessions")).toBeOnTheScreen();
    expect(screen.getByText(/review due\.$/u)).toBeOnTheScreen();
  });
});

const stories: [string, object][] = [
  ["owner", Owner.args],
  ["none marked", NoneMarked.args],
  ["partner", Partner.args],
  ["not asked yet", NotAskedYet.args],
  ["denied", Denied.args],
  ["release", Release.args],
  ["all rows available", AllRowsAvailable.args],
  ["partner with device changes", PartnerWithDeviceChanges.args],
];

it.each(stories)("renders the %s story", async (_name, args) => {
  const View = meta.component as ComponentType<object>;
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <View {...meta.args} {...args} />
    </UiEnvProvider>,
  );
  expect(screen.root).toBeOnTheScreen();
});

it("says on the profile sheet's Notifications row when iOS Settings turned them off", async () => {
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <ProfileSheetView {...profileMeta.args} {...NotificationsOff.args} />
    </UiEnvProvider>,
  );
  expect(screen.getByText("Off in iOS Settings")).toBeOnTheScreen();
});

it("never promises a partner the plan line, even with investments", async () => {
  const partnerWithInvestments = {
    ...meta.args,
    ...Partner.args,
    role: "partner" as const,
    investments: true,
  };
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <NotificationsView {...partnerWithInvestments} />
    </UiEnvProvider>,
  );
  expect(screen.getByText("What you kept.")).toBeOnTheScreen();
  expect(screen.queryByText(/what your plan says/u)).toBeNull();
});

it("shows the device and permission rows once their data exists", async () => {
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <NotificationsView {...meta.args} {...AllRowsAvailable.args} />
    </UiEnvProvider>,
  );
  expect(screen.getByRole("switch", { name: "A device joins or leaves" })).toBeDisabled();
  expect(screen.getByRole("switch", { name: "A bank permission ends soon" })).toBeOnTheScreen();
  expect(screen.getByText("7 days and 1 day before.")).toBeOnTheScreen();
});
