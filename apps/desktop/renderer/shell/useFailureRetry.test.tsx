// @vitest-environment jsdom
// The failure screen's automatic retry (routes.tsx `RouteFailure` calls `useFailureRetry(reset)`) under
// a boundary: it asks the failed queries again and renders the boundary's tree again on a bounded
// back-off, and a failure that keeps coming back ends on the screen with its button. Synthetic
// components only (the router-wide routes.tsx is not loaded here).
import { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FAILURE_QUIET_MS, FAILURE_RETRY_MS } from "./reconnectWindow.js";
import { useFailureRetry } from "./useFailureRetry.js";

const client = vi.hoisted(() => ({ retryFailed: vi.fn() }));
vi.mock("@cashu/store-react", () => ({ useStoreClient: () => client }));

/** The failure screen's shape: the alert, the button, and the hook under test. */
function Failure({ reset }: { reset?: () => void }) {
  useFailureRetry(reset);
  return (
    <main>
      <p role="alert">failed</p>
      <button type="button">Try again</button>
    </main>
  );
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  readonly #reset = () => this.setState({ failed: false });
  override render() {
    return this.state.failed ? <Failure reset={this.#reset} /> : this.props.children;
  }
}

/** The failure's cause: every render of `Data` throws while it stands. */
const failures = {
  failing: false,
  renders: 0,
  /** One render: true when it fails. */
  next(): boolean {
    this.renders += 1;
    return this.failing;
  },
};
function Data() {
  if (failures.next()) throw new Error("the store could not be opened");
  return <p>data</p>;
}

/** The tests' own clock, moving forward only (each test starts later than the last ended). */
let clock = Date.now();
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // The retry budget is the window's own: start each test a quiet period after the previous one.
  clock += FAILURE_QUIET_MS * 10;
  vi.setSystemTime(clock);
  client.retryFailed.mockClear();
  failures.renders = 0;
  container = document.createElement("div");
  document.body.append(container);
  // React renders a failed concurrent render again synchronously and reports it; not a test failure.
  root = createRoot(container, { onRecoverableError: () => {} });
  // React reports caught render errors to the console; the throws here are the test's own.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mount = () => act(async () => root.render(<Boundary>{<Data />}</Boundary>));
const elapse = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
  });
const alert = () => container.querySelector('[role="alert"]')?.textContent ?? null;
const button = () => container.querySelector("button")?.textContent ?? null;

it("a failure that clears recovers on its own after the first back-off, without the button", async () => {
  failures.failing = true;
  await mount();
  expect(alert()).toBe("failed");
  await elapse((FAILURE_RETRY_MS[0] ?? 0) - 1);
  expect(alert()).toBe("failed");
  expect(client.retryFailed).not.toHaveBeenCalled();
  // The host is back: the next retry finds the data.
  failures.failing = false;
  await elapse(1);
  expect(client.retryFailed).toHaveBeenCalledTimes(1);
  expect(alert()).toBeNull();
  expect(container.textContent).toBe("data");
});

it("a failure that keeps coming back retries a bounded number of times, then waits for the button", async () => {
  failures.failing = true;
  await mount();
  for (const delay of FAILURE_RETRY_MS) {
    expect(alert()).toBe("failed");
    await elapse(delay);
  }
  expect(client.retryFailed).toHaveBeenCalledTimes(FAILURE_RETRY_MS.length);
  const rendersAfterBudget = failures.renders;
  // Nothing more on its own, however long the screen stays.
  await elapse(FAILURE_QUIET_MS * 2);
  expect(client.retryFailed).toHaveBeenCalledTimes(FAILURE_RETRY_MS.length);
  expect(failures.renders).toBe(rendersAfterBudget);
  expect(alert()).toBe("failed");
  expect(button()).toBe("Try again");
});

it("a failure screen without a boundary to reset never retries on its own", async () => {
  await act(async () => root.render(<Failure />));
  await elapse(FAILURE_QUIET_MS);
  expect(client.retryFailed).not.toHaveBeenCalled();
  expect(button()).toBe("Try again");
});
