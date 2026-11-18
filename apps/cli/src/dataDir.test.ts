// The shim's data dir must be exactly where existing installs keep their data (installs made by the
// retired Python app included), or a CLI command and the app could disagree about where the data is.
// The macOS table holds the answers of that reference resolution for synthetic inputs, with the temp
// paths as placeholders. `.env.dev` keeps a dev checkout (and its worktrees) on demo data.
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, relative, win32 } from "node:path";
import { FLAVORS } from "@cashu/node-host/flavor";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDataDir, resolveDataDir } from "./dataDir.js";
import { loadDevEnv, mainCheckout, parseDevEnv } from "./devenv.js";
import { removeTempDirs, tempDir } from "./testing/dirs.js";
import { cleanEnv } from "./testing/env.js";
import { winExpandUser, winResolve } from "./winpath.js";

afterEach(removeTempDirs);

const PASSWD_HOME = userInfo().homedir;

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

  // POSIX path semantics (the ctx is macOS) over real temp dirs, whose paths are Windows ones there.
  it.skipIf(process.platform === "win32")(
    "takes `.env.dev` of the checkout (and of a worktree's main checkout) without overriding the env",
    () => {
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
    },
  );
});

// The macOS reference table resolves POSIX paths through real symlinks in temp dirs: POSIX semantics
// (and symlinks need extra privileges on Windows); the Windows rules are covered below on any platform.
describe.skipIf(process.platform === "win32")("data dir resolution (macOS)", () => {
  it.each([
    ["absolute", { CASHU_DATA_DIR: "<base>/data" }, "<base>/data"],
    ["relative to cwd", { CASHU_DATA_DIR: "rel/../data//x/" }, "<base>/data/x"],
    ["stripped", { CASHU_DATA_DIR: "  <base>/with space  " }, "<base>/with space"],
    ["home", { CASHU_DATA_DIR: "~/d" }, "<base>/home/d"],
    ["through a link", { CASHU_DATA_DIR: "<base>/link/../x" }, "<base>/real/x"],
    ["pre-rename name", { FINANSE_DATA_DIR: "<base>/old" }, "<base>/old"],
    [
      "empty new name wins",
      { CASHU_DATA_DIR: "", FINANSE_DATA_DIR: "<base>/old" },
      "<base>/home/Library/Application Support/cashU",
    ],
    ["default under XDG_DATA_HOME", { XDG_DATA_HOME: " <base>/xdg/ " }, "<base>/xdg/cashU"],
    [
      "relative XDG_DATA_HOME ignored",
      { XDG_DATA_HOME: "xdg" },
      "<base>/home/Library/Application Support/cashU",
    ],
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

  it("parses `.env.dev`: comments, export, quotes, ~, last value wins, CRLF", () => {
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
      "CASHU_I=crlf\r\nCASHU_L=end",
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
      CASHU_L: "end",
    });
  });

  it("finds a worktree's main checkout and loads both files, the worktree first", () => {
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

describe("data dir resolution (Windows)", () => {
  const ctx = (env: Record<string, string | undefined>, cwd = "C:\\work") => ({
    env,
    platform: "win32" as const,
    passwdHome: "C:\\Users\\account",
    cwd,
    checkout: undefined,
    flavor: FLAVORS.prod,
  });
  const LOCAL = "C:\\Users\\anna\\AppData\\Local";

  it("defaults to %LOCALAPPDATA%\\<flavor name>, never the roaming APPDATA", () => {
    const env = { LOCALAPPDATA: LOCAL, APPDATA: "C:\\Users\\anna\\AppData\\Roaming" };
    expect(resolveDataDir(ctx(env))).toMatchObject({
      path: `${LOCAL}\\cashU`,
      source: "default",
    });
    expect(resolveDataDir({ ...ctx(env), flavor: FLAVORS.staging }).path).toBe(
      `${LOCAL}\\cashU Staging`,
    );
    expect(defaultDataDir(ctx({ LOCALAPPDATA: "D:/Local/" }))).toBe("D:\\Local\\cashU");
    // HOME and XDG_DATA_HOME are POSIX conventions: Windows ignores them.
    expect(defaultDataDir(ctx({ LOCALAPPDATA: LOCAL, HOME: "/h", XDG_DATA_HOME: "/x" }))).toBe(
      `${LOCAL}\\cashU`,
    );
  });

  it("falls back to <profile>\\AppData\\Local without an absolute LOCALAPPDATA", () => {
    expect(defaultDataDir(ctx({ USERPROFILE: "C:\\Users\\anna" }))).toBe(`${LOCAL}\\cashU`);
    expect(defaultDataDir(ctx({ LOCALAPPDATA: "relative", USERPROFILE: "C:\\Users\\anna" }))).toBe(
      `${LOCAL}\\cashU`,
    );
    expect(defaultDataDir(ctx({ LOCALAPPDATA: " " }))).toBe(
      "C:\\Users\\account\\AppData\\Local\\cashU",
    );
    expect(() => defaultDataDir({ ...ctx({}), passwdHome: "" })).toThrow("USERPROFILE");
  });

  it("resolves CASHU_DATA_DIR: drive letters, either separator, `~`, relative to the cwd", () => {
    const home = { USERPROFILE: "C:\\Users\\anna" };
    const path = (value: string, cwd?: string) =>
      resolveDataDir(ctx({ ...home, CASHU_DATA_DIR: value }, cwd)).path;
    expect(path("D:\\cashu data")).toBe("D:\\cashu data");
    expect(path("  D:/a//b/../c/  ")).toBe("D:\\a\\c");
    expect(path("~")).toBe("C:\\Users\\anna");
    expect(path("~\\demo")).toBe("C:\\Users\\anna\\demo");
    expect(path("~/demo")).toBe("C:\\Users\\anna\\demo");
    expect(path("data", "E:\\work")).toBe("E:\\work\\data");
    expect(path("..\\data", "E:\\work\\sub")).toBe("E:\\work\\data");
    expect(path("\\\\server\\share\\cashU")).toBe("\\\\server\\share\\cashU");
    expect(resolveDataDir(ctx({ FINANSE_DATA_DIR: "D:\\old" })).path).toBe("D:\\old");
    expect(resolveDataDir(ctx({ CASHU_DATA_DIR: "D:\\x" })).source).toBe("env");
    expect(() => path("~other\\x")).toThrow("~user");
  });

  it("expands `~` against the account's profile folder when USERPROFILE is unusable", () => {
    expect(resolveDataDir(ctx({ CASHU_DATA_DIR: "~\\d", USERPROFILE: "rel" })).path).toBe(
      "C:\\Users\\account\\d",
    );
  });
});

describe("Windows paths (winpath)", () => {
  it("canonicalizes the existing prefix and keeps the missing rest as written", () => {
    const disk = new Map([
      ["c:\\users", "C:\\Users"],
      ["c:\\users\\anna", "C:\\Users\\Anna"],
      ["c:\\link", "D:\\target"],
    ]);
    const realpath = (path: string) => {
      const found = disk.get(path.toLowerCase());
      if (found === undefined) throw new Error("ENOENT");
      return found;
    };
    expect(winResolve("c:\\users\\ANNA\\New\\data", "C:\\", realpath)).toBe(
      "C:\\Users\\Anna\\New\\data",
    );
    expect(winResolve("C:\\link\\x", "C:\\", realpath)).toBe("D:\\target\\x");
    expect(winResolve("Z:\\none\\x", "C:\\", realpath)).toBe("Z:\\none\\x");
    expect(winResolve("x", "C:\\users", realpath)).toBe("C:\\Users\\x");
  });

  it("expands `~` only alone or before a separator", () => {
    expect(winExpandUser("~", "C:\\Users\\a")).toBe("C:\\Users\\a");
    expect(winExpandUser("~/x/y", "C:\\Users\\a\\")).toBe(win32.join("C:\\Users\\a", "x", "y"));
    expect(winExpandUser("x~", "C:\\Users\\a")).toBe("x~");
    expect(() => winExpandUser("~b", "C:\\Users\\a")).toThrow();
  });

  it("parses `.env.dev` with `~` as the profile folder", () => {
    const text = "CASHU_DATA_DIR=~/demo\r\nCASHU_X=~\\x\r\nCASHU_Y=C:\\abs\r\n";
    expect(Object.fromEntries(parseDevEnv(text, "C:\\Users\\a", "win32"))).toEqual({
      CASHU_DATA_DIR: "C:\\Users\\a\\demo",
      CASHU_X: "C:\\Users\\a\\x",
      CASHU_Y: "C:\\abs",
    });
  });

  // A real git worktree layout on a Windows disk (realpath and the `.git` file need the platform).
  it.runIf(process.platform === "win32")(
    "finds a worktree's main checkout from an absolute or relative gitdir",
    () => {
      const main = realpathSync.native(tempDir());
      mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
      const wt = realpathSync.native(tempDir());
      const gitdir = join(main, ".git", "worktrees", "wt");
      writeFileSync(join(wt, ".git"), `gitdir: ${gitdir.replaceAll("\\", "/")}\n`);
      expect(mainCheckout(wt, wt, "win32")).toBe(main);
      writeFileSync(join(wt, ".git"), `gitdir: ${relative(wt, gitdir)}\n`);
      expect(mainCheckout(wt, wt, "win32")).toBe(main);
      writeFileSync(join(wt, ".git"), `gitdir: ${join(main, "elsewhere", "wt")}\n`);
      expect(mainCheckout(wt, wt, "win32")).toBeUndefined();
    },
  );
});
