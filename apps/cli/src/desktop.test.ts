import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLAVORS } from "@cashu/node-host/flavor";
import { writeWindowsInstall } from "@cashu/node-host/testing/windows-install";
import { afterEach, expect, it } from "vitest";
import { desktopLaunch, runDesktopApp, sourceElectronBinary } from "./desktop.js";
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

const sourceBuild = (checkout: string) => ({
  self: join(checkout, "apps", "cli", "src", "index.ts"),
  checkout,
  build: "test",
  flavor: FLAVORS.prod,
});

it("runs a Windows source checkout's Electron binary that the electron package exports", () => {
  const checkout = tempDir("cashu-desktop-win-source-");
  const app = join(checkout, "apps", "desktop");
  mkdirSync(join(app, "dist"), { recursive: true });
  writeFileSync(join(app, "dist", "main.js"), "synthetic");
  // Only the sh script exists under .bin: Windows must not spawn it.
  mkdirSync(join(app, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(app, "node_modules", ".bin", "electron"), "synthetic");
  const binary = join(checkout, "electron.exe");
  writeFileSync(binary, "synthetic");
  const asked: string[] = [];
  const windows = (found: string | null) => ({
    platform: "win32" as const,
    electronBinary: (desktopApp: string) => {
      asked.push(desktopApp);
      return found;
    },
  });
  const args = [sourceBuild(checkout), "C:\\node.exe", checkout, {}, "C:\\data", false] as const;
  expect(desktopLaunch(...args, windows(binary))).toMatchObject({ command: binary, args: [app] });
  expect(asked).toEqual([app]);
  // The package or its downloaded binary missing: no launch.
  expect(desktopLaunch(...args, windows(null))).toBeNull();
  expect(desktopLaunch(...args, windows(join(checkout, "missing.exe")))).toBeNull();
});

it("resolves the checkout's Electron binary through the electron package, null without one", () => {
  const desktop = join(import.meta.dirname, "..", "..", "desktop");
  const binary = sourceElectronBinary(desktop);
  expect(binary).not.toBeNull();
  expect(realpathSync(binary ?? "")).toContain(join("node_modules", "electron", "dist"));
  expect(sourceElectronBinary("/cashu-nonexistent/apps/desktop")).toBeNull();
});

it("opens a verified Windows install's own cashU.exe and refuses anything else", () => {
  const root = realpathSync.native(tempDir("cashu-desktop-win-install-"));
  const install = writeWindowsInstall(join(root, "Programs", "cashu"));
  const self = join(install, "resources", "shim.mjs");
  const exe = join(install, "cashU.exe");
  const packaged = { self, checkout: undefined, build: "test", flavor: FLAVORS.prod };
  const windows = {
    platform: "win32" as const,
    electronBinary: () => {
      throw new Error("a packaged launch never resolves a source Electron");
    },
  };
  const target = desktopLaunch(
    packaged,
    exe,
    "C:\\anywhere",
    { ELECTRON_RUN_AS_NODE: "1" },
    "C:\\data",
    false,
    windows,
  );
  expect(target).toMatchObject({ command: exe, args: [], cwd: join(root, "Programs") });
  expect(target?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  const launch = (build: typeof packaged, execPath: string) =>
    desktopLaunch(build, execPath, "C:\\anywhere", {}, "C:\\data", false, windows);
  // Another executable, a shim outside the resources, the macOS reading of the same tree: refused.
  writeFileSync(join(root, "other.exe"), "synthetic");
  expect(launch(packaged, join(root, "other.exe"))).toBeNull();
  expect(launch({ ...packaged, self: join(install, "shim.mjs") }, exe)).toBeNull();
  expect(
    desktopLaunch(packaged, exe, "/", {}, "/data", false, { ...windows, platform: "darwin" }),
  ).toBeNull();
  // A tampered install no longer verifies.
  writeFileSync(join(install, "resources", "host.mjs"), "// changed");
  expect(launch(packaged, exe)).toBeNull();
});
