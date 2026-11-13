// The root's phase around the app under expo-router's test router: the "Removing" state replaces the
// app while a wipe runs (the app's tree unmounts), the rebuilt app remounts on a new epoch and starts at
// the index, which goes to Today (no second Today, no stale route), and the fatal state stays until a
// restart. "Remove this phone" from the real profile sheet route dispatches no navigation action around
// the wipe (nothing reaches a navigator that is gone) and lands on Today. The wipe state stories render.
import { setLanguageForTests } from "@cashu/i18n";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { Redirect, router, Stack } from "expo-router";
import { renderRouter } from "expo-router/testing-library";
import type { ComponentType, ReactNode } from "react";
import { useEffect } from "react";
import { Alert, Text } from "react-native";
import ProfileSheetRoute from "../../app/sheet/profile";
import { moneyStore } from "../screens/testing/moneyStore";
import { bumpEpoch, showWiping } from "../services/lifecycle";
import { ServicesProvider } from "../services/ServicesProvider";
import { wipeDevice } from "../services/wipe";
import { RootPhaseGate } from "./RootPhaseGate";
import wipeMeta, { Failed, Wiping } from "./WipeStateView.stories";

jest.mock("@expo/ui", () => require("../screens/testing/expoUiMock").default);
// The sheet route's `wipeThisPhone`, bound per test (the platform wipe needs the device's files).
let mockWipe: () => Promise<void> = async () => {};
jest.mock("../services/services", () => ({ wipeThisPhone: () => mockWipe() }));
// No expo-notifications in Jest: the sheet reads an undetermined permission.
jest.mock("../platform/notifications", () => ({
  expoScheduler: { permission: async () => "undetermined" },
}));

const closers: (() => void)[] = [];
beforeEach(() => setLanguageForTests("en"));
afterEach(async () => {
  await cleanup();
  for (const close of closers.splice(0)) close();
  jest.restoreAllMocks();
  jest.useRealTimers();
  // Leave the shared root store ready for the next test (nothing is mounted any more).
  bumpEpoch("ready");
});

describe("wipe state stories", () => {
  const Component = wipeMeta.component as ComponentType<object>;
  it.each(Object.entries({ Wiping, Failed }))("%s renders", async (_name, story) => {
    await render(<Component {...wipeMeta.args} {...story.args} />);
    expect(screen.getByTestId("wipe-state")).toBeOnTheScreen();
  });
});

/** How often the app's tree mounted. */
let mounts = 0;

function App() {
  useEffect(() => {
    mounts++;
  }, []);
  return <Stack />;
}

