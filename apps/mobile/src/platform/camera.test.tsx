// The camera permission of the pairing scan: a never-answered permission is asked for only once the
// screen says it is ready (iOS draws its prompt over whatever is on screen), and then only once.
import { renderHook } from "@testing-library/react-native";
import { useCameraAccess } from "./camera";

const mockRequest = jest.fn(async () => undefined);
// Like expo-camera before the first answer: the same object until the answer changes.
const mockUnanswered = [
  { granted: false, canAskAgain: true, status: "undetermined" },
  mockRequest,
] as const;
jest.mock("expo-camera", () => ({ useCameraPermissions: () => mockUnanswered }));

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
