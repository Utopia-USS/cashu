/// <reference types="node" />
// The local host dies while the window is open. Electron main reconnects, the
// window keeps showing its last snapshot meanwhile (marked stale) and recovers once the spec starts a
// replacement host (main's own host starts are denied by host-spawn-guard.cjs):
//  1. the host is SIGKILLed while idle; after recovery a fresh rename runs once;
//  2. the host dies right after committing a rename, before its reply (apps/host's fault host); the
//     original result stays unknown until a read-only same-key lookup proves completion.
// The vault database is read afterwards (host stopped) to count the applied events. Own shell, own data
// dir under the isolated E2E root (synthetic demo vault), removed afterwards with every host.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import {
  alive,
  expect,
  hostPid,
  launchGuardedDesktop,
  stopHost,
  storeHarnessWindow,
  test,
  until,
} from "../electron-test.ts";
import { type SyntheticHost, startSyntheticHost } from "../synthetic-host.ts";

function isolatedRoot(): string {
  const root = process.env.E2E_ROOT;
  if (!root) throw new Error("isolated E2E root is absent");
  return join(root, "native-host");
}
const NEW_NAME = "Demo po restarcie";

type Live = {
  open(): Promise<string | null>;
  name(): string | null | undefined;
  status(): string | null;
  statuses(): string[];
  shown(): string[];
  statusText(): string | null;
  rename(name: string): Promise<number>;
  result(id: number): Promise<unknown>;
  reconcile(id: number): Promise<unknown>;
  nameBecomes(name: string): Promise<void>;
};

declare const window: { cashuStoreLive: Live };

/** `profile.renamed` events in the data dir's one vault, and the host's request-table rows. */
function vaultCounts(dataDir: string): { renamed: number; requests: number } {
  const dir = join(dataDir, "stores", "vaults");
  const files = readdirSync(dir).filter((f) => f.endsWith(".db"));
  expect(files).toHaveLength(1);
  const db = new DatabaseSync(join(dir, files[0] as string), { readOnly: true });
  try {
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      renamed: count("SELECT count(*) AS n FROM event_log WHERE type = 'profile.renamed'"),
      requests: count("SELECT count(*) AS n FROM host_requests"),
    };
  } finally {
    db.close();
  }
}

/** Lines of the host log with event `event` (the log also holds the hosts' plain stdout lines). */
function hostLogEvents(dataDir: string, event: string): number {
  return readFileSync(join(dataDir, "logs", "host.log"), "utf8")
    .split("\n")
    .filter(
      (line) => line.startsWith("{") && (JSON.parse(line) as { event?: string }).event === event,
    ).length;
}

interface ShellRun {
  /** Before the shell starts (returns its own cleanup). */
  readonly before?: (dataDir: string) => Promise<() => Promise<void>>;
  /** With the window open. */
  readonly during: (page: Page, dataDir: string) => Promise<void>;
  /** After the window closed and the host stopped (an open window would start a new host). */
  readonly after?: (dataDir: string) => void;
}

