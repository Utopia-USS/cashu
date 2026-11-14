// The pairing modal's hook + View (one test per behaviour): camera denied -> paste is the way in, a pasted
// text that is not a code, cancel closes and starts over, the six digits expire into "Scan again", and
// the role step saves the role and moves on to the first sync. The protocol runs in joiner.test.ts.
import { setLanguageForTests } from "@cashu/i18n";
import { UiEnvProvider } from "@cashu/ui/native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { ServicesProvider } from "../../services/ServicesProvider";
import type { Services } from "../../services/services";
import type { PairingPorts } from "./joiner";
import { PairView } from "./PairView";
import * as pairStories from "./PairView.stories";
import { pairFlow } from "./pairFlow";
import { type PairScreenArgs, usePairScreen } from "./usePairScreen";

jest.mock("@expo/ui", () => require("../testing/expoUiMock").default);

let mockCameraGranted = true;
/** Never answered yet (iOS would prompt): `request` counts the prompts. */
let mockCameraUnknown = false;
const mockRequest = jest.fn(async () => undefined);
// Like expo-camera, the same permission object (and request function) until the answer changes:
// the platform hook answers once per change, not on every render.
const mockPermissions = {
  granted: [{ granted: true, canAskAgain: false, status: "granted" }, async () => undefined],
  denied: [{ granted: false, canAskAgain: false, status: "denied" }, async () => undefined],
  unknown: [{ granted: false, canAskAgain: true, status: "undetermined" }, mockRequest],
};
jest.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () =>
    mockPermissions[mockCameraUnknown ? "unknown" : mockCameraGranted ? "granted" : "denied"],
}));

const services = {
  vaults: { get: () => undefined, unavailable: () => undefined },
} as unknown as Services;

const ports = (): PairingPorts => ({
  sodium: undefined as never,
  relay: undefined,
  now: () => Date.now(),
  held: () => undefined,
  pushHeld: async () => false,
  store: async () => undefined,
  add: async () => undefined,
  placeholderName: "New profile",
});

function Screen(props: Partial<PairScreenArgs> & { close: () => void }) {
  const state = usePairScreen({
    defaultName: "iPhone 16 Pro",
    ports,
    saveRole: async () => undefined,
    profileName: () => null,
    ...props,
  });
  return <PairView {...state} />;
}

function wrap(children: ReactNode) {
  return (
    <ServicesProvider services={services}>
      <UiEnvProvider locale="en-US" privacy={false}>
        {children}
      </UiEnvProvider>
    </ServicesProvider>
  );
}

beforeEach(() => {
  setLanguageForTests("en");
  mockCameraGranted = true;
  mockCameraUnknown = false;
  mockRequest.mockClear();
  pairFlow.reset();
});

