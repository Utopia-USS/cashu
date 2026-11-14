import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLAVORS } from "@cashu/node-host/flavor";
import { afterEach, expect, it } from "vitest";
import { existingHost, type HostTarget, hostCommand, reachHost } from "./host.js";

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
  expect(command.args).toEqual([
    "/Synthetic/cashU.app/Contents/Resources/host.mjs",
    "run",
    "--data-dir",
    "/Synthetic/data",
    "--bundle",
    "/Synthetic/cashU.app/Contents/Resources/host.mjs",
  ]);
});

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
