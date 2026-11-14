// When the shell opens the pairing modal by itself.
jest.mock("expo-router", () => ({}));
jest.mock("../services/ServicesProvider", () => ({}));
jest.mock("../screens/pair/pairFlow", () => ({}));
jest.mock("../platform/relayConfig", () => ({}));

import { shouldOpenPairing } from "./pairingRoute";

const first = { syncBuild: true, onlyDemo: true, shownThisLaunch: false, continues: false };

it("opens once per launch on a sync build that holds only the demo", () => {
  expect(shouldOpenPairing(first)).toBe(true);
  expect(shouldOpenPairing({ ...first, shownThisLaunch: true })).toBe(false);
  expect(shouldOpenPairing({ ...first, onlyDemo: false })).toBe(false);
  expect(shouldOpenPairing({ ...first, syncBuild: false })).toBe(false);
});

it("always reopens a pairing whose last steps wait", () => {
  expect(
    shouldOpenPairing({ syncBuild: true, onlyDemo: false, shownThisLaunch: true, continues: true }),
  ).toBe(true);
});
