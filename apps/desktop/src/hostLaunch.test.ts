import { describe, expect, it } from "vitest";
import { hostLaunch } from "./hostLaunch.js";

const base = {
  root: "/repo",
  dataDir: "/lab/data",
  execPath: "/apps/Electron",
  resourcesPath: "/apps/cashU.app/Contents/Resources",
  env: { CASHU_DATA_DIR: "/lab/data", PATH: "/usr/bin" },
  build: "desktop-dev",
  command: "run" as const,
};

describe("hostLaunch", () => {
  it("runs the host's dev entry with this Electron binary in Node mode", () => {
    const launch = hostLaunch({ ...base, isPackaged: false });
    expect(launch.command).toBe("/apps/Electron");
    expect(launch.args).toEqual([
      "--disable-warning=ExperimentalWarning",
      "--import",
      "/repo/tools/node-ts/resolveTs.ts",
      "/repo/apps/host/src/cli.ts",
      "run",
      "--data-dir",
      "/lab/data",
    ]);
    expect(launch.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      CASHU_BUILD: "desktop-dev",
      PATH: "/usr/bin",
    });
  });

  it("runs the bundled host of a packaged app", () => {
    const launch = hostLaunch({ ...base, isPackaged: true });
    expect(launch.args).toEqual([
      "/apps/cashU.app/Contents/Resources/host.mjs",
      "run",
      "--data-dir",
      "/lab/data",
      "--bundle",
      "/apps/cashU.app/Contents/Resources/host.mjs",
    ]);
  });

  it("runs the migration with the same entry, binary and environment", () => {
    const dev = hostLaunch({ ...base, isPackaged: false, command: "migrate" });
    expect(dev.args).toEqual([
      "--disable-warning=ExperimentalWarning",
      "--import",
      "/repo/tools/node-ts/resolveTs.ts",
      "/repo/apps/host/src/cli.ts",
      "migrate",
      "--data-dir",
      "/lab/data",
      "--json",
    ]);
    expect(dev.env).toEqual(hostLaunch({ ...base, isPackaged: false }).env);
    expect(hostLaunch({ ...base, isPackaged: true, command: "migrate" }).args).toEqual([
      "/apps/cashU.app/Contents/Resources/host.mjs",
      "migrate",
      "--data-dir",
      "/lab/data",
      "--json",
    ]);
  });

  it("does not change the shell's own environment", () => {
    const env = { PATH: "/usr/bin" };
    hostLaunch({ ...base, env, isPackaged: false });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});
