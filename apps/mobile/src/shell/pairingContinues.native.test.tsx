// A pairing past its commit point survives the services' reopen and the app lock (QA run 2, Observation 1):
// the tree remounts while the flow is still storing, the role step arrives after the remount, and the
// modal must be presented again on the flow's step. The lock's default waits until the flow is done; an
// explicit lock still locks, and the modal comes back right after the unlock (never under the lock).
// Real synchronous store, expo-router's test router, a scripted authenticator; synthetic data only.
import { setLanguageForTests } from "@cashu/i18n";
import { setDeviceLock } from "@cashu/store/device";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { act, cleanup, screen, waitFor } from "@testing-library/react-native";
import { Slot } from "expo-router";
import { renderRouter } from "expo-router/testing-library";
import type { ReactNode } from "react";
import { AppState, Text } from "react-native";
import { pairFlow } from "../screens/pair/pairFlow";
import { moneyStore } from "../screens/testing/moneyStore";
import { ServicesProvider } from "../services/ServicesProvider";
import type { Services } from "../services/services";
import type { AuthResult } from "./auth";
import { LockGate } from "./LockGate";
import { usePairingRoute } from "./pairingRoute";
import { memoryAuthenticator } from "./testing/auth";

jest.mock("@expo/ui", () => require("../screens/testing/expoUiMock").default);

const VAULT = "6a1d4c2e90b34f7581ce24d8e3a5c967";
const closers: (() => void)[] = [];
let restoreAppState: () => void = () => {};

beforeEach(() => {
  setLanguageForTests("en");
  pairFlow.reset();
  // The app is in the foreground (the React Native preset mocks AppState without a status).
  const original = Object.getOwnPropertyDescriptor(AppState, "currentState");
  Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
  restoreAppState = () => {
    if (original) Object.defineProperty(AppState, "currentState", original);
  };
});
afterEach(() => {
  cleanup();
  pairFlow.reset();
  for (const close of closers.splice(0)) close();
  restoreAppState();
  jest.useRealTimers();
});

/** A paired phone's services (not the demo: the lock defaults to on) over the synthetic store. */
function setup(options: { appLock?: boolean; results?: Promise<AuthResult>[] } = {}): Services {
  const fixture = moneyStore();
  closers.push(() => fixture.close());
  if (options.appLock !== undefined)
    fixture.device.run(setDeviceLock, { appLock: options.appLock });
  return {
    ...fixture.services,
    auth: memoryAuthenticator({ results: options.results ?? [] }),
    isDemo: false,
  };
}

/** The flow as the joiner leaves it right after the commit point (`storing`). */
function flowAtStoring(): void {
  pairFlow.get("iPhone 16 Pro");
  pairFlow.dispatch({ type: "connecting" });
  pairFlow.dispatch({ type: "sas", sas: "872755", expiresAt: Date.now() + 120_000 });
  pairFlow.dispatch({ type: "storing" });
}

function Shell({ services, children }: { services: Services; children: ReactNode }) {
  return (
    <ServicesProvider services={services}>
      <StoreProvider client={services.client}>
        <ProfileProvider>
          <PairingRoute />
          <LockGate>{children}</LockGate>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}

function PairingRoute() {
  usePairingRoute();
  return null;
}

/** The root as the reopen remounts it: the start route goes on to Today. */
async function renderRemounted(services: Services) {
  await renderRouter(
    {
      _layout: () => (
        <Shell services={services}>
          <Slot />
        </Shell>
      ),
      index: () => <Text>Start</Text>,
      today: () => <Text>Synthetic today</Text>,
      "modal/pair": () => <Text>Pairing modal</Text>,
    },
    { initialUrl: "/today" },
  );
  // renderRouter switches to fake timers: let the lock's prompt delay and the macrotask pass.
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
  jest.useRealTimers();
}

const lockScreen = () => screen.queryByTestId("lock-screen");
const modal = () => screen.queryByText("Pairing modal", { includeHiddenElements: true });

it("presents the modal again when the role step arrives after the remount, with no lock mid-flow", async () => {
  flowAtStoring();
  await renderRemounted(setup());
  // The lock's default (on for a paired phone) waits for the flow.
  expect(lockScreen()).toBeNull();
  // The joiner's `add` resolved after the remount: the flow moves on to the role step.
  await act(async () => pairFlow.dispatch({ type: "stored", vault: VAULT }));
  await waitFor(() => expect(modal()).toBeOnTheScreen());
  expect(pairFlow.peek()?.kind).toBe("role");
  expect(lockScreen()).toBeNull();
  // Done ("Open cashU"): the default applies from now on, without locking the open app.
  await act(async () => {
    pairFlow.dispatch({ type: "roleSaved" });
    pairFlow.dispatch({ type: "finish" });
    pairFlow.reset();
  });
  expect(lockScreen()).toBeNull();
});

it("with the lock turned on, brings the modal back on the flow's step right after the unlock", async () => {
  let answer: (result: AuthResult) => void = () => {};
  const prompt = new Promise<AuthResult>((resolve) => {
    answer = resolve;
  });
  flowAtStoring();
  pairFlow.dispatch({ type: "stored", vault: VAULT });
  await renderRemounted(setup({ appLock: true, results: [prompt] }));
  expect(lockScreen()).toBeOnTheScreen();
  // Nothing is presented under the lock.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(modal()).toBeNull();
  await act(async () => answer("ok"));
  await waitFor(() => expect(lockScreen()).toBeNull());
  await waitFor(() => expect(modal()).toBeOnTheScreen());
  expect(pairFlow.peek()?.kind).toBe("role");
});
