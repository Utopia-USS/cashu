import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLAVORS } from "@cashu/node-host/flavor";
import { afterEach, expect, it } from "vitest";
import { desktopLaunch, runDesktopApp } from "./desktop.js";
import { removeTempDirs, tempDir } from "./testing/dirs.js";

afterEach(removeTempDirs);

it("uses a built source desktop with the selected data dir and a fake launcher", async () => {
  const checkout = tempDir("cashu-desktop-source-");
  const app = join(checkout, "apps", "desktop");
  mkdirSync(join(app, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(app, "dist"), { recursive: true });
  writeFileSync(join(app, "node_modules", ".bin", "electron"), "synthetic");
  writeFileSync(join(app, "dist", "main.js"), "synthetic");
  const dataDir = tempDir("cashu-desktop-data-");
  const target = desktopLaunch(
    {
      self: join(checkout, "apps", "cli", "src", "index.ts"),
      checkout,
      build: "test",
      flavor: FLAVORS.prod,
    },
    "/synthetic/node",
    checkout,
    { ELECTRON_RUN_AS_NODE: "1", CASHU_DATA_DIR: "/wrong" },
    dataDir,
    true,
  );
  expect(target).toMatchObject({
    command: join(app, "node_modules", ".bin", "electron"),
    args: [app],
    env: { CASHU_DATA_DIR: dataDir, CASHU_DESKTOP_DEBUG: "1" },
  });
  expect(target?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  if (target === null) throw new Error("synthetic desktop target missing");
  let calls = 0;
  expect(
    await runDesktopApp(target, async (value) => {
      calls++;
      expect(value).toBe(target);
      return { kind: "exit", code: 7 };
    }),
  ).toEqual({ kind: "exit", code: 7 });
  expect(calls).toBe(1);
});

it("refuses an unbuilt source checkout and an unverified package", () => {
  const checkout = tempDir("cashu-desktop-unbuilt-");
  const build = {
    self: join(checkout, "apps", "cli", "src", "index.ts"),
    checkout,
    build: "test",
    flavor: FLAVORS.prod,
  };
  expect(
    desktopLaunch(build, "/synthetic/node", checkout, {}, "/synthetic/data", false),
  ).toBeNull();
  expect(
    desktopLaunch(
      { ...build, checkout: undefined },
      "/synthetic/node",
      checkout,
      {},
      "/synthetic/data",
      false,
    ),
  ).toBeNull();
});