async function withShell(name: string, run: ShellRun): Promise<void> {
  const root = isolatedRoot();
  mkdirSync(root, { recursive: true });
  const dataDir = mkdtempSync(join(root, `s56b-${name}-`));
  let undo: () => Promise<void> = async () => {};
  try {
    if (run.before) undo = await run.before(dataDir);
    // Main may not start a host of its own: the production host cannot serve a synthetic vault and
    // would show the recovery screen; the outage ends with the spec's replacement host.
    const app = await launchGuardedDesktop({
      dataDir,
      env: { CASHU_DESKTOP_ALLOWED_DATA_ROOT: root },
    });
    try {
      const page = await storeHarnessWindow(app);
      await run.during(page, dataDir);
    } finally {
      await app.close().catch(() => {});
    }
    await stopHost(dataDir);
    run.after?.(dataDir);
  } finally {
    await undo();
    await stopHost(dataDir);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("a host killed while the window is open: the window recovers and runs a fresh command once", async () => {
  let replacement: SyntheticHost | undefined;
  await withShell("host-killed", {
    during: async (page, dataDir) => {
      expect(await page.evaluate(() => window.cashuStoreLive.open())).toBe("Demo");
      const first = hostPid(dataDir);
      if (first === null) throw new Error("no host started");

      process.kill(first, "SIGKILL");
      await page.waitForFunction(() => {
        const s = window.cashuStoreLive.status();
        return s === "connecting" || s === "starting" || s === "unavailable";
      });
      // During the outage the last snapshot stays on screen.
      const during = await page.evaluate(() => {
        const live = window.cashuStoreLive;
        const status = live.status();
        const shownName = live.name();
        return { status, shownName };
      });
      // Main's own start is denied, so the relay may already report the host unavailable.
      expect(["connecting", "starting", "unavailable"]).toContain(during.status);
      expect(during.shownName).toBe("Demo");
      replacement = await startSyntheticHost(dataDir);
      await page.waitForFunction(() => window.cashuStoreLive.status() === "online");
      const id = await page.evaluate((name) => window.cashuStoreLive.rename(name), NEW_NAME);
      expect(await page.evaluate((run) => window.cashuStoreLive.result(run), id)).toEqual({
        kind: "completed",
        value: null,
      });
      await page.evaluate((name) => window.cashuStoreLive.nameBecomes(name), NEW_NAME);

      const statuses = await page.evaluate(() => window.cashuStoreLive.statuses());
      // The initial synthetic host was already available; then came the outage and recovery.
      expect(statuses[0]).toBe("online");
      const outage = statuses.slice(1);
      const connecting = outage.indexOf("connecting");
      const recovered = outage.indexOf("recovered");
      expect(connecting).toBeGreaterThanOrEqual(0);
      expect(recovered).toBeGreaterThan(connecting);
      expect(statuses.at(-1)).toBe("online");
      // What the user read meanwhile (the catalog texts; the harness runs without a language source: EN).
      const shown = await page.evaluate(() => window.cashuStoreLive.shown());
      expect(shown.some((text) => text.includes("The data shown may be out of date."))).toBe(true);
      expect(shown).toContain("Connection restored.");

      const second = hostPid(dataDir);
      expect(second).not.toBe(first);
      expect(second !== null && alive(second)).toBe(true);
    },
    after: (dataDir) => expect(vaultCounts(dataDir)).toEqual({ renamed: 1, requests: 1 }),
    before: async (dataDir) => {
      const initial = await startSyntheticHost(dataDir);
      return async () => {
        await replacement?.stop();
        await initial.stop();
      };
    },
  });
});

test("a host that dies after commit: an unknown command reconciles by read-only lookup", async () => {
  let fault: SyntheticHost | undefined;
  let replacement: SyntheticHost | undefined;
  await withShell("reply-lost", {
    during: async (page, dataDir) => {
      expect(await page.evaluate(() => window.cashuStoreLive.open())).toBe("Demo");
      const faultPid = hostPid(dataDir);
      expect(faultPid).toBe(fault?.child.pid);

      const id = await page.evaluate((name) => window.cashuStoreLive.rename(name), NEW_NAME);
      expect(await page.evaluate((i) => window.cashuStoreLive.result(i), id)).toMatchObject({
        kind: "outcome_unknown",
        key: expect.any(String),
      });
      // The fault host killed itself after the commit; main started the real host.
      await until(() => fault?.child.exitCode !== null || fault?.child.signalCode !== null);
      expect(fault?.child.signalCode).toBe("SIGKILL");
      replacement = await startSyntheticHost(dataDir);
      const next = hostPid(dataDir);
      expect(next).not.toBe(faultPid);
      await page.waitForFunction(() => window.cashuStoreLive.status() === "online");
      expect(await page.evaluate((i) => window.cashuStoreLive.reconcile(i), id)).toEqual({
        kind: "completed",
        value: null,
      });
      await page.evaluate((name) => window.cashuStoreLive.nameBecomes(name), NEW_NAME);
    },
    after: (dataDir) => {
      expect(vaultCounts(dataDir)).toEqual({ renamed: 1, requests: 1 });
      expect(hostLogEvents(dataDir, "store.command.replayed")).toBe(0);
    },
    before: async (dataDir) => {
      // The fault host kills itself right after its first command commit, before the reply.
      fault = await startSyntheticHost(dataDir, 1);
      return async () => {
        await replacement?.stop();
        await fault?.stop();
      };
    },
  });
});
