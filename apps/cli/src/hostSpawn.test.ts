// The detached host the shim starts works in the data dir, never in the caller's directory (Windows
// cannot delete or rename a folder a running process holds as its cwd).
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostRunPaths } from "@cashu/node-host";
import { FLAVORS } from "@cashu/node-host/flavor";
import { afterEach, expect, it } from "vitest";
import { type HostTarget, hostCommand, hostSpawnOptions } from "./host.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("starts the host in the resolved data dir with the shim's command, log and environment", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cashu-cli-spawn-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const caller = join(root, "project");
  mkdirSync(dataDir);
  mkdirSync(caller);
  const target: HostTarget = {
    dataDir,
    build: {
      self: join(root, "app", "resources", "shim.mjs"),
      checkout: undefined,
      build: "desktop-1.0.0",
      flavor: FLAVORS.prod,
    },
    env: { CASHU_SYNTHETIC: "1" },
    execPath: join(root, "app", "cashU"),
    execArgv: [],
    cwd: caller,
  };
  const options = hostSpawnOptions(target);
  const paths = hostRunPaths(dataDir);
  expect(options).toEqual({
    ...hostCommand(target.build, dataDir, target.execPath, [], caller),
    logPath: paths.logPath,
    env: target.env,
    cwd: paths.dataDir,
  });
  expect(options.cwd).not.toBe(caller);
});
