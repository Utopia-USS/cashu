// The navigation shell over the real synchronous store: tab header and profile sheet stories render,
// the header's data (profile, freshness, incognito) comes from the stores, the eye button and the
// profile sheet write the device store, "Remove this phone" confirms before it wipes (and does not
// navigate), the app-switcher cover follows AppState whether Hide amounts is on or off.
import { setLanguageForTests } from "@cashu/i18n";
import { dataFreshness } from "@cashu/store/budget/freshness";
import { currentVault, devicePhoneState, setDevicePhoneState } from "@cashu/store/device";
import { ProfileProvider, StoreProvider, useProfile } from "@cashu/store-react";
import { isIncognito } from "@cashu/ui-logic/core/incognito";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import type { ComponentType, ReactNode } from "react";
import { Alert, type AlertButton, AppState, type AppStateStatus, Text } from "react-native";
import { ProfileSheetView } from "../screens/profile/ProfileSheetView";
import profileMeta, {
  IncognitoOn,
  LockOn,
  LockTouchId,
  LockUnavailable,
  Owner as OwnerSheet,
  Partner as PartnerSheet,
  ProposalsWaiting,
  Release,
  SwitchFailed,
} from "../screens/profile/ProfileSheetView.stories";
import { useProfileSheet } from "../screens/profile/useProfileSheet";
import {
  importMoneyFacts,
  MONEY_OWN_A,
  MONEY_VAULT_B,
  type MoneyStore,
  moneyStore,
} from "../screens/testing/moneyStore";
import { ServicesProvider } from "../services/ServicesProvider";
import { AppEnv } from "./AppEnv";
import { bankFresh } from "./fresh";
import { PrivacyCover } from "./PrivacyCover";
import { TabHeader } from "./TabHeader";
import headerMeta, {
  Incognito,
  NoFreshness,
  Offline,
  Owner,
  Partner,
  StaleBankData,
  WithAction,
} from "./TabHeader.stories";
import { initialOf, tabsFor } from "./tabs";
import { installPhoneIncognito, lastOpenedBefore } from "./useAppEnv";
import { useTabChrome } from "./useTabChrome";

jest.mock("@expo/ui", () => require("../screens/testing/expoUiMock").default);

const closers: (() => void)[] = [];
beforeAll(() => installPhoneIncognito());
beforeEach(() => setLanguageForTests("en"));
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
  jest.restoreAllMocks();
});

function setup() {
  const fixture = moneyStore();
  closers.push(() => fixture.close());
  return fixture;
}

