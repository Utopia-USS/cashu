/// <reference types="node" />
// Quitting leaves no sidecar behind. Own Electron app and own seeded demo data dir.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dashboardWindow, expect, launchDesktop, launchEnv, test } from "../electron-test.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function serving(port: number): string {
  const r = spawnSync("pgrep", ["-f", "--", `serve_offline.py --port ${port}( |$)`], {
    encoding: "utf8",
  });
  return r.stdout.trim();
}

async function portFree(port: number): Promise<boolean> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

test("quit stops the sidecar and frees the port", async () => {
  const root = process.env.E2E_ROOT as string;
  const dataDir = join(root, "data-quit");
  const env = launchEnv(dataDir);
  const seed = spawnSync(
    process.env.E2E_PYTHON as string,
    [join(process.env.E2E_REPO ?? "", "scripts", "demo_data.py"), "--data-dir", dataDir],
    { env, encoding: "utf8" },
  );
  expect(seed.status).toBe(0);

  const app = await launchDesktop({ dataDir });
  const { origin } = await dashboardWindow(app);
  const port = Number(new URL(origin).port);
  expect(serving(port)).not.toBe("");
  const pids = serving(port).split("\n").map(Number);

  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  const closed = new Promise<void>((done) => app.process().once("exit", () => done()));
  await Promise.race([
    closed,
    new Promise((_, no) => setTimeout(() => no(new Error("electron did not quit")), 30_000)),
  ]);

  expect(serving(port)).toBe("");
  for (const pid of pids) expect(alive(pid)).toBe(false);
  expect(await portFree(port)).toBe(true);
  expect(existsSync(join(dataDir, "api-token"))).toBe(false);
});
