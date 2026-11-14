// The camera permission of the pairing scan: a never-answered permission is asked for only once the
// screen says it is ready (iOS draws its prompt over whatever is on screen), and then only once; the
// prompt is the app's own (the app-switcher cover stays away meanwhile); an answer whose request result
// was lost is heard when the app is active again.
import { act, renderHook } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { systemPrompt } from "../shell/systemPrompt";
import { useCameraAccess } from "./camera";

type Permission = { granted: boolean; canAskAgain: boolean; status: string };
const UNANSWERED: Permission = { granted: false, canAskAgain: true, status: "undetermined" };
const DENIED: Permission = { granted: false, canAskAgain: false, status: "denied" };

let mockPrompt: { answer(): void } | undefined;
/** What the system says when the permission is read (`get`). */
let mockSystem: Permission = UNANSWERED;
const mockRequest = jest.fn(
  () =>
    new Promise<undefined>((resolve) => {
      // The request's own result never reaches the hook (as when its screen was remounted meanwhile).
      mockPrompt = { answer: () => resolve(undefined) };
    }),
);
// Like expo-camera: the same object until a read changes it.
jest.mock("expo-camera", () => {
  const { useState } = require("react");
  return {
    useCameraPermissions: () => {
      const [permission, setPermission] = useState(UNANSWERED);
      return [permission, mockRequest, async () => setPermission(mockSystem)];
    },
  };
});

afterEach(async () => {
  // An unanswered prompt of a test ends with it.
  await act(async () => mockPrompt?.answer());
});
beforeEach(() => {
  mockRequest.mockClear();
  mockSystem = UNANSWERED;
  mockPrompt = undefined;
});

it("asks for the camera only after the screen is ready, and once", async () => {
  const onAnswer = jest.fn();
  const hook = await renderHook(
    ({ ready }: { ready: boolean }) => useCameraAccess(onAnswer, ready),
    {
      initialProps: { ready: false },
    },
  );
  expect(mockRequest).not.toHaveBeenCalled();
  await hook.rerender({ ready: true });
  expect(mockRequest).toHaveBeenCalledTimes(1);
  await hook.rerender({ ready: true });
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(onAnswer).not.toHaveBeenCalled();
});

it("marks its prompt as the app's own and hears the answer when the app is active again", async () => {
  const listeners: ((state: AppStateStatus) => void)[] = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, handler) => {
    listeners.push(handler as (state: AppStateStatus) => void);
    return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
  });
  const onAnswer = jest.fn();
  await renderHook(() => useCameraAccess(onAnswer, true));
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(systemPrompt.expected()).toBe(true);
  // "Don't Allow": the system now says denied; the app becomes active.
  mockSystem = DENIED;
  await act(async () => mockPrompt?.answer());
  expect(systemPrompt.expected()).toBe(false);
  await act(async () => {
    for (const listener of listeners) listener("active");
  });
  expect(onAnswer).toHaveBeenCalledWith("denied");
});