function Frame({ fixture, children }: { fixture: MoneyStore; children: ReactNode }) {
  return (
    <ServicesProvider services={fixture.services}>
      <StoreProvider client={fixture.client}>
        <ProfileProvider>{children}</ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}

const phoneState = (fixture: MoneyStore) =>
  devicePhoneState.run((sql, ...p) => fixture.device.read(sql, ...p), undefined);

// Every story by name: a new story must be added here (CSF named exports).
const STORIES: [string, ComponentType<never>, object, Record<string, { args: object }>][] = [
  [
    "TabHeader",
    headerMeta.component,
    headerMeta.args,
    { Owner, Partner, Incognito, StaleBankData, NoFreshness, WithAction, Offline },
  ],
  [
    "ProfileSheetView",
    profileMeta.component,
    profileMeta.args,
    {
      Owner: OwnerSheet,
      ProposalsWaiting,
      IncognitoOn,
      Partner: PartnerSheet,
      Release,
      SwitchFailed,
      LockOn,
      LockTouchId,
      LockUnavailable,
    },
  ],
];

describe.each(STORIES)("%s stories", (_view, component, base, stories) => {
  const Component = component as ComponentType<object>;
  it.each(Object.entries(stories))("%s renders", async (_name, story) => {
    await render(<Component {...base} {...story.args} />);
    expect(screen.root).toBeOnTheScreen();
  });
});

describe("tabs", () => {
  it("shows Investments only with its module", () => {
    expect(tabsFor(["budget", "assets", "investments"])).toEqual([
      "today",
      "activity",
      "investments",
      "networth",
    ]);
    expect(tabsFor(["budget", "assets", "loans"])).toEqual(["today", "activity", "networth"]);
    expect(initialOf("  anna")).toBe("A");
  });
});

function Header({ openProfile }: { openProfile: () => void }) {
  const chrome = useTabChrome({ fresh: "bank", openProfile });
  return <TabHeader {...chrome} title="Synthetic title" />;
}

describe("tab header over the real store", () => {
  it("names the profile, follows the bank freshness and opens the profile", async () => {
    const fixture = setup();
    const openProfile = jest.fn();
    await render(
      <Frame fixture={fixture}>
        <Header openProfile={openProfile} />
      </Frame>,
    );
    expect(screen.getByText("Synthetic A")).toBeOnTheScreen();
    expect(screen.getByText("S")).toBeOnTheScreen();
    expect(screen.getByText("No bank data yet")).toBeOnTheScreen();
    await act(() => {
      importMoneyFacts(fixture.a, "PLN", MONEY_OWN_A, [
        { date: "2026-10-30", amount: "-12.00", key: "synthetic-fresh" },
      ]);
    });
    const { bankDataAt } = dataFreshness.run(
      (sql, ...p) => fixture.a.store.read(sql, ...p),
      undefined,
    );
    expect(bankDataAt).not.toBeNull();
    const expected = bankFresh(bankDataAt, new Date(), "en-US");
    expect(screen.getByText(expected.text)).toBeOnTheScreen();
    await fireEvent.press(
      screen.getByRole("button", { name: "Profile Synthetic A, switch profile" }),
    );
    expect(openProfile).toHaveBeenCalledTimes(1);
  });

  it("toggles incognito in the device store, mirrors it to ui-logic and stamps the open", async () => {
    const fixture = setup();
    await render(
      <Frame fixture={fixture}>
        <AppEnv>
          <Header openProfile={() => {}} />
        </AppEnv>
      </Frame>,
    );
    expect(lastOpenedBefore()).toBeNull();
    expect(phoneState(fixture).lastOpenedAt).not.toBeNull();
    expect(isIncognito()).toBe(false);
    await fireEvent.press(screen.getByRole("button", { name: "Hide amounts" }));
    expect(phoneState(fixture).incognito).toBe(true);
    expect(isIncognito()).toBe(true);
    expect(screen.getByRole("button", { name: "Show amounts" })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Show amounts" }));
    expect(phoneState(fixture).incognito).toBe(false);
    expect(isIncognito()).toBe(false);
  });
});

describe("app-switcher cover", () => {
  // The cover is hidden from assistive technology (it only masks the snapshot).
  const hidden = { includeHiddenElements: true };
  /** Drives AppState: every listener hears the change and `currentState` reads it. */
  function appState() {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, handler) => {
      listeners.push(handler as (state: AppStateStatus) => void);
      return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
    });
    // The React Native Jest preset mocks AppState with a function here; the app reads a status.
    const original = Object.getOwnPropertyDescriptor(AppState, "currentState");
    return {
      enter(state: AppStateStatus) {
        Object.defineProperty(AppState, "currentState", { value: state, configurable: true });
        for (const listener of listeners) listener(state);
      },
      restore() {
        if (original) Object.defineProperty(AppState, "currentState", original);
      },
    };
  }

  it("covers the app while it is not active", async () => {
    const { enter, restore } = appState();
    try {
      enter("active");
      await render(<PrivacyCover />);
      expect(screen.queryByTestId("privacy-cover", hidden)).toBeNull();
      await act(() => enter("inactive"));
      expect(screen.getByTestId("privacy-cover", hidden)).toBeOnTheScreen();
      // On iOS it sits in its own window above the native sheet and modal presentations.
      expect(JSON.stringify(screen.toJSON())).toContain('"type":"RNSFullWindowOverlay"');
      expect(screen.getByText("cashU", hidden)).toBeOnTheScreen();
      await act(() => enter("background"));
      expect(screen.getByTestId("privacy-cover", hidden)).toBeOnTheScreen();
      await act(() => enter("active"));
      expect(screen.queryByTestId("privacy-cover", hidden)).toBeNull();
    } finally {
      restore();
    }
  });

  // Independent of Hide amounts by design: the app switcher is always covered.
  it.each([
    ["off", false],
    ["on", true],
  ])("covers the app with Hide amounts %s", async (_name, hide) => {
    const fixture = setup();
    fixture.device.run(setDevicePhoneState, { incognito: hide });
    const { enter, restore } = appState();
    try {
      enter("active");
      await render(
        <Frame fixture={fixture}>
          <AppEnv>
            <Text>Synthetic content</Text>
          </AppEnv>
        </Frame>,
      );
      expect(isIncognito()).toBe(hide);
      expect(screen.queryByTestId("privacy-cover", hidden)).toBeNull();
      await act(() => enter("inactive"));
      expect(screen.getByTestId("privacy-cover", hidden)).toBeOnTheScreen();
      await act(() => enter("background"));
      expect(screen.getByTestId("privacy-cover", hidden)).toBeOnTheScreen();
    } finally {
      restore();
    }
  });
});