it("makes paste the way in when the camera is denied", async () => {
  mockCameraGranted = false;
  await render(wrap(<Screen close={() => {}} />));
  expect(screen.getByText(/cashU can't use the camera/)).toBeOnTheScreen();
  expect(screen.getByLabelText("Code from your Mac")).toBeOnTheScreen();
  expect(screen.queryByText("Scan with the camera")).toBeNull();
});

it("says when the pasted text is not a cashU code", async () => {
  await render(wrap(<Screen close={() => {}} />));
  await fireEvent.press(screen.getByLabelText("Paste the code"));
  await fireEvent.changeText(screen.getByLabelText("Code from your Mac"), "hello");
  await fireEvent.press(screen.getByLabelText("Connect"));
  expect(await screen.findByText(/This is not a cashU code/)).toBeOnTheScreen();
});

it("takes a pasted code as typed and clears 'not a cashU code' when the text changes", async () => {
  await render(wrap(<Screen close={() => {}} />));
  await fireEvent.press(screen.getByLabelText("Paste the code"));
  const field = screen.getByLabelText("Code from your Mac");
  expect(field.props).toMatchObject({
    autoCapitalize: "none",
    autoCorrect: false,
    spellCheck: false,
    scrollEnabled: false,
  });
  await fireEvent.changeText(field, "hello");
  await fireEvent.press(screen.getByLabelText("Connect"));
  expect(await screen.findByText(/This is not a cashU code/)).toBeOnTheScreen();
  await fireEvent.changeText(screen.getByLabelText("Code from your Mac"), "hello2");
  expect(screen.queryByText(/This is not a cashU code/)).toBeNull();
});

it("goes back to the paste path on Scan again when the camera is denied", async () => {
  mockCameraGranted = false;
  await render(wrap(<Screen close={() => {}} />));
  await act(async () => {
    pairFlow.dispatch({ type: "connecting" });
    pairFlow.dispatch({ type: "failed", reason: "offline" });
  });
  await fireEvent.press(screen.getByLabelText("Scan again"));
  expect(screen.getByText(/cashU can't use the camera/)).toBeOnTheScreen();
  expect(screen.getByLabelText("Code from your Mac")).toBeOnTheScreen();
  expect(screen.queryByLabelText("Camera for scanning the code")).toBeNull();
});

it("offers Close, not Scan again, when a new scan cannot help", async () => {
  const close = jest.fn();
  await render(wrap(<Screen close={close} />));
  await act(async () => {
    pairFlow.dispatch({ type: "connecting" });
    pairFlow.dispatch({ type: "failed", reason: "no_sync" });
  });
  expect(screen.getByText("This version of cashU has no sync set up.")).toBeOnTheScreen();
  expect(screen.queryByLabelText("Scan again")).toBeNull();
  await fireEvent.press(screen.getByText("Close"));
  expect(close).toHaveBeenCalledTimes(1);
});

it("names the Mac's own labels in the scan instruction", async () => {
  await render(wrap(<Screen close={() => {}} />));
  expect(screen.getByText("On your Mac: Settings > Devices > Pair a phone")).toBeOnTheScreen();
});

it("closes on cancel and starts over the next time", async () => {
  const close = jest.fn();
  await render(wrap(<Screen close={close} />));
  await fireEvent.changeText(screen.getByLabelText("This phone's name on your Mac"), "Mój");
  await fireEvent.press(screen.getByLabelText("Cancel"));
  expect(close).toHaveBeenCalledTimes(1);
  // The next open starts over: the default name again, not the one typed before the cancel.
  expect(pairFlow.peek()).toMatchObject({ kind: "scan", name: "iPhone 16 Pro" });
});

it("turns expired digits into Scan again", async () => {
  jest.useFakeTimers();
  try {
    await render(wrap(<Screen close={() => {}} />));
    await act(async () => {
      pairFlow.dispatch({ type: "connecting" });
      pairFlow.dispatch({ type: "sas", sas: "418207", expiresAt: Date.now() + 2000 });
    });
    expect(screen.getByLabelText("Code: 4 1 8 2 0 7")).toBeOnTheScreen();
    await act(async () => jest.advanceTimersByTime(3000));
    expect(screen.getByText(/The code expired/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText("Scan again"));
    expect(screen.getByText("Scan the code on your Mac")).toBeOnTheScreen();
  } finally {
    jest.useRealTimers();
  }
});

it("saves the role picked and moves on to the first sync", async () => {
  const saveRole = jest.fn(async () => undefined);
  await render(wrap(<Screen close={() => {}} saveRole={saveRole} />));
  await act(async () => {
    pairFlow.dispatch({ type: "connecting" });
    pairFlow.dispatch({ type: "sas", sas: "418207", expiresAt: Date.now() + 60_000 });
    pairFlow.dispatch({ type: "storing" });
    pairFlow.dispatch({ type: "stored", vault: "v1" });
  });
  await fireEvent.press(screen.getByText("This phone is my partner's"));
  await fireEvent.press(screen.getByLabelText("Continue"));
  expect(saveRole).toHaveBeenCalledWith("v1", "partner");
  expect(screen.getByText("Waiting for your data from your Mac...")).toBeOnTheScreen();
  expect(screen.getByLabelText("Open cashU")).toBeDisabled();
});

it("asks for the camera only once the modal's presentation finished and the scan step drew", async () => {
  mockCameraUnknown = true;
  const view = await render(wrap(<Screen close={() => {}} presented={false} />));
  await fireEvent(screen.getByText("Scan the code on your Mac"), "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 80 } },
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  // Still sliding in: iOS would draw the prompt over a modal that shows nothing yet.
  expect(mockRequest).not.toHaveBeenCalled();
  await view.rerender(wrap(<Screen close={() => {}} presented />));
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(mockRequest).toHaveBeenCalledTimes(1);
});

it("suggests Face ID on the last step only when the lock will be off", async () => {
  const toDone = async () => {
    await act(async () => {
      pairFlow.dispatch({ type: "connecting" });
      pairFlow.dispatch({ type: "sas", sas: "418207", expiresAt: Date.now() + 60_000 });
      pairFlow.dispatch({ type: "storing" });
      pairFlow.dispatch({ type: "stored", vault: "v1" });
      pairFlow.dispatch({ type: "roleSaved" });
    });
  };
  const view = await render(wrap(<Screen close={() => {}} lockAfter />));
  await toDone();
  expect(screen.getByText("Stored encrypted on this phone.")).toBeOnTheScreen();
  expect(screen.queryByText(/Turn on Face ID/)).toBeNull();
  await view.rerender(wrap(<Screen close={() => {}} lockAfter={false} />));
  expect(screen.getByText(/Turn on Face ID so only you can open it/)).toBeOnTheScreen();
});

describe("PairView stories", () => {
  const named = Object.entries(pairStories).filter(([name]) => name !== "default") as [
    string,
    { args: object },
  ][];
  it.each(named)("%s renders", async (_name, story) => {
    const props = { ...pairStories.default.args, ...story.args } as Parameters<typeof PairView>[0];
    await render(wrap(<PairView {...props} />));
    expect(screen.toJSON()).not.toBeNull();
  });
});
