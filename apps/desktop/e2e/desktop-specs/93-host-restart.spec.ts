/// <reference types="node" />
// The local host dies while the window is open. Electron main reconnects (starting a new host), the
// window keeps showing its last snapshot meanwhile (marked stale), says it is starting the background
// service, recovers, and no command is lost or applied twice:
//  1. the host is SIGKILLed while idle; a rename made during the outage waits and runs once;
//  2. the host dies right after committing a rename, before its reply (apps/host's fault host); the
//     client re-sends with the same idempotency key and the new host answers from its request table.
// The vault database is read afterwards (host stopped) to count the applied events. Own shell, own data
// dir under ~/cashu-lab (synthetic demo vault, never a real one), removed afterwards with every host.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import {
  alive,
  dashboardWindow,
  expect,
  hostPid,
  launchDesktop,
  stopHost,
  storeHarnessScript,
  test,
  until,
} from "../electron-test.ts";

const LAB_TMP = join(userInfo().homedir, "cashu-lab", "tmp");
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
  readonly before?: (dataDir: string) => Promise<() => void>;
  /** With the window open. */
  readonly during: (page: Page, dataDir: string) => Promise<void>;
  /** After the window closed and the host stopped (an open window would start a new host). */
  readonly after?: (dataDir: string) => void;
}

async function withShell(name: string, run: ShellRun): Promise<void> {
  mkdirSync(LAB_TMP, { recursive: true });
  const dataDir = mkdtempSync(join(LAB_TMP, `s56b-${name}-`));
  let undo: () => void = () => {};
  try {
    if (run.before) undo = await run.before(dataDir);
    const app = await launchDesktop({ dataDir, env: { CASHU_DESKTOP_ALLOWED_DATA_ROOT: LAB_TMP } });
    try {
      const { page } = await dashboardWindow(app);
      await page.evaluate(await storeHarnessScript());
      await run.during(page, dataDir);
    } finally {
      await app.close().catch(() => {});
    }
    await stopHost(dataDir);
    run.after?.(dataDir);
  } finally {
    undo();
    await stopHost(dataDir);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("a host killed while the window is open: the window recovers and runs the waiting command once", async () => {
  await withShell("host-killed", {
    during: async (page, dataDir) => {
      expect(await page.evaluate(() => window.cashuStoreLive.open())).toBe("Demo");
      const first = hostPid(dataDir);
      if (first === null) throw new Error("no host started");

      process.kill(first, "SIGKILL");
      await page.waitForFunction(() => {
        const s = window.cashuStoreLive.status();
        return s === "connecting" || s === "starting";
      });
      // During the outage: the last snapshot stays on screen and a command waits for the host.
      const during = await page.evaluate((name) => {
        const live = window.cashuStoreLive;
        const status = live.status();
        const shownName = live.name();
        return live.rename(name).then((id) => ({ id, status, shownName }));
      }, NEW_NAME);
      expect(["connecting", "starting"]).toContain(during.status);
      expect(during.shownName).toBe("Demo");

      expect(await page.evaluate((id) => window.cashuStoreLive.result(id), during.id)).toEqual({
        ok: true,
        value: null,
      });
      await page.evaluate((name) => window.cashuStoreLive.nameBecomes(name), NEW_NAME);
      await page.waitForFunction(() => window.cashuStoreLive.status() === "online");

      const statuses = await page.evaluate(() => window.cashuStoreLive.statuses());
      // The first port request started the host too; then the outage and the recovery.
      expect(statuses.slice(0, 2)).toEqual(["starting", "online"]);
      const outage = statuses.slice(2);
      const starting = outage.indexOf("starting");
      const recovered = outage.indexOf("recovered");
      expect(starting).toBeGreaterThanOrEqual(0);
      expect(recovered).toBeGreaterThan(starting);
      expect(statuses.at(-1)).toBe("online");
      // What the user read meanwhile (the catalog texts; the harness runs without a language source: EN).
      const shown = await page.evaluate(() => window.cashuStoreLive.shown());
      expect(shown).toContain(
        "Starting the background service… The data shown may be out of date.",
      );
      expect(shown).toContain("Connection restored.");

      const second = hostPid(dataDir);
      expect(second).not.toBe(first);
      expect(second !== null && alive(second)).toBe(true);
    },
    after: (dataDir) => expect(vaultCounts(dataDir)).toEqual({ renamed: 1, requests: 1 }),
  });
});

test("a host that dies after committing a command, before its reply: re-sent by key, applied once", async () => {
  let fault: ChildProcess | null = null;
  await withShell("reply-lost", {
    during: async (page, dataDir) => {
      expect(await page.evaluate(() => window.cashuStoreLive.open())).toBe("Demo");
      const faultPid = hostPid(dataDir);
      expect(faultPid).toBe(fault?.pid);

      const id = await page.evaluate((name) => window.cashuStoreLive.rename(name), NEW_NAME);
      expect(await page.evaluate((i) => window.cashuStoreLive.result(i), id)).toEqual({
        ok: true,
        value: null,
      });
      await page.evaluate((name) => window.cashuStoreLive.nameBecomes(name), NEW_NAME);
      // The fault host killed itself after the commit; main started the real host.
      await until(() => fault?.exitCode !== null || fault?.signalCode !== null);
      expect(fault?.signalCode).toBe("SIGKILL");
      const next = hostPid(dataDir);
      expect(next).not.toBe(faultPid);
    },
    after: (dataDir) => {
      expect(vaultCounts(dataDir)).toEqual({ renamed: 1, requests: 1 });
      expect(hostLogEvents(dataDir, "store.command.replayed")).toBe(1);
    },
    before: async (dataDir) => {
      // The host the window first connects to: apps/host's real composition with a fault hook that
      // SIGKILLs it right after its first command commit, before the reply.
      const repo = process.env.E2E_REPO as string;
      const home = mkdtempSync(join(LAB_TMP, "s56b-home-"));
      const child = spawn(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          "--experimental-strip-types",
          "--import",
          join(repo, "tools", "node-ts", "resolveTs.ts"),
          join(repo, "apps", "host", "src", "testing", "faultHost.ts"),
          dataDir,
          home,
          "1",
          "60000",
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      fault = child;
      await new Promise<void>((resolve, reject) => {
        let out = "";
        child.stdout?.on("data", (d: Buffer) => {
          out += d.toString();
          if (out.includes("ready")) resolve();
        });
        child.once("exit", (code) => reject(new Error(`the fault host exited (${code})`)));
      });
      return () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        rmSync(home, { recursive: true, force: true });
      };
    },
  });
});
