// @vitest-environment jsdom

import {
  type RecoveryImportEvent,
  type StartupFailureReport,
  startupFailure,
} from "@cashu/host-protocol/startup-failure";
import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RecoveryBridge } from "../recoveryBridge.js";
import { RecoveryScreen } from "./RecoveryScreen.js";

const WORDS = Array.from("abcdefghijklmnopqrstuvwx", (letter) => `test${letter}`).join(" ");

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
  let emit: (event: RecoveryImportEvent) => void = () => {};
  const bridge = {
    copyPrompt: vi.fn(async () => true),
    copyMcpCommands: vi.fn(async () => true),
    openDataFolder: vi.fn(async () => true),
    retry: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
    importData: vi.fn(async () => true),
    confirmWords: vi.fn(async () => true),
    onImportEvent: (handler: (event: RecoveryImportEvent) => void) => {
      emit = handler;
      return () => {
        emit = () => {};
      };
    },
  } satisfies RecoveryBridge;
  return { bridge, emit: (event: RecoveryImportEvent) => act(async () => emit(event)) };
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
const phrase = () => container.querySelector('[data-testid="migration-recovery-phrase"]');

it("runs the import: progress, words shown once, cleared on continue", async () => {
  const { bridge, emit } = fakeBridge();
  await act(async () =>
    root.render(
      <RecoveryScreen report={report(startupFailure("python_data_present"))} bridge={bridge} />,
    ),
  );
  expect(container.textContent).toContain("data from the previous version of cashU");
  await act(async () => button("Import my data")?.click());
  expect(bridge.importData).toHaveBeenCalledTimes(1);
  await emit({ kind: "progress", stage: "copy" });
  expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
    "Copying the data",
  );
  expect(button("Try again")?.disabled).toBe(true);
  await emit({ kind: "words", words: WORDS });
  expect(phrase()?.textContent).toBe(WORDS);
  expect(button("Continue the import")?.disabled).toBe(true);
  await act(async () =>
    (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
  );
  await act(async () => button("Continue the import")?.click());
  expect(bridge.confirmWords).toHaveBeenCalledWith(true);
  expect(phrase()).toBeNull();
  expect(container.textContent).not.toContain(WORDS);
  await emit({ kind: "progress", stage: "cutover" });
  expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
    "Switching to the new data",
  );
});

it("lists the instruments a finished import cannot value, then opens the app", async () => {
  const { bridge, emit } = fakeBridge();
  await act(async () =>
    root.render(
      <RecoveryScreen report={report(startupFailure("python_data_present"))} bridge={bridge} />,
    ),
  );
  await act(async () => button("Import my data")?.click());
  await emit({ kind: "progress", stage: "cutover" });
  await emit({
    kind: "done",
    unpriced: [
      { label: "SEUR", currency: "EUR", reason: "no_fx" },
      { label: "SPLN", currency: "PLN", reason: "no_prices" },
    ],
    mcpCommands: [],
    agents: null,
  });
  expect(container.querySelector('[data-testid="recovery-mcp"]')).toBeNull();
  expect(container.querySelector('[data-testid="recovery-agents"]')).toBeNull();
  expect(container.textContent).toContain("The import finished.");
  expect(container.querySelector('[data-testid="recovery-import-stages"]')).toBeNull();
  expect(
    [...container.querySelectorAll('[data-testid="recovery-unpriced"] li')].map(
      (item) => item.textContent,
    ),
  ).toEqual(["SEUR (EUR): no PLN/EUR rate", "SPLN (PLN): no prices"]);
  await act(async () => button("Open cashU")?.click());
  expect(bridge.retry).toHaveBeenCalledTimes(1);
});

