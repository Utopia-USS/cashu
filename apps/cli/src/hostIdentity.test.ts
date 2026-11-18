import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBundleIdentity } from "@cashu/node-host/bundle-identity";
import { FLAVORS } from "@cashu/node-host/flavor";
import { writeWindowsInstall } from "@cashu/node-host/testing/windows-install";
import { afterEach, expect, it } from "vitest";
import {
  existingHost,
  type HostTarget,
  hostCommand,
  packagedShimBuild,
  reachHost,
} from "./host.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("passes the fixed host entry as the packaged bundle stamp", () => {
  const build = {
    self: "/Synthetic/cashU.app/Contents/Resources/shim.mjs",
    checkout: undefined,
    build: "desktop-1.0.0",
    flavor: FLAVORS.prod,
  };
  const command = hostCommand(
    build,
    "/Synthetic/data",
    "/Synthetic/cashU.app/Contents/MacOS/cashU",
    [],
    "/",
  );
  // join: the same expectation holds on a Windows runner, whose separators differ.
  const entry = join("/Synthetic/cashU.app/Contents/Resources", "host.mjs");
  expect(command.args).toEqual([entry, "run", "--data-dir", "/Synthetic/data", "--bundle", entry]);
});

// POSIX spelling of the source paths; the Windows form (a file: URL) is @cashu/node-host sourceRun.test.
it.skipIf(process.platform === "win32")(
  "hands a source host the shim's source-run flags with an absolute --import",
  () => {
    const build = {
      self: "/Synthetic/cashu/apps/cli/src/index.ts",
      checkout: "/Synthetic/cashu",
      build: "source-synthetic",
      flavor: FLAVORS.prod,
    };
    const argv = [
      "--experimental-strip-types",
      "--import",
      "./tools/node-ts/resolveTs.ts",
      "--inspect",
    ];
    expect(
      hostCommand(build, "/Synthetic/data", "/usr/bin/node", argv, "/Synthetic/cashu").args,
    ).toEqual([
      "--experimental-transform-types",
      "--import",
      "/Synthetic/cashu/tools/node-ts/resolveTs.ts",
      "/Synthetic/cashu/apps/host/src/cli.ts",
      "run",
      "--data-dir",
      "/Synthetic/data",
    ]);
  },
);

it("refuses a stale or moved packaged shim before any host connection or spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-shim-identity-"));
  roots.push(root);
  const resources = join(root, "cashU.app", "Contents", "Resources");
  const macos = join(root, "cashU.app", "Contents", "MacOS");
  mkdirSync(resources, { recursive: true });
  mkdirSync(macos, { recursive: true });
  const self = join(resources, "shim.mjs");
  const execPath = join(macos, "cashU");
  writeFileSync(self, "// stale shim");
  writeFileSync(execPath, "// stale executable");
  const target: HostTarget = {
    dataDir: join(root, "data"),
    build: { self, checkout: undefined, build: "desktop-1.0.0", flavor: FLAVORS.prod },
    env: { ELECTRON_RUN_AS_NODE: "1" },
    execPath,
    execArgv: [],
    cwd: root,
  };
  await expect(existingHost(target, "admin")).rejects.toThrow("packaged_shim_identity_unavailable");
  await expect(reachHost(target, "ui")).rejects.toThrow("packaged_shim_identity_unavailable");
});

it("reads a Windows install's build and flavor from its verified identity record", () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-shim-win-"));
  roots.push(root);
  const install = realpathSync.native(
    writeWindowsInstall(join(root, "cashU"), { version: "2.3.4" }),
  );
  const self = join(install, "resources", "shim.mjs");
  const exe = join(install, "cashU.exe");
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  const identity = readBundleIdentity(install, "win32");
  if (identity.kind !== "present") throw new Error("synthetic install did not verify");
  expect(packagedShimBuild(self, exe, env, "win32")).toEqual({
    build: `desktop-2.3.4-${identity.contentDigest}`,
    flavor: FLAVORS.prod,
  });
  // NTFS is case-insensitive: the JS realpath of the shim may differ from the native one in case.
  const upper = join(install, "resources", "SHIM.MJS");
  expect(packagedShimBuild(upper, exe, env, "win32").flavor).toBe(FLAVORS.prod);
  const staging = realpathSync.native(
    writeWindowsInstall(join(root, "staging"), { bundleId: FLAVORS.staging.bundleId }),
  );
  expect(
    packagedShimBuild(
      join(staging, "resources", "shim.mjs"),
      join(staging, "cashU.exe"),
      env,
      "win32",
    ).flavor,
  ).toBe(FLAVORS.staging);
  // Not in Node mode, another executable, another entry, the macOS layout: refused.
  expect(() => packagedShimBuild(self, exe, {}, "win32")).toThrow(
    "packaged_shim_identity_unavailable",
  );
  writeFileSync(join(install, "electron.exe"), "binary");
  expect(() => packagedShimBuild(self, join(install, "electron.exe"), env, "win32")).toThrow(
    "packaged_shim_identity_unavailable",
  );
  expect(() =>
    packagedShimBuild(join(install, "resources", "host.mjs"), exe, env, "win32"),
  ).toThrow("packaged_shim_identity_unavailable");
  expect(() => packagedShimBuild(self, exe, env, "darwin")).toThrow(
    "packaged_shim_identity_unavailable",
  );
  // A tampered resource fails the manifest.
  writeFileSync(join(install, "resources", "app.asar"), "tampered");
  expect(() => packagedShimBuild(self, exe, env, "win32")).toThrow(
    "packaged_shim_identity_unavailable",
  );
});

it("starts the Windows host from the install's host.mjs with the same stamp", () => {
  const install = join("C:", "Users", "x", "AppData", "Local", "Programs", "cashU");
  const build = {
    self: join(install, "resources", "shim.mjs"),
    checkout: undefined,
    build: "desktop-1.0.0",
    flavor: FLAVORS.prod,
  };
  const entry = join(install, "resources", "host.mjs");
  expect(hostCommand(build, "D:\\data", join(install, "cashU.exe"), [], install).args).toEqual([
    entry,
    "run",
    "--data-dir",
    "D:\\data",
    "--bundle",
    entry,
  ]);
});
