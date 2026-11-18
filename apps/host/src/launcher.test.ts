// The stable launcher: an sh script (macOS, Linux) or a cmd script (Windows, C6) that runs this build's
// shim with the caller's arguments, quoted for any path, written 0700 in a 0700 dir, rewritten only
// when it changed. The Windows text is checked here on any platform; running it needs Windows.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LauncherValueError, launcherPath, launcherScript, writeLauncher } from "./launcher.js";
import { cleanup, tempDir } from "./testing/harness.js";

afterEach(cleanup);

const HERE = { platform: process.platform, env: process.env };
const WINDOWS = {
  platform: "win32" as const,
  env: { LOCALAPPDATA: "C:\\Users\\Michał\\AppData\\Local", USERPROFILE: "C:\\Users\\Michał" },
};

describe("launcher", () => {
  // POSIX sh semantics and modes; Windows runs the cmd script below.
  it.skipIf(process.platform === "win32")(
    "execs the program with the arguments, quoting paths with spaces and quotes",
    () => {
      const dir = tempDir("cashu launcher 'q' ");
      const program = {
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)), process.env.X_MARK)"],
        env: { X_MARK: "it's set" },
      };
      expect(writeLauncher(dir, program)).toBe(true);
      const path = launcherPath(dir, process.platform);
      expect(path).toBe(join(dir, "bin", "cashu"));
      expect(statSync(path).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "bin")).mode & 0o777).toBe(0o700);
      const run = spawnSync(path, ["mcp", "--profile", "demo anna"], { encoding: "utf8" });
      expect(run.stdout).toBe(`${JSON.stringify(["mcp", "--profile", "demo anna"])} it's set\n`);
      expect(writeLauncher(dir, program)).toBe(false);
      expect(writeLauncher(dir, { ...program, env: {} })).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(launcherScript({ ...program, env: {} }, HERE));
    },
  );

  it.runIf(process.platform === "win32")(
    "runs the cmd launcher on Windows with the arguments and the variables",
    () => {
      const dir = tempDir("cashu launcher ");
      const program = {
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)), process.env.X_MARK)"],
        env: { X_MARK: "it's & set" },
      };
      expect(writeLauncher(dir, program)).toBe(true);
      const path = launcherPath(dir, "win32");
      expect(path).toBe(join(dir, "bin", "cashu.cmd"));
      // How Node runs a command line through cmd.exe: /s strips the outer pair of quotes.
      const run = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${path}" mcp --profile demo"`], {
        encoding: "utf8",
        windowsVerbatimArguments: true,
      });
      expect(run.stdout).toBe(`${JSON.stringify(["mcp", "--profile", "demo"])} it's & set\n`);
      expect(run.status).toBe(0);
      expect(writeLauncher(dir, program)).toBe(false);
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps the program's exit code and reads nothing a rewrite appends while the program runs",
    () => {
      const dir = tempDir("cashu launcher ");
      const path = launcherPath(dir, "win32");
      // The program grows its own launcher (as a host start rewriting it would), then exits 7.
      const grow =
        "const fs = require('node:fs'); const p = process.env.X_LAUNCHER;" +
        " fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + 'echo LEAKED\\r\\nexit /b 3\\r\\n');" +
        " process.exitCode = 7;";
      writeLauncher(dir, {
        command: process.execPath,
        args: ["-e", grow],
        env: { X_LAUNCHER: path },
      });
      const run = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${path}""`], {
        encoding: "utf8",
        windowsVerbatimArguments: true,
      });
      expect(run.stdout).not.toContain("LEAKED");
      expect(run.status).toBe(7);
    },
  );

  it("places the launcher per platform", () => {
    expect(launcherPath("/Users/a/Library/Application Support/cashU", "darwin")).toBe(
      "/Users/a/Library/Application Support/cashU/bin/cashu",
    );
    expect(launcherPath("/home/a/.local/share/cashu/", "linux")).toBe(
      "/home/a/.local/share/cashu/bin/cashu",
    );
    expect(launcherPath("C:\\Users\\a\\AppData\\Local\\cashU", "win32")).toBe(
      "C:\\Users\\a\\AppData\\Local\\cashU\\bin\\cashu.cmd",
    );
    expect(launcherPath("D:\\data\\", "win32")).toBe("D:\\data\\bin\\cashu.cmd");
  });

  it("writes the Windows launcher as a CRLF cmd script with every word quoted (C6)", () => {
    const program = {
      command: "C:\\Program Files\\cashU\\cashU.exe",
      args: ["C:\\Program Files\\cashU\\resources\\shim.mjs", "a & b ^ (c) !d", "D:\\dir\\"],
      env: { ELECTRON_RUN_AS_NODE: "1", X_2: "x & y" },
    };
    expect(launcherScript(program, { platform: "win32", env: {} })).toBe(
      [
        "@echo off",
        "setlocal DisableDelayedExpansion",
        'set "ELECTRON_RUN_AS_NODE=1"',
        'set "X_2=x & y"',
        '"C:\\Program Files\\cashU\\cashU.exe" "C:\\Program Files\\cashU\\resources\\shim.mjs" "a & b ^ (c) !d" "D:\\dir\\\\" %* & exit /b',
        "",
      ].join("\r\n"),
    );
    expect(launcherScript({ command: "C:\\a.exe", args: [] }, WINDOWS)).toBe(
      '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"C:\\a.exe" %* & exit /b\r\n',
    );
  });

  it("ends the script with the program call and `exit /b` on one line", () => {
    const lines = launcherScript({ command: "C:\\a.exe", args: ["x"] }, WINDOWS).split("\r\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.at(-2)).toBe('"C:\\a.exe" "x" %* & exit /b');
  });

  it("writes non-ASCII paths under the profile through the variables cmd.exe expands", () => {
    const program = {
      command: "C:\\Users\\Michał\\AppData\\Local\\Programs\\cashU\\cashU.exe",
      args: ["c:\\users\\michał\\src\\cashu\\apps\\cli\\src\\index.ts"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    expect(launcherScript(program, WINDOWS)).toBe(
      [
        "@echo off",
        "setlocal DisableDelayedExpansion",
        'set "ELECTRON_RUN_AS_NODE=1"',
        '"%LOCALAPPDATA%\\Programs\\cashU\\cashU.exe" "%USERPROFILE%\\src\\cashu\\apps\\cli\\src\\index.ts" %* & exit /b',
        "",
      ].join("\r\n"),
    );
  });

  const env = WINDOWS.env;
  it.each([
    ["a quote", { command: "C:\\a.exe", args: ['say "hi"'] }, env],
    ["a percent sign", { command: "C:\\a.exe", args: ["100%"] }, env],
    ["a line feed", { command: "C:\\a.exe", args: ["a\nb"] }, env],
    ["a carriage return", { command: "C:\\a.exe", args: [], env: { K: "a\rb" } }, env],
    ["a NUL", { command: "C:\\a\0.exe", args: [] }, env],
    ["a quote in a variable", { command: "C:\\a.exe", args: [], env: { K: '"' } }, env],
    ["a bad variable name", { command: "C:\\a.exe", args: [], env: { "K=V": "1" } }, env],
    [
      "a variable name with a digit first",
      { command: "C:\\a.exe", args: [], env: { "1K": "1" } },
      env,
    ],
    ["an empty command", { command: "", args: [] }, env],
    ["a command ending in a backslash", { command: "C:\\dir\\", args: [] }, env],
    ["non-ASCII outside the profile", { command: "D:\\Michał\\cashU.exe", args: [] }, env],
    ["non-ASCII without the variables", { command: "C:\\Users\\Michał\\a.exe", args: [] }, {}],
  ])("refuses %s on Windows", (_name, program, vars) => {
    expect(() => launcherScript(program, { platform: "win32", env: vars })).toThrow(
      LauncherValueError,
    );
  });

  it("keeps the POSIX launcher text on macOS and Linux", () => {
    const program = { command: "/a b/node", args: ["it's"], env: { K: "v" } };
    const text =
      "#!/bin/sh\n" +
      "# cashU stable launcher: runs this install's `cashu` command (CLI and `cashu mcp`).\n" +
      "# Rewritten by cashU at every start; edits are lost.\n" +
      "export K='v'\n" +
      `exec '/a b/node' 'it'\\''s' "$@"\n`;
    expect(launcherScript(program, { platform: "darwin", env: {} })).toBe(text);
    expect(launcherScript(program, { platform: "linux", env: {} })).toBe(text);
  });
});
