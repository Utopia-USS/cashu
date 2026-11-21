// The app lock over the real synchronous store with a scripted authenticator: locked at boot when on,
// the automatic prompt, unlock, the failed and unavailable notes, the Unlock button, off by setting or
// by the demo default, locking again after the background timeout but not after an inactive spell,
// and the profile sheet's switch checking the owner before it writes. While locked: navigation is held
// (a deep link opens nothing and is replayed after the unlock), the app underneath is hidden from
// VoiceOver, and a route change re-attaches the overlay on top. Lock screen stories render.
import { setLanguageForTests } from "@cashu/i18n";
import { deviceLock, setDeviceLock } from "@cashu/store/device";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { router, Slot } from "expo-router";
import { renderRouter } from "expo-router/testing-library";
import type { ComponentType, ReactNode } from "react";
import { AppState, type AppStateStatus, Text } from "react-native";
import { ProfileSheetView } from "../screens/profile/ProfileSheetView";
import { useProfileSheet } from "../screens/profile/useProfileSheet";
import { type MoneyStore, moneyStore } from "../screens/testing/moneyStore";
import { ServicesProvider } from "../services/ServicesProvider";
import type { Services } from "../services/services";
import { AppEnv } from "./AppEnv";
import type { AuthResult } from "./auth";
import { redirectSystemLink, takePendingLink } from "./heldLinks";
import { LockGate } from "./LockGate";
import lockMeta, { Failed, Locked, NoProfile, Unavailable } from "./LockScreenView.stories";
import { LOCK_AFTER_MS } from "./lockState";
import { isNavigationHeld } from "./navigationHold";
import { type MemoryAuthenticator, memoryAuthenticator } from "./testing/auth";
import { installPhoneIncognito } from "./useAppEnv";

jest.mock("@expo/ui", () => require("../screens/testing/expoUiMock").default);

const closers: (() => void)[] = [];
let restoreAppState: () => void = () => {};
beforeAll(() => installPhoneIncognito());
beforeEach(() => setLanguageForTests("en"));
afterEach(() => {
  cleanup();
  takePendingLink();
  for (const close of closers.splice(0)) close();
  restoreAppState();
  jest.restoreAllMocks();
});

/** Drives AppState: every listener hears the change and `currentState` reads it. */
function appState(initial: AppStateStatus) {
  const listeners: ((state: AppStateStatus) => void)[] = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, handler) => {
    listeners.push(handler as (state: AppStateStatus) => void);
    return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
  });
  // The React Native Jest preset mocks AppState with a function here; the app reads a status.
  const original = Object.getOwnPropertyDescriptor(AppState, "currentState");
  const set = (state: AppStateStatus) =>
    Object.defineProperty(AppState, "currentState", { value: state, configurable: true });
  set(initial);
  restoreAppState = () => {
    if (original) Object.defineProperty(AppState, "currentState", original);
  };
  return (state: AppStateStatus) => {
    set(state);
    for (const listener of listeners) listener(state);
  };
}

function setup(options: { appLock?: boolean; isDemo?: boolean; auth?: MemoryAuthenticator }) {
  const fixture = moneyStore();
  closers.push(() => fixture.close());
  if (options.appLock !== undefined)
    fixture.device.run(setDeviceLock, { appLock: options.appLock });
  const auth = options.auth ?? memoryAuthenticator();
  const services: Services = {
    ...fixture.services,
    auth,
    isDemo: options.isDemo ?? true,
  };
  return { fixture, services, auth };
}

