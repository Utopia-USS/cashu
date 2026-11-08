// @vitest-environment jsdom

import { type StartupFailureReport, startupFailure } from "@cashu/host-protocol/startup-failure";
import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RecoveryBridge } from "../recoveryBridge.js";
import { RecoveryScreen } from "./RecoveryScreen.js";

const report = (failure: StartupFailureReport["failure"]): StartupFailureReport => ({
  format: 1,
  failure,
  at: "2026-11-04T09:30:00.000Z",
  appVersion: "0.6.0",
  build: "desktop-dev",
  dataDir: "~/cashU",
  reportFile: null,
  logTail: [],
  omittedLogLines: 0,
  command: { kind: "checkout" },
});

function fakeBridge() {
  return {
    copyPrompt: vi.fn(async () => true),
    openDataFolder: vi.fn(async () => true),
    retry: vi.fn(async () => {}),
    continueWithoutOldData: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
  } satisfies RecoveryBridge;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLanguageForTests("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label);
const headings = () => [...container.querySelectorAll("h2")].map((item) => item.textContent);
const oldData = report(startupFailure("python_data_present", "python_data_found"));

it("explains old app data, copies the agent prompt and continues to first-run setup", async () => {
  const bridge = fakeBridge();
  await act(async () => root.render(<RecoveryScreen report={oldData} bridge={bridge} />));
  expect(headings()).toContain("Data from the previous version of cashU");
  expect(headings()).not.toContain("cashU cannot start");
  expect(container.textContent).toContain("your AI agent can bring it over");
  expect(container.textContent).toContain("never opens, moves or changes them");
  expect(container.querySelector('[data-testid="recovery-prompt"]')?.textContent).toContain(
    "import-builder skill",
  );
  await act(async () => button("Copy prompt for agent")?.click());
  expect(bridge.copyPrompt).toHaveBeenCalledWith("en");
  expect(container.textContent).toContain("Prompt copied.");
  await act(async () => button("Continue without the old data")?.click());
  expect(bridge.continueWithoutOldData).toHaveBeenCalledTimes(1);
  expect(bridge.retry).not.toHaveBeenCalled();
});

it("offers no Continue for a real start-up failure", async () => {
  const bridge = fakeBridge();
  await act(async () =>
    root.render(
      <RecoveryScreen report={report(startupFailure("vault_key_unavailable"))} bridge={bridge} />,
    ),
  );
  expect(headings()).toContain("cashU cannot start");
  expect(button("Continue without the old data")).toBeUndefined();
  await act(async () => button("Try again")?.click());
  expect(bridge.retry).toHaveBeenCalledTimes(1);
});

it("words the old-data screen in Polish", async () => {
  setLanguageForTests("pl");
  const bridge = fakeBridge();
  await act(async () => root.render(<RecoveryScreen report={oldData} bridge={bridge} />));
  expect(headings()).toContain("Dane z poprzedniej wersji cashU");
  await act(async () => button("Kontynuuj bez starych danych")?.click());
  expect(bridge.continueWithoutOldData).toHaveBeenCalledTimes(1);
});

it("shows the missing report", async () => {
  await act(async () => root.render(<RecoveryScreen report={null} bridge={null} />));
  expect(container.textContent).toContain("The start-up failure report could not be read.");
  expect(button("Quit")?.disabled).toBe(true);
});