describe("root phase gate", () => {
  async function renderApp() {
    mounts = 0;
    return renderRouter(
      {
        _layout: () => (
          <RootPhaseGate>
            <App />
          </RootPhaseGate>
        ),
        index: () => <Redirect href="/today" />,
        today: () => <Text>Synthetic today</Text>,
        "sheet/cash": () => <Text>Synthetic other</Text>,
      },
      { initialUrl: "/" },
    );
  }

  it("shows Removing instead of the app, then remounts it on Today", async () => {
    const app = await renderApp();
    expect(screen.getByText("Synthetic today")).toBeOnTheScreen();
    await act(() => router.push("/sheet/cash"));
    expect(app.getPathname()).toBe("/sheet/cash");
    expect(mounts).toBe(1);

    await act(() => showWiping());
    expect(screen.getByText("Removing this phone's copy...")).toBeOnTheScreen();
    expect(screen.queryByText("Synthetic other", { includeHiddenElements: true })).toBeNull();

    await act(() => bumpEpoch("ready"));
    expect(mounts).toBe(2);
    expect(screen.queryByText("Removing this phone's copy...")).toBeNull();
    expect(screen.getByText("Synthetic today")).toBeOnTheScreen();
    expect(app.getPathname()).toBe("/today");
    // One Today, nothing under it to go back to.
    expect(router.canGoBack()).toBe(false);
  });

  it("shows the fatal state instead of the app after a failed wipe", async () => {
    await renderApp();
    await act(() => showWiping());
    await act(() => bumpEpoch("failed"));
    expect(
      screen.getByText(
        "Something went wrong removing this phone's copy. Close cashU and open it again.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText("Synthetic today", { includeHiddenElements: true })).toBeNull();
    expect(mounts).toBe(1);
  });
});

/** Whether the data providers (and the navigator under them) are mounted. */
let providersMounted = false;
/** The epoch's synthetic services: a new set after each rebuild, like `bootServices()`. */
let fixture: ReturnType<typeof moneyStore> | null = null;

function epochFixture(): ReturnType<typeof moneyStore> {
  if (fixture === null) {
    const fresh = moneyStore();
    closers.push(() => fresh.close());
    fixture = fresh;
  }
  return fixture;
}

/** The app root's data providers over the epoch's services. */
function Providers({ children }: { children: ReactNode }) {
  const { services, client } = epochFixture();
  useEffect(() => {
    providersMounted = true;
    return () => {
      providersMounted = false;
    };
  }, []);
  return (
    <ServicesProvider services={services}>
      <StoreProvider client={client}>
        <ProfileProvider>{children}</ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}

describe("remove this phone from the profile sheet", () => {
  it("dispatches no navigation around the wipe and lands on Today", async () => {
    fixture = null;
    // expo-router's dev warning for an action no navigator handled (a dispatch after the unmount).
    const errors = jest.spyOn(console, "error");
    const unhandledActions = () =>
      errors.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("was not handled by any navigator"));
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    let releaseFrame: () => void = () => {};
    mockWipe = async () => {
      await wipeDevice({
        showWiping,
        beforeWipe: [],
        deleteSecrets: async () => {},
        nextFrame: () =>
          new Promise((resolve) => {
            releaseFrame = () => resolve();
          }),
        close: () => {},
        deleteFiles: () => {},
        reset: () => {
          fixture = null;
        },
        remount: bumpEpoch,
      });
    };
    const app = await renderRouter(
      {
        _layout: () => (
          <RootPhaseGate>
            <Providers>
              <Stack>
                <Stack.Screen
                  name="sheet/profile"
                  options={{ presentation: "formSheet", headerShown: false }}
                />
              </Stack>
            </Providers>
          </RootPhaseGate>
        ),
        index: () => <Redirect href="/today" />,
        today: () => <Text>Synthetic today</Text>,
        "sheet/profile": ProfileSheetRoute,
      },
      { initialUrl: "/" },
    );
    const before = fixture;
    await act(() => router.push("/sheet/profile"));
    expect(app.getPathname()).toBe("/sheet/profile");
    await fireEvent.press(screen.getByRole("button", { name: /Remove this phone/ }));
    const buttons = alert.mock.calls[0]?.[2] ?? [];
    expect(buttons[1]?.text).toBe("Remove");

    // Confirm: the root shows Removing, the providers and the navigator are gone, and every effect
    // (expo-router drains queued navigation in one) has run while the wipe holds.
    await act(async () => buttons[1]?.onPress?.());
    expect(screen.getByText("Removing this phone's copy...")).toBeOnTheScreen();
    expect(providersMounted).toBe(false);
    expect(unhandledActions()).toEqual([]);

    await act(async () => releaseFrame());
    // Remounted over the rebuilt services.
    expect(providersMounted).toBe(true);
    expect(fixture).not.toBeNull();
    expect(fixture).not.toBe(before);
    expect(screen.queryByText("Removing this phone's copy...")).toBeNull();
    expect(screen.getByText("Synthetic today")).toBeOnTheScreen();
    expect(app.getPathname()).toBe("/today");
    expect(router.canGoBack()).toBe(false);
    // No action reached a navigator that was unmounted (or the rebuilt Today with nothing under it).
    expect(unhandledActions()).toEqual([]);
    // The wipe resolved: no "Could not delete everything" alert.
    expect(alert).toHaveBeenCalledTimes(1);
  });
});
