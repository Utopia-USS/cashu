// The data dir the shim talks to, resolved exactly as `cashu.core.paths.data_dir()` (with
// `cashu/__init__.py` loading `.env.dev` first): `CASHU_DATA_DIR` (else the pre-rename
// `FINANSE_DATA_DIR`, `core/env.py`), stripped, `~` expanded and resolved (`Path.resolve()`), else the
// platform default of platformdirs (`user_data_dir("cashU", appauthor=False, roaming=True)`, not
// resolved). The data dir names the host (one per data dir), so a dev checkout's demo data dir and the
// owner's real one can never share a host. The default's name comes from the build's flavor
// (`cashU`, or `cashU Staging` for the staging app's shim).
// Windows (no Python app ever ran there) follows Windows itself (winpath.ts): the default is
// `%LOCALAPPDATA%\<name>`, never the roaming APPDATA (a finance vault must not travel with a roaming
// profile), and `~` in CASHU_DATA_DIR is the user's profile folder.
import { win32 } from "node:path";
import { pyStrip } from "@cashu/domain/text";
import { dataDirName, type Flavor } from "@cashu/node-host/flavor";
import { winIsAbsolute } from "@cashu/node-host/windows-path";
import { type DevEnv, type Env, loadDevEnv } from "./devenv.js";
import { expandUser, purePath, pyRealpath } from "./pypath.js";
import { winExpandUser, winResolve } from "./winpath.js";

export interface DataDirContext {
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  /**
   * This user's home from the account database (`os.userInfo().homedir`): used when HOME (Windows:
   * USERPROFILE) is unset.
   */
  readonly passwdHome: string;
  readonly cwd: string;
  /** The source checkout the shim runs from, undefined when packaged. */
  readonly checkout: string | undefined;
  /** The flavor of the shim's build: its default data dir name (`cashU`, `cashU Staging`). */
  readonly flavor: Flavor;
}

export interface ResolvedDataDir {
  readonly path: string;
  /** Where the value came from. */
  readonly source: "env" | "env.dev" | "default";
  /** What `.env.dev` added to the environment for the local host and CLI. */
  readonly devEnv: DevEnv;
}

/** A platform the host does not run on. */
class UnsupportedPlatformError extends Error {
  constructor() {
    super("the cashu command needs macOS, Linux or Windows");
    this.name = "UnsupportedPlatformError";
  }
}

/** Windows without a usable profile folder: no default data dir can be placed. */
class MissingProfileError extends Error {
  constructor() {
    super("the Windows user profile folder (USERPROFILE) is not set to an absolute path");
    this.name = "MissingProfileError";
  }
}

/** `core/env.py` `env()`: the new name wins (also when empty), then the pre-rename one. */
function cashuEnv(env: Env, key: string): string | undefined {
  return env[`CASHU_${key}`] ?? env[`FINANSE_${key}`];
}

/**
 * The home `~` expands to. POSIX: `os.path.expanduser`'s, HOME when set (even empty), else the
 * password database. Windows: USERPROFILE when it is an absolute path, else the account's profile
 * folder (`os.userInfo().homedir`).
 */
function userHome(ctx: Pick<DataDirContext, "env" | "passwdHome" | "platform">): string {
  if (ctx.platform !== "win32") return ctx.env.HOME ?? ctx.passwdHome;
  const profile = ctx.env.USERPROFILE?.trim() ?? "";
  return winIsAbsolute(profile) ? win32.normalize(profile) : ctx.passwdHome;
}

/** `%LOCALAPPDATA%\<name>`; without an absolute LOCALAPPDATA `<profile>\AppData\Local\<name>`. */
function windowsDataDir(
  ctx: Pick<DataDirContext, "env" | "passwdHome" | "platform">,
  name: string,
): string {
  const local = ctx.env.LOCALAPPDATA?.trim() ?? "";
  if (winIsAbsolute(local)) return win32.join(local, name);
  const home = userHome(ctx);
  if (!winIsAbsolute(home)) throw new MissingProfileError();
  return win32.join(home, "AppData", "Local", name);
}

/**
 * platformdirs (4.14) `user_data_dir("cashU" | "cashu", appauthor=False, roaming=True)`: an absolute
 * `$XDG_DATA_HOME` (stripped) on macOS and Linux, else `~/Library/Application Support` (macOS) or
 * `~/.local/share` (Linux), where `~` ignores a relative HOME; then `os.path.join` and `Path()`.
 */
export function defaultDataDir(
  ctx: Pick<DataDirContext, "env" | "passwdHome" | "platform" | "flavor">,
): string {
  if (ctx.platform === "win32") return windowsDataDir(ctx, dataDirName(ctx.flavor, "win32"));
  if (ctx.platform !== "darwin" && ctx.platform !== "linux") throw new UnsupportedPlatformError();
  const name = dataDirName(ctx.flavor, ctx.platform);
  const xdg = pyStrip(ctx.env.XDG_DATA_HOME ?? "");
  let base: string;
  if (xdg.startsWith("/")) base = xdg;
  else {
    const rest = ctx.platform === "darwin" ? "/Library/Application Support" : "/.local/share";
    const home = ctx.env.HOME;
    base =
      home !== undefined && !home.startsWith("/")
        ? ctx.passwdHome.replace(/\/+$/, "") + rest || "/"
        : expandUser(`~${rest}`, userHome(ctx));
    if (!base.startsWith("/")) throw new UnsupportedPlatformError();
  }
  return purePath(base.endsWith("/") ? base + name : `${base}/${name}`);
}

export function resolveDataDir(ctx: DataDirContext): ResolvedDataDir {
  const devEnv = loadDevEnv(ctx.checkout, ctx.env, userHome(ctx), ctx.cwd, ctx.platform);
  const merged: Env = { ...devEnv.added, ...ctx.env };
  const raw = pyStrip(cashuEnv(merged, "DATA_DIR") ?? "");
  if (raw === "") {
    return { path: defaultDataDir(ctx), source: "default", devEnv };
  }
  // The winning key came from the environment unless only `.env.dev` set CASHU_DATA_DIR.
  const fromDevEnv = ctx.env.CASHU_DATA_DIR === undefined && merged.CASHU_DATA_DIR !== undefined;
  const source = fromDevEnv ? "env.dev" : "env";
  if (ctx.platform === "win32") {
    // `~` (alone or before a separator) is the profile folder; relative paths are against the cwd.
    return { path: winResolve(winExpandUser(raw, userHome(ctx)), ctx.cwd), source, devEnv };
  }
  // Path(raw).expanduser().resolve(): `~` only as the first component of the normalized path.
  const pure = purePath(raw);
  const expanded = (pure.split("/")[0] ?? "").startsWith("~")
    ? expandUser(pure, userHome(ctx))
    : pure;
  return {
    path: pyRealpath(expanded, ctx.cwd),
    source,
    devEnv,
  };
}