function Frame({ services, children }: { services: Services; children: ReactNode }) {
  return (
    <ServicesProvider services={services}>
      <StoreProvider client={services.client}>
        <ProfileProvider>{children}</ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}

async function renderGate(services: Services) {
  await render(
    <Frame services={services}>
      <LockGate>
        <Text>Synthetic content</Text>
      </LockGate>
    </Frame>,
  );
}

const lockScreen = () => screen.queryByTestId("lock-screen");

/** A prompt that stays open until the test answers it. */
function pending() {
  let answer: (result: AuthResult) => void = () => {};
  const result = new Promise<AuthResult>((resolve) => {
    answer = resolve;
  });
  return { result, answer };
}

describe("lock screen stories", () => {
  const stories = { Locked, Failed, Unavailable, NoProfile };
  const Component = lockMeta.component as ComponentType<object>;
  it.each(Object.entries(stories))("%s renders", async (_name, story) => {
    await render(<Component {...lockMeta.args} {...story.args} />);
    expect(screen.getByRole("button", { name: "Unlock" })).toBeOnTheScreen();
  });
});

describe("lock gate", () => {
  it("starts locked when on, prompts by itself and unlocks on success", async () => {
    appState("active");
    const { services, auth } = setup({
      appLock: true,
      auth: memoryAuthenticator({ results: ["ok"] }),
    });
    await renderGate(services);
    expect(lockScreen()).toBeOnTheScreen();
    // The app stays mounted underneath.
    expect(screen.getByText("Synthetic content", { includeHiddenElements: true })).toBeTruthy();
    // On iOS it sits in its own window above the native sheets and modals.
    expect(JSON.stringify(screen.toJSON())).toContain('"type":"RNSFullWindowOverlay"');
    // The current profile's initial, never its name.
    expect(screen.getByText("S")).toBeOnTheScreen();
    expect(screen.queryByText("Synthetic A")).toBeNull();
    expect(auth.prompts).toHaveLength(0);
    await waitFor(() => expect(lockScreen()).toBeNull());
    expect(auth.prompts).toEqual([
      { message: "Unlock cashU", cancel: "Cancel", fallback: "Use passcode" },
    ]);
  });

  it("says so when the check failed, prompts once by itself, then unlocks from the button", async () => {
    appState("active");
    const { services, auth } = setup({
      appLock: true,
      auth: memoryAuthenticator({ results: ["failed", "ok"] }),
    });
    await renderGate(services);
    await waitFor(() => expect(screen.getByText("Could not verify. Try again.")).toBeOnTheScreen());
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(auth.prompts).toHaveLength(1);
    await fireEvent.press(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(lockScreen()).toBeNull());
    expect(auth.prompts).toHaveLength(2);
  });

  it("says what to set up when the phone has nothing to check with", async () => {
    appState("active");
    const { services } = setup({
      appLock: true,
      auth: memoryAuthenticator({ capability: "none", results: ["unavailable"] }),
    });
    await renderGate(services);
    await waitFor(() =>
      expect(
        screen.getByText("Set up Face ID or a passcode in iOS Settings, then try again."),
      ).toBeOnTheScreen(),
    );
    expect(lockScreen()).toBeOnTheScreen();
  });

  it("a cancel keeps it locked without a note", async () => {
    appState("active");
    const { services, auth } = setup({ appLock: true });
    await renderGate(services);
    await waitFor(() => expect(auth.prompts).toHaveLength(1));
    expect(lockScreen()).toBeOnTheScreen();
    expect(screen.queryByText("Could not verify. Try again.")).toBeNull();
  });

  it("waits for the app to be active before it prompts", async () => {
    const enter = appState("background");
    const { services, auth } = setup({
      appLock: true,
      auth: memoryAuthenticator({ results: ["ok"] }),
    });
    await renderGate(services);
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(auth.prompts).toHaveLength(0);
    expect(lockScreen()).toBeOnTheScreen();
    await act(() => enter("active"));
    await waitFor(() => expect(lockScreen()).toBeNull());
    expect(auth.prompts).toHaveLength(1);
  });

  it("stays off when the setting is off", async () => {
    appState("active");
    const { services, auth } = setup({ appLock: false, isDemo: false });
    await renderGate(services);
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(lockScreen()).toBeNull();
    expect(auth.prompts).toHaveLength(0);
  });

  it.each([
    ["off for the demo", true, false],
    ["on for real vaults", false, true],
  ])("defaults %s until the owner chooses", async (_name, isDemo, locked) => {
    appState("active");
    const { services } = setup({
      isDemo,
      auth: memoryAuthenticator({ results: [pending().result] }),
    });
    await renderGate(services);
    expect(lockScreen() !== null).toBe(locked);
  });

  it("unlocks when the setting is turned off", async () => {
    appState("active");
    const prompt = pending();
    const { fixture, services } = setup({
      appLock: true,
      auth: memoryAuthenticator({ results: [prompt.result] }),
    });
    await renderGate(services);
    expect(lockScreen()).toBeOnTheScreen();
    await act(async () => {
      await services.client.run({ kind: "device" }, setDeviceLock, { appLock: false });
    });
    expect(lockScreen()).toBeNull();
    expect(deviceLock.run((sql, ...p) => fixture.device.read(sql, ...p), undefined)).toEqual({
      appLock: false,
    });
  });

  it("locks again after the background timeout, not after a short spell or an inactive one", async () => {
    const enter = appState("active");
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const { services, auth } = setup({
      appLock: true,
      auth: memoryAuthenticator({ results: ["ok", "ok"] }),
    });
    await renderGate(services);
    await waitFor(() => expect(lockScreen()).toBeNull());
    // An inactive spell (the app switcher, Control Center) never locks.
    await act(() => enter("inactive"));
    now += 10 * LOCK_AFTER_MS;
    await act(() => enter("active"));
    expect(lockScreen()).toBeNull();
    // A short trip to the background does not lock.
    await act(() => enter("background"));
    now += LOCK_AFTER_MS - 1;
    await act(() => enter("active"));
    expect(lockScreen()).toBeNull();
    // A long one does, and prompts by itself again.
    await act(() => enter("background"));
    now += LOCK_AFTER_MS;
    await act(() => enter("active"));
    expect(lockScreen()).toBeOnTheScreen();
    await waitFor(() => expect(lockScreen()).toBeNull());
    expect(auth.prompts).toHaveLength(2);
  });

  it("is mounted by the app environment", async () => {
    appState("active");
    const { services } = setup({
      appLock: true,
      auth: memoryAuthenticator({ results: [pending().result] }),
    });
    await render(
      <Frame services={services}>
        <AppEnv>
          <Text>Synthetic content</Text>
        </AppEnv>
      </Frame>,
    );
    expect(lockScreen()).toBeOnTheScreen();
  });
});

describe("while locked", () => {
  /** The gate around expo-router's test router: a start route and a sheet route. */
  async function renderRoutes(services: Services) {
    await renderRouter(
      {
        _layout: () => (
          <Frame services={services}>
            <LockGate>
              <Slot />
            </LockGate>
          </Frame>
        ),
        today: () => <Text>Synthetic today</Text>,
        "sheet/profile": () => <Text>Synthetic sheet</Text>,
      },
      { initialUrl: "/today" },
    );
    // renderRouter switches to fake timers: let the lock's prompt delay pass, then go on with real ones.
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    jest.useRealTimers();
  }

  it("holds navigation: a deep link opens nothing until the unlock, then opens", async () => {
    appState("active");
    const prompt = pending();
    const { services } = setup({
      appLock: true,
      auth: memoryAuthenticator({ results: [prompt.result] }),
    });
    await renderRoutes(services);
    expect(lockScreen()).toBeOnTheScreen();
    expect(isNavigationHeld()).toBe(true);
    // expo-router opens nothing for a null path.
    expect(redirectSystemLink({ path: "cashu:///sheet/profile", initial: false })).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByText("Synthetic sheet", { includeHiddenElements: true })).toBeNull();
    await act(async () => prompt.answer("ok"));
    await waitFor(() => expect(lockScreen()).toBeNull());
    expect(isNavigationHeld()).toBe(false);
    await waitFor(() => expect(screen.getByText("Synthetic sheet")).toBeOnTheScreen());
  });

  it("holds navigation in the background with the lock on, and frees it after a short spell", async () => {
    const enter = appState("active");
    const { services } = setup({
      appLock: true,
      auth: memoryAuthenticator({ results: ["ok"] }),
    });
    await renderGate(services);
    await waitFor(() => expect(lockScreen()).toBeNull());
    expect(isNavigationHeld()).toBe(false);
    await act(() => enter("background"));
    expect(isNavigationHeld()).toBe(true);
    await act(() => enter("active"));
    expect(isNavigationHeld()).toBe(false);
  });

  it("does not hold navigation with the lock off, and releases the hold when unmounted", async () => {
    appState("active");
    const off = setup({ appLock: false });
    await renderGate(off.services);
    expect(isNavigationHeld()).toBe(false);
    await cleanup();
    const on = setup({ appLock: true, auth: memoryAuthenticator({ results: [pending().result] }) });
    await renderGate(on.services);
    expect(isNavigationHeld()).toBe(true);
    await cleanup();
    expect(isNavigationHeld()).toBe(false);
  });

  it("hides the app underneath from VoiceOver, and shows it again after the unlock", async () => {
    appState("active");
    const prompt = pending();
    const { services } = setup({
      appLock: true,
      auth: memoryAuthenticator({ results: [prompt.result] }),
    });
    await renderGate(services);
    expect(screen.queryByText("Synthetic content")).toBeNull();
    expect(screen.getByText("Synthetic content", { includeHiddenElements: true })).toBeTruthy();
    await act(async () => prompt.answer("ok"));
    await waitFor(() => expect(lockScreen()).toBeNull());
    expect(screen.getByText("Synthetic content")).toBeOnTheScreen();
  });

  it("re-attaches the overlay on top when a route changes, and once more shortly after", async () => {
    appState("active");
    const { services } = setup({
      appLock: true,
      auth: memoryAuthenticator({ results: [pending().result] }),
    });
    await renderRoutes(services);
    const first = lockScreen();
    expect(first).toBeOnTheScreen();
    // Something presented while locked (navigation from inside the app is not held).
    await act(() => router.push("/sheet/profile"));
    const second = lockScreen();
    expect(second).toBeOnTheScreen();
    expect(second).not.toBe(first);
    await act(() => new Promise((resolve) => setTimeout(resolve, 450)));
    const third = lockScreen();
    expect(third).toBeOnTheScreen();
    expect(third).not.toBe(second);
  });
});

