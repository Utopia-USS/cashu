// The shim's data dir must be exactly the one the Python app resolved, or a CLI command and an install
// made by the old app could disagree about where the data is. The frozen suites hold what the retired
// Python app (`cashu.core.paths.data_dir()`, `_devenv`) answered on macOS for the same synthetic inputs,
// with the temp paths as placeholders.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { FLAVORS } from "@cashu/node-host/flavor";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDataDir, resolveDataDir } from "./dataDir.js";
import { loadDevEnv, mainCheckout, parseDevEnv, splitLines } from "./devenv.js";
import { expandUser, purePath, pyRealpath, UnsupportedHomeError } from "./pypath.js";
import { removeTempDirs, tempDir } from "./testing/dirs.js";
import { cleanEnv } from "./testing/env.js";

afterEach(removeTempDirs);

const PASSWD_HOME = userInfo().homedir;

describe("Python path semantics", () => {
  it("normalizes like PurePosixPath and expands ~ like os.path.expanduser", () => {
    expect(purePath("a//b/./c/")).toBe("a/b/c");
    expect(purePath("//x/y")).toBe("//x/y");
    expect(purePath("///x")).toBe("/x");
    expect(purePath("")).toBe(".");
    expect(expandUser("~/x", "/home/u/")).toBe("/home/u/x");
    expect(expandUser("~", "")).toBe("/");
    expect(expandUser("x~", "/h")).toBe("x~");
    expect(() => expandUser("~other/x", "/h")).toThrow(UnsupportedHomeError);
  });

  it("resolves like os.path.realpath: links, .. after a link, a missing tail, loops", () => {
    const base = tempDir();
    mkdirSync(join(base, "real", "sub"), { recursive: true });
    symlinkSync(join(base, "real", "sub"), join(base, "link"));
    symlinkSync("loop", join(base, "loop"));
    expect(pyRealpath(join(base, "link"), "/")).toBe(join(base, "real", "sub"));
    expect(pyRealpath(`${base}/link/..`, "/")).toBe(join(base, "real"));
    expect(pyRealpath(join(base, "link", "missing", "x"), "/")).toBe(
      join(base, "real/sub/missing/x"),
    );
    expect(pyRealpath("link/./", base)).toBe(join(base, "real", "sub"));
    expect(pyRealpath(join(base, "loop", "x"), "/")).toBe(join(base, "loop", "x"));
  });

  it("splits lines like str.splitlines", () => {
    expect(splitLines("a\r\nb\rc\nd\x0be\x85f g\n")).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("resolveDataDir", () => {
  const ctx = (env: Record<string, string>, cwd = "/") => ({
    env,
    platform: "darwin" as const,
    passwdHome: PASSWD_HOME,
    cwd,
    checkout: undefined,
    flavor: FLAVORS.prod,
  });

  it("prefers CASHU_DATA_DIR, then FINANSE_DATA_DIR, else the platform default", () => {
    expect(resolveDataDir(ctx({ CASHU_DATA_DIR: "/a", FINANSE_DATA_DIR: "/b" })).path).toBe("/a");
    expect(resolveDataDir(ctx({ FINANSE_DATA_DIR: "/b" })).path).toBe("/b");
    expect(
      resolveDataDir(ctx({ CASHU_DATA_DIR: " ", FINANSE_DATA_DIR: "/b", HOME: "/h" })).source,
    ).toBe("default");
    expect(resolveDataDir(ctx({ HOME: "/h" })).path).toBe("/h/Library/Application Support/cashU");
    expect(
      defaultDataDir({
        env: { HOME: "/h" },
        platform: "linux",
        passwdHome: "/p",
        flavor: FLAVORS.prod,
      }),
    ).toBe("/h/.local/share/cashu");
  });

  it("names the default after the shim's flavor (the staging app never lands on cashU)", () => {
    const staging = { ...ctx({ HOME: "/h" }), flavor: FLAVORS.staging };
    expect(resolveDataDir(staging).path).toBe("/h/Library/Application Support/cashU Staging");
    expect(defaultDataDir({ ...staging, platform: "linux" })).toBe("/h/.local/share/cashu-staging");
    expect(resolveDataDir({ ...staging, env: { HOME: "/h", CASHU_DATA_DIR: "/x" } }).path).toBe(
      "/x",
    );
  });

  it("takes `.env.dev` of the checkout (and of a worktree's main checkout) without overriding the env", () => {
    const main = tempDir();
    writeFileSync(join(main, "pnpm-workspace.yaml"), "");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(main, ".env.dev"), "CASHU_DATA_DIR=~/demo\nCASHU_AUTO_DAILY=0\n");
    const wt = tempDir();
    writeFileSync(join(wt, "pnpm-workspace.yaml"), "");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    writeFileSync(join(wt, ".env.dev"), "CASHU_AUTO_DAILY=1\n");
    const r = resolveDataDir({ ...ctx({ HOME: "/h" }), checkout: wt });
    expect(r).toEqual({
      path: "/h/demo",
      source: "env.dev",
      devEnv: {
        files: [join(wt, ".env.dev"), join(main, ".env.dev")],
        added: { CASHU_AUTO_DAILY: "1", CASHU_DATA_DIR: "/h/demo" },
      },
    });
    const shell = resolveDataDir({ ...ctx({ HOME: "/h", CASHU_DATA_DIR: "/x" }), checkout: wt });
    expect([shell.path, shell.source]).toEqual(["/x", "env"]);
    const tests = resolveDataDir({ ...ctx({ HOME: "/h", CASHU_TESTING: "1" }), checkout: wt });
    expect(tests.source).toBe("default");
  });
});

describe("data dir = Python's (frozen, macOS)", () => {
  it.each([
    ["absolute", { CASHU_DATA_DIR: "<base>/data" }, "<base>/data"],
    ["relative to cwd", { CASHU_DATA_DIR: "rel/../data//x/" }, "<base>/data/x"],
    ["stripped", { CASHU_DATA_DIR: "  <base>/with space  " }, "<base>/with space"],
    ["home", { CASHU_DATA_DIR: "~/d" }, "<base>/home/d"],
    ["home alone", { CASHU_DATA_DIR: "~" }, "<base>/home"],
    ["dot then home", { CASHU_DATA_DIR: "./~/d" }, "<base>/home/d"],
    ["through a link", { CASHU_DATA_DIR: "<base>/link/../x" }, "<base>/real/x"],
    ["pre-rename name", { FINANSE_DATA_DIR: "<base>/old" }, "<base>/old"],
    [
      "new name wins",
      { CASHU_DATA_DIR: "<base>/new", FINANSE_DATA_DIR: "<base>/old" },
      "<base>/new",
    ],
    [
      "empty new name wins",
      { CASHU_DATA_DIR: "", FINANSE_DATA_DIR: "<base>/old" },
      "<base>/home/Library/Application Support/cashU",
    ],
    ["default", {}, "<base>/home/Library/Application Support/cashU"],
    ["default under XDG_DATA_HOME", { XDG_DATA_HOME: " <base>/xdg/ " }, "<base>/xdg/cashU"],
    [
      "relative XDG_DATA_HOME ignored",
      { XDG_DATA_HOME: "xdg" },
      "<base>/home/Library/Application Support/cashU",
    ],
    ["relative HOME", { HOME: "rel-home" }, "<passwd>/Library/Application Support/cashU"],
    [
      "HOME with trailing slash",
      { HOME: "<base>/h/" },
      "<base>/h/Library/Application Support/cashU",
    ],
  ])("%s", (_name, vars: Record<string, string>, expected: string) => {
    const base = tempDir();
    mkdirSync(join(base, "real", "deep"), { recursive: true });
    symlinkSync(join(base, "real", "deep"), join(base, "link"));
    const env: Record<string, string> = {
      ...(cleanEnv() as Record<string, string>),
      HOME: join(base, "home"),
      CASHU_TESTING: "1",
    };
    for (const [k, v] of Object.entries(vars)) env[k] = v.replaceAll("<base>", base);
    const got = resolveDataDir({
      env,
      platform: "darwin",
      passwdHome: PASSWD_HOME,
      cwd: base,
      checkout: undefined,
      flavor: FLAVORS.prod,
    });
    expect(got.path).toBe(expected.replaceAll("<base>", base).replaceAll("<passwd>", PASSWD_HOME));
  });

  it("parses `.env.dev` like _devenv._parse", () => {
    const text = [
      "\uFEFFCASHU_BOM=1",
      "# CASHU_COMMENT=1",
      "  CASHU_A = spaced value  ",
      "export CASHU_B=exported",
      'CASHU_C="double quoted"',
      "CASHU_D='single'",
      "CASHU_E=\"mismatched'",
      "CASHU_F=~/x",
      "CASHU_G=a=b=c",
      "CASHU_H=",
      "OTHER=1",
      "noequals",
      "CASHU_A=later wins",
      "CASHU_I=crlf\r\nCASHU_J=vt\x0bCASHU_K=nel\x85CASHU_L=end",
    ].join("\n");
    const home = join(tempDir(), "home");
    expect(Object.fromEntries(parseDevEnv(text, home))).toEqual({
      CASHU_A: "later wins",
      CASHU_B: "exported",
      CASHU_C: "double quoted",
      CASHU_D: "single",
      CASHU_E: "\"mismatched'",
      CASHU_F: `${home}/x`,
      CASHU_G: "a=b=c",
      CASHU_H: "",
      CASHU_I: "crlf",
      CASHU_J: "vt",
      CASHU_K: "nel",
      CASHU_L: "end",
    });
  });

  it("finds a worktree's main checkout and loads both files like _devenv.load", () => {
    const main = tempDir();
    writeFileSync(join(main, "pnpm-workspace.yaml"), "");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(main, ".env.dev"), "CASHU_DATA_DIR=~/main\nCASHU_X=main\n");
    const wt = join(tempDir(), "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, "pnpm-workspace.yaml"), "");
    const rel = `../../${main.split("/").slice(-1)[0]}/.git/worktrees/wt`;
    writeFileSync(join(wt, ".git"), `gitdir: ${rel}\n`);
    writeFileSync(join(wt, ".env.dev"), "CASHU_X=wt\n");
    const home = join(main, "home");
    const shell = { ...(cleanEnv() as Record<string, string>), HOME: home, CASHU_KEEP: "shell" };
    expect(mainCheckout(wt, "/")).toBe(main);
    expect(loadDevEnv(wt, shell, home, "/")).toEqual({
      files: [join(wt, ".env.dev"), join(main, ".env.dev")],
      added: { CASHU_X: "wt", CASHU_DATA_DIR: join(main, "home", "main") },
    });
  });
});
