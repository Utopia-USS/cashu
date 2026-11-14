// The stable launcher: an sh script that execs this build's shim with the caller's arguments, quoted
// for any path, written 0700 in a 0700 dir, rewritten only when it changed.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launcherPath, launcherScript, writeLauncher } from "./launcher.js";
import { cleanup, tempDir } from "./testing/harness.js";

afterEach(cleanup);

describe("launcher", () => {
  it("execs the program with the arguments, quoting paths with spaces and quotes", () => {
    const dir = tempDir("cashu launcher 'q' ");
    const program = {
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)), process.env.X_MARK)"],
      env: { X_MARK: "it's set" },
    };
    expect(writeLauncher(dir, program)).toBe(true);
    const path = launcherPath(dir);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "bin")).mode & 0o777).toBe(0o700);
    const run = spawnSync(path, ["mcp", "--profile", "demo anna"], { encoding: "utf8" });
    expect(run.stdout).toBe(`${JSON.stringify(["mcp", "--profile", "demo anna"])} it's set\n`);
    expect(writeLauncher(dir, program)).toBe(false);
    expect(writeLauncher(dir, { ...program, env: {} })).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(launcherScript({ ...program, env: {} }));
  });
});