it("shows the MCP lines to re-add, copies them through main, and the agents result", async () => {
  const { bridge, emit } = fakeBridge();
  await act(async () =>
    root.render(
      <RecoveryScreen report={report(startupFailure("python_data_present"))} bridge={bridge} />,
    ),
  );
  await act(async () => button("Import my data")?.click());
  const mcpCommands = [
    "claude mcp remove cashu-synthetic",
    "claude mcp add cashu-synthetic -- /synthetic/bin/cashu mcp --profile synthetic",
  ];
  await emit({
    kind: "done",
    unpriced: [],
    mcpCommands,
    agents: {
      bootout: "ran",
      agents: [
        { label: "io.utopiasoft.cashu.worker", state: "retired" },
        { label: "io.github.synszakala.finanse.worker", state: "failed" },
      ],
    },
  });
  expect(container.textContent).toContain("The import finished.");
  expect(container.querySelector('[data-testid="recovery-unpriced"]')).toBeNull();
  const mcp = container.querySelector('[data-testid="recovery-mcp"]');
  expect(mcp?.textContent).toContain("Connect your AI agent again");
  expect(mcp?.textContent).toContain(mcpCommands.join("\n"));
  expect(container.querySelector('[data-testid="recovery-agents"]')?.textContent).toBe(
    "The old app's background agents (launchd): io.utopiasoft.cashu.worker: removed; io.github.synszakala.finanse.worker: failed.",
  );
  expect(container.querySelector('[data-testid="recovery-agents-by-hand"]')?.textContent).toBe(
    [
      "launchctl bootout gui/$(id -u)/io.github.synszakala.finanse.worker",
      "rm -f ~/Library/LaunchAgents/io.github.synszakala.finanse.worker.plist",
    ].join("\n"),
  );
  await act(async () => button("Copy")?.click());
  expect(bridge.copyMcpCommands).toHaveBeenCalledTimes(1);
  expect(bridge.copyPrompt).not.toHaveBeenCalled();
  expect(mcp?.textContent).toContain("Commands copied.");
  await act(async () => button("Open cashU")?.click());
  expect(bridge.retry).toHaveBeenCalledTimes(1);
});

it("cancels at the words and returns to the import button", async () => {
  const { bridge, emit } = fakeBridge();
  await act(async () =>
    root.render(
      <RecoveryScreen report={report(startupFailure("python_data_present"))} bridge={bridge} />,
    ),
  );
  await act(async () => button("Import my data")?.click());
  await emit({ kind: "words", words: WORDS });
  await act(async () => button("Cancel the import")?.click());
  expect(bridge.confirmWords).toHaveBeenCalledWith(false);
  expect(phrase()).toBeNull();
  expect(container.textContent).toContain("Cancelling the import...");
  await emit({ kind: "cancelled" });
  expect(button("Import my data")).toBeDefined();
  expect(container.textContent).toContain("The import was cancelled; nothing was created.");
});

it("offers finishing an interrupted import, and no import for other codes", async () => {
  const { bridge } = fakeBridge();
  await act(async () =>
    root.render(
      <RecoveryScreen report={report(startupFailure("migration_incomplete"))} bridge={bridge} />,
    ),
  );
  expect(button("Finish the import")).toBeDefined();
  await act(async () =>
    root.render(
      <RecoveryScreen report={report(startupFailure("vault_key_unavailable"))} bridge={bridge} />,
    ),
  );
  expect(button("Import my data")).toBeUndefined();
  expect(button("Finish the import")).toBeUndefined();
  await act(async () => button("Copy prompt for agent")?.click());
  expect(bridge.copyPrompt).toHaveBeenCalledWith("en");
  expect(container.textContent).toContain("Prompt copied.");
});

it("shows a refused import and the missing report", async () => {
  const { bridge } = fakeBridge();
  bridge.importData.mockResolvedValueOnce(false);
  await act(async () =>
    root.render(
      <RecoveryScreen report={report(startupFailure("python_data_present"))} bridge={bridge} />,
    ),
  );
  await act(async () => button("Import my data")?.click());
  expect(container.textContent).toContain("The import could not be started.");
  await act(async () => root.render(<RecoveryScreen report={null} bridge={null} />));
  expect(container.textContent).toContain("The start-up failure report could not be read.");
  expect(button("Quit")?.disabled).toBe(true);
});
