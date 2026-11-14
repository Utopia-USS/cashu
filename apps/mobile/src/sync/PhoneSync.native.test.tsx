// The running app's sync triggers: a pass request after the first frame, one on the way back from the
// background (not after an inactive blip), one on the arrival in the background, none after unmount.
// The runner's own rules (one pass per vault, 30 s, push-only) are pinned in syncRunner.test.ts.
import { act, cleanup, render } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { ServicesProvider } from "../services/ServicesProvider";
import type { Services } from "../services/services";
import { PhoneSync } from "./PhoneSync";
import type { SyncTrigger } from "./syncRunner";

let listener: ((state: AppStateStatus) => void) | undefined;
let removed = false;

beforeEach(() => {
  listener = undefined;
  removed = false;
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, handler) => {
    listener = handler as (state: AppStateStatus) => void;
    return {
      remove: () => {
        removed = true;
      },
    } as ReturnType<typeof AppState.addEventListener>;
  });
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("requests passes after the first frame, on return and on leaving", async () => {
  jest.useFakeTimers();
  const triggers: SyncTrigger[] = [];
  const services = {
    sync: {
      request: async (trigger: SyncTrigger) => {
        triggers.push(trigger);
      },
    },
  } as unknown as Services;
  const view = await render(
    <ServicesProvider services={services}>
      <PhoneSync />
    </ServicesProvider>,
  );
  expect(triggers).toEqual([]);
  await act(() => jest.advanceTimersByTime(0));
  expect(triggers).toEqual(["start"]);
  await act(() => {
    listener?.("inactive");
    listener?.("active");
  });
  expect(triggers).toEqual(["start"]);
  await act(() => {
    listener?.("inactive");
    listener?.("background");
  });
  expect(triggers).toEqual(["start", "background"]);
  await act(() => listener?.("active"));
  expect(triggers).toEqual(["start", "background", "foreground"]);
  await view.unmount();
  expect(removed).toBe(true);
});