function ProfileSheet() {
  const props = useProfileSheet({
    close: () => {},
    openDiagnostics: () => {},
    openNotifications: () => {},
    openBench: () => {},
    removePhone: async () => {},
  });
  return <ProfileSheetView {...props} />;
}

describe("profile sheet lock switch", () => {
  const activate = (name: string) =>
    fireEvent(screen.getByRole("switch", { name }), "accessibilityAction", {
      nativeEvent: { actionName: "activate" },
    });
  const lockSetting = (fixture: MoneyStore) =>
    deviceLock.run((sql, ...p) => fixture.device.read(sql, ...p), undefined).appLock;

  it("checks the owner before it turns the lock on", async () => {
    appState("active");
    const prompt = pending();
    const { fixture, services, auth } = setup({
      auth: memoryAuthenticator({ results: [prompt.result] }),
    });
    await render(
      <Frame services={services}>
        <ProfileSheet />
      </Frame>,
    );
    const name = "Face ID to open";
    await waitFor(() => expect(screen.getByRole("switch", { name })).toBeOnTheScreen());
    expect(screen.getByRole("switch", { name })).not.toBeChecked();
    await activate(name);
    expect(auth.prompts.map((p) => p.message)).toEqual(["Confirm to turn on the lock"]);
    // Nothing is written while the check is open.
    expect(lockSetting(fixture)).toBeNull();
    await act(async () => prompt.answer("ok"));
    await waitFor(() => expect(lockSetting(fixture)).toBe(true));
    expect(screen.getByRole("switch", { name })).toBeChecked();
  });

  it("checks the owner before it turns the lock off", async () => {
    appState("active");
    const { fixture, services, auth } = setup({
      appLock: true,
      auth: memoryAuthenticator({ capability: "fingerprint", results: ["ok"] }),
    });
    await render(
      <Frame services={services}>
        <ProfileSheet />
      </Frame>,
    );
    const name = "Touch ID to open";
    await waitFor(() => expect(screen.getByRole("switch", { name })).toBeChecked());
    await activate(name);
    await waitFor(() => expect(lockSetting(fixture)).toBe(false));
    expect(auth.prompts.map((p) => p.message)).toEqual(["Confirm to turn off the lock"]);
  });

  it.each([
    ["cancelled", "cancelled"],
    ["failed", "failed"],
  ] as const)("changes nothing when the check is %s", async (_name, result) => {
    appState("active");
    const { fixture, services, auth } = setup({ auth: memoryAuthenticator({ results: [result] }) });
    await render(
      <Frame services={services}>
        <ProfileSheet />
      </Frame>,
    );
    const name = "Face ID to open";
    await waitFor(() => expect(screen.getByRole("switch", { name })).toBeEnabled());
    await activate(name);
    await waitFor(() => expect(screen.getByRole("switch", { name })).toBeEnabled());
    expect(auth.prompts).toHaveLength(1);
    expect(lockSetting(fixture)).toBeNull();
    expect(screen.getByRole("switch", { name })).not.toBeChecked();
    expect(screen.queryByText("Could not verify. Try again.")).toBeNull();
  });

  it("is dimmed with what to set up when the phone has nothing to check with", async () => {
    appState("active");
    const { services, auth } = setup({ auth: memoryAuthenticator({ capability: "none" }) });
    await render(
      <Frame services={services}>
        <ProfileSheet />
      </Frame>,
    );
    await waitFor(() =>
      expect(
        screen.getByText("Set up Face ID or a passcode in iOS Settings first"),
      ).toBeOnTheScreen(),
    );
    expect(screen.getByRole("switch", { name: "Face ID to open" })).toBeDisabled();
    await activate("Face ID to open");
    expect(auth.prompts).toHaveLength(0);
  });

  it("starts one check for two quick taps", async () => {
    appState("active");
    const prompt = pending();
    const { services, auth } = setup({ auth: memoryAuthenticator({ results: [prompt.result] }) });
    await render(
      <Frame services={services}>
        <ProfileSheet />
      </Frame>,
    );
    const name = "Face ID to open";
    await waitFor(() => expect(screen.getByRole("switch", { name })).toBeEnabled());
    const sw = screen.getByRole("switch", { name });
    await act(async () => {
      for (let i = 0; i < 2; i++)
        fireEvent(sw, "accessibilityAction", { nativeEvent: { actionName: "activate" } });
    });
    expect(auth.prompts).toHaveLength(1);
    await act(async () => prompt.answer("cancelled"));
  });

  it("names the passcode on a phone without Face ID or Touch ID", async () => {
    appState("active");
    const { services } = setup({ auth: memoryAuthenticator({ capability: "passcode" }) });
    await render(
      <Frame services={services}>
        <ProfileSheet />
      </Frame>,
    );
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Passcode to open" })).toBeOnTheScreen(),
    );
  });
});