function ProfileSheet({
  close,
  removePhone = async () => {},
}: {
  close: () => void;
  removePhone?: () => Promise<void>;
}) {
  const props = useProfileSheet({
    close,
    openDiagnostics: () => {},
    openNotifications: () => {},
    openBench: () => {},
    removePhone,
  });
  return (
    <>
      <Text testID="current-profile">{useProfile()}</Text>
      <ProfileSheetView {...props} />
    </>
  );
}

describe("profile sheet", () => {
  it("lists the device's profiles and switches the current vault", async () => {
    const fixture = setup();
    const close = jest.fn();
    await render(
      <Frame fixture={fixture}>
        <ProfileSheet close={close} />
      </Frame>,
    );
    expect(screen.getByText("Profiles and this phone")).toBeOnTheScreen();
    expect(screen.getAllByText("Budget")).toHaveLength(2);
    expect(screen.queryByText("Waiting for you on the Mac")).toBeNull();
    expect(screen.getByRole("button", { name: "Synthetic A, current profile" })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Switch to profile Synthetic B" }));
    expect(currentVault.run((sql, ...p) => fixture.device.read(sql, ...p), undefined)).toBe(
      MONEY_VAULT_B,
    );
    expect(screen.getByTestId("current-profile")).toHaveTextContent(MONEY_VAULT_B);
    // The switch dismisses every sheet itself (`useSwitchProfile`); a close after it would pop a route.
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Synthetic B, current profile" })).toBeOnTheScreen();
  });

  it("shows Diagnostics and Bench only in a dev build", async () => {
    const Sheet = profileMeta.component;
    const view = await render(<Sheet {...profileMeta.args} />);
    expect(screen.getByText("Diagnostics")).toBeOnTheScreen();
    expect(screen.getByText("Bench")).toBeOnTheScreen();
    await view.rerender(<Sheet {...profileMeta.args} {...Release.args} />);
    expect(screen.queryByText("Diagnostics")).toBeNull();
    expect(screen.queryByText("Bench")).toBeNull();
  });

  it("closes from the icon button named by its label", async () => {
    const Sheet = profileMeta.component;
    const onClose = jest.fn();
    await render(<Sheet {...profileMeta.args} onClose={onClose} />);
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks before removing this phone, and on Remove wipes without navigating", async () => {
    const fixture = setup();
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const close = jest.fn();
    const removePhone = jest.fn(async () => {});
    await render(
      <Frame fixture={fixture}>
        <ProfileSheet close={close} removePhone={removePhone} />
      </Frame>,
    );
    expect(screen.getByText("This iPhone")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: /Remove this phone/ }));
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, body, buttons = []] = alert.mock.calls[0] ?? [];
    expect(title).toBe("Remove this phone?");
    expect(body).toBe(
      "The copy of your profiles on this phone is deleted. Your Mac keeps everything.",
    );
    expect(buttons.map((b: AlertButton) => [b.text, b.style])).toEqual([
      ["Cancel", "cancel"],
      ["Remove", "destructive"],
    ]);
    expect(removePhone).not.toHaveBeenCalled();
    buttons[0]?.onPress?.();
    expect(removePhone).not.toHaveBeenCalled();
    await act(async () => buttons[1]?.onPress?.());
    // The wipe's remount closes the sheet; a close here would reach a navigator that is gone.
    expect(close).not.toHaveBeenCalled();
    expect(removePhone).toHaveBeenCalledTimes(1);
  });

  it("says so when the wipe failed", async () => {
    const fixture = setup();
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    await render(
      <Frame fixture={fixture}>
        <ProfileSheet close={() => {}} removePhone={() => Promise.reject(new Error("synthetic"))} />
      </Frame>,
    );
    await fireEvent.press(screen.getByRole("button", { name: /Remove this phone/ }));
    const buttons = alert.mock.calls[0]?.[2] ?? [];
    await act(async () => buttons[1]?.onPress?.());
    expect(alert).toHaveBeenLastCalledWith("Could not delete everything on this phone. Try again.");
  });

  it("toggles incognito from the sheet", async () => {
    const fixture = setup();
    await render(
      <Frame fixture={fixture}>
        <ProfileSheet close={() => {}} />
      </Frame>,
    );
    await fireEvent(screen.getByRole("switch", { name: "Hide amounts" }), "accessibilityAction", {
      nativeEvent: { actionName: "activate" },
    });
    expect(phoneState(fixture).incognito).toBe(true);
    expect(screen.getByRole("switch", { name: "Hide amounts" })).toBeChecked();
  });
});
