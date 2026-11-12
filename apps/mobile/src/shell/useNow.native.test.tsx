// The app's one "today" moves on by itself: at local midnight (one timer) and when the app returns
// from the background; an inactive -> active blip (Control Center) reads nothing new. The screens'
// reaction to a new day (Today turning into the closed month on the 1st) is pinned in
// screens/today/today.native.test.tsx; the routes pass `useNow()` into those hooks.
import { act, cleanup, render, screen } from "@testing-library/react-native";
import { AppState, type AppStateStatus, Text } from "react-native";
import { msToMidnight, useNow } from "./useNow";

function Probe() {
  const { today, now } = useNow();
  return (
    <>
      <Text testID="today">{today}</Text>
      <Text testID="now">{now}</Text>
    </>
  );
}

let listener: ((state: AppStateStatus) => void) | undefined;

beforeEach(() => {
  listener = undefined;
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, handler) => {
    listener = handler as (state: AppStateStatus) => void;
    return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
  });
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("useNow", () => {
  it("turns 31 October into 1 November at local midnight", async () => {
    jest.useFakeTimers({ now: new Date(2026, 9, 31, 23, 59, 0) });
    await render(<Probe />);
    expect(screen.getByTestId("today")).toHaveTextContent("2026-10-31");
    await act(() => jest.advanceTimersByTime(59_000));
    expect(screen.getByTestId("today")).toHaveTextContent("2026-10-31");
    await act(() => jest.advanceTimersByTime(1_100));
    expect(screen.getByTestId("today")).toHaveTextContent("2026-11-01");
    // The timer re-arms for the next midnight.
    await act(() => jest.advanceTimersByTime(24 * 3_600_000));
    expect(screen.getByTestId("today")).toHaveTextContent("2026-11-02");
  });

  it("reads the day again on the way back from the background, not after an inactive blip", async () => {
    jest.useFakeTimers({ now: new Date(2026, 10, 30, 22, 0, 0) });
    await render(<Probe />);
    expect(screen.getByTestId("today")).toHaveTextContent("2026-11-30");
    const before = screen.getByTestId("now").props.children as string;
    // A suspended process misses its timer: the clock jumps, nothing fires.
    jest.setSystemTime(new Date(2026, 11, 1, 7, 30, 0));
    await act(() => {
      listener?.("inactive");
      listener?.("active");
    });
    expect(screen.getByTestId("today")).toHaveTextContent("2026-11-30");
    expect(screen.getByTestId("now")).toHaveTextContent(before);
    await act(() => {
      listener?.("background");
      listener?.("active");
    });
    expect(screen.getByTestId("today")).toHaveTextContent("2026-12-01");
    expect(screen.getByTestId("now")).toHaveTextContent(new Date(2026, 11, 1, 7, 30).toISOString());
  });

  it("measures the time to the next local midnight", () => {
    expect(msToMidnight(new Date(2026, 9, 31, 23, 59, 0))).toBe(60_000);
    expect(msToMidnight(new Date(2026, 1, 28, 0, 0, 0))).toBe(24 * 3_600_000);
  });
});
