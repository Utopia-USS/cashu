// Guard: the shipped host registers every UI action a client can dispatch. The desktop e2e suite
// serves a synthetic harness host that registers every action, so a production-only gap (the Signals
// actions were refused in the installed app) stays invisible there. This test runs the real `run`
// entry of main.ts, captures the exact options it hands to `startLocalHost`, and builds the UI
// action list from them the way the host does (native mode). Only the host start itself is replaced.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationQueue } from "@cashu/store/investments/local";
import { UI_ACTIONS } from "@cashu/store/ui-action-catalog";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalHostOptions } from "./localHost/options.js";
import type { HostStores } from "./stores.js";

const captured: LocalHostOptions[] = [];
vi.mock("./host.js", () => ({
  startLocalHost: async (options: LocalHostOptions) => {
    captured.push(options);
    return { safeMode: false, exit: Promise.resolve(0), stop: async () => undefined };
  },
}));

const { main } = await import("./main.js");
const { createScreenSurfaces } = await import("./localHost/screens.js");

/**
 * Actions whose provider only a packaged build binds. Each entry names the option that carries it,
 * and the test checks that this option is the reason it is absent from a source run.
 */
const PACKAGED_ONLY: Readonly<Record<string, keyof LocalHostOptions>> = {
  // hostUpdateBridge needs the verified bundle fingerprint of a packaged cashU.app.
  "device.updateAction": "updates",
};

/**
 * Known gaps, reported for an owner decision: each must still be missing (an entry fails once the
 * action is wired, so the list only shrinks).
 */
const REPORTED_GAPS: Readonly<Record<string, string>> = {
  // The manual Import drawer asks the host to pick the file, but no production file-pick channel
  // exists. Owner rule: an agent-doable flow needs no manual code; investment imports go through
  // MCP propose_import and the owner's approval (core.desktopProposals.review), which is wired.
  "investments.import.preview": "manual import flow: agent path is propose_import",
  "investments.import.commit": "manual import flow: agent path is propose_import",
};

const roots: string[] = [];
afterEach(() => {
  captured.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function productionOptions(): Promise<LocalHostOptions> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cashu-production-actions-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  const errors: string[] = [];
  const code = await main(["run", "--data-dir", dataDir], {
    env: {
      HOME: home,
      CASHU_TESTING: "1",
      CASHU_DATA_DIR: dataDir,
      CASHU_WORKSPACES_DIR: join(root, "workspaces"),
      CASHU_LEGACY_DATA_DIR: join(root, "legacy"),
    },
    build: "production-actions-test",
    stdout: () => undefined,
    stderr: (line) => {
      errors.push(line);
    },
    onSignal: () => undefined,
  });
  expect(errors).toEqual([]);
  expect(code).toBe(0);
  expect(captured).toHaveLength(1);
  const options = captured[0];
  if (options === undefined) throw new Error("main did not start the host");
  return options;
}

/** The action ids a native host serves for `options` (host.ts: `screens.uiActions(signalActions)`). */
function registeredIds(options: LocalHostOptions): Set<string> {
  expect(options.vaultSource?.kind).toBe("native-production");
  const screens = createScreenSurfaces({ options, nativeMode: true, now: () => 0 });
  try {
    // Binding is lazy: building the list never reads the stores, the queue or the prices.
    const signals = screens.signalActions({
      stores: { vaults: new Map() } as unknown as HostStores,
      queue: {} as NotificationQueue,
      prices: null,
    });
    return new Set(screens.uiActions(signals).map((action) => action.id));
  } finally {
    screens.close();
  }
}

it("registers every dispatchable UI action in the production host wiring", async () => {
  const options = await productionOptions();
  const registered = registeredIds(options);
  for (const [id, option] of Object.entries(PACKAGED_ONLY)) {
    expect(options[option], `${id} is packaged-only because ${option} is unset`).toBeUndefined();
  }
  const missing = UI_ACTIONS.map((action) => action.id).filter(
    (id) =>
      !registered.has(id) && PACKAGED_ONLY[id] === undefined && REPORTED_GAPS[id] === undefined,
  );
  expect(missing, "UI actions the shipped host refuses as unknown_action").toEqual([]);
  const wired = Object.keys(REPORTED_GAPS).filter((id) => registered.has(id));
  expect(wired, "wired now: remove them from REPORTED_GAPS").toEqual([]);
});

it("approves every proposal kind the drawer offers in the production host wiring", async () => {
  const options = await productionOptions();
  // Imports (connector runtime) and strategy / custom-rule proposals (native strategy files).
  expect(options.proposals).toBeDefined();
  expect(options.strategyProposals).toBeDefined();
});

it("lists each catalog action once", () => {
  const ids = UI_ACTIONS.map((action) => action.id);
  expect(new Set(ids).size).toBe(ids.length);
});
