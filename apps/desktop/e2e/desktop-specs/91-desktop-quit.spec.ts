/// <reference types="node" />
// Quitting leaves no sidecar behind. Own Electron app and own seeded demo data dir.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  alive,
  dashboardWindow,
  expect,
  launchDesktop,
  launchEnv,
  portFree,
  sidecarPids,
  test,
} from "../electron-test.ts";

/** A demo data dir of its own for a test that launches its own shell. */
function seed(name: string): string {
  const dataDir = join(process.env.E2E_ROOT as string, name);
  const result = spawnSync(
    process.env.E2E_PYTHON as string,
    [join(process.env.E2E_REPO ?? "", "scripts", "demo_data.py"), "--data-dir", dataDir],
    { env: launchEnv(dataDir), encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return dataDir;
}

test("quit stops the sidecar and frees the port", async () => {
  const dataDir = seed("data-quit");
  const app = await launchDesktop({ dataDir });
  const { origin } = await dashboardWindow(app);
  const port = Number(new URL(origin).port);
  const pids = sidecarPids(app.process().pid as number);
  expect(pids).toHaveLength(1);

  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  const closed = new Promise<void>((done) => app.process().once("exit", () => done()));
  await Promise.race([
    closed,
    new Promise((_, no) => setTimeout(() => no(new Error("electron did not quit")), 30_000)),
  ]);

  for (const pid of pids) expect(alive(pid)).toBe(false);
  expect(await portFree(port)).toBe(true);
  expect(existsSync(join(dataDir, "api-token"))).toBe(false);
});

test("a SIGKILLed shell leaves no orphan sidecar behind", async () => {
  const dataDir = seed("data-orphan");
  const app = await launchDesktop({ dataDir });
  const { origin } = await dashboardWindow(app);
  const port = Number(new URL(origin).port);
  const [pid, ...others] = sidecarPids(app.process().pid as number);
  expect(pid).toBeDefined();
  expect(others).toHaveLength(0);

  // No handler, no before-quit: only the closed stdin pipe tells the sidecar (core/parent_pipe.py).
  const exited = new Promise<void>((done) => app.process().once("exit", () => done()));
  app.process().kill("SIGKILL");
  await exited;
  await expect.poll(() => alive(pid as number), { timeout: 15_000, intervals: [100] }).toBe(false);
  await expect.poll(() => portFree(port), { timeout: 5_000 }).toBe(true);
  expect(existsSync(join(dataDir, "api-token"))).toBe(false);
});
