// The data dir the shim talks to, resolved exactly as `cashu.core.paths.data_dir()` (with
// `cashu/__init__.py` loading `.env.dev` first): `CASHU_DATA_DIR` (else the pre-rename
// `FINANSE_DATA_DIR`, `core/env.py`), stripped, `~` expanded and resolved (`Path.resolve()`), else the
// platform default of platformdirs (`user_data_dir("cashU", appauthor=False, roaming=True)`, not
// resolved). The data dir names the host (one per data dir), so a dev checkout's demo data dir and the
// owner's real one can never share a host.
import { pyStrip } from "@cashu/domain/text";
import { type DevEnv, type Env, loadDevEnv } from "./devenv.js";
import { expandUser, purePath, pyRealpath } from "./pypath.js";

export interface DataDirContext {
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  /** This user's home from the password database (`os.userInfo().homedir`): used when HOME is unset. */
  readonly passwdHome: string;
  readonly cwd: string;
  /** The source checkout the shim runs from, undefined when packaged. */
  readonly checkout: string | undefined;
}

export interface ResolvedDataDir {
  readonly path: string;
  /** Where the value came from. */
  readonly source: "env" | "env.dev" | "default";
  /** What `.env.dev` added to the environment (the Python child gets the same, as Python would). */
  readonly devEnv: DevEnv;
}

/** A platform the host does not run on yet. */
class UnsupportedPlatformError extends Error {
  constructor() {
    super("the cashu command needs macOS or Linux");
    this.name = "UnsupportedPlatformError";
  }
}

/** `core/env.py` `env()`: the new name wins (also when empty), then the pre-rename one. */
function cashuEnv(env: Env, key: string): string | undefined {
  return env[`CASHU_${key}`] ?? env[`FINANSE_${key}`];
}

/** `os.path.expanduser`'s home: HOME when set (even empty), else the password database. */
const userHome = (ctx: Pick<DataDirContext, "env" | "passwdHome">) =>
  ctx.env.HOME ?? ctx.passwdHome;

/**
 * platformdirs (4.14) `user_data_dir("cashU" | "cashu", appauthor=False, roaming=True)`: an absolute
 * `$XDG_DATA_HOME` (stripped) on macOS and Linux, else `~/Library/Application Support` (macOS) or
 * `~/.local/share` (Linux), where `~` ignores a relative HOME; then `os.path.join` and `Path()`.
 */
export function defaultDataDir(
  ctx: Pick<DataDirContext, "env" | "passwdHome" | "platform">,
): string {
  const name = ctx.platform === "darwin" ? "cashU" : ctx.platform === "linux" ? "cashu" : undefined;
  if (name === undefined) throw new UnsupportedPlatformError();
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
  const devEnv = loadDevEnv(ctx.checkout, ctx.env, userHome(ctx), ctx.cwd);
  const merged: Env = { ...devEnv.added, ...ctx.env };
  const raw = pyStrip(cashuEnv(merged, "DATA_DIR") ?? "");
  if (raw === "") {
    return { path: defaultDataDir(ctx), source: "default", devEnv };
  }
  // The winning key came from the environment unless only `.env.dev` set CASHU_DATA_DIR.
  const fromDevEnv = ctx.env.CASHU_DATA_DIR === undefined && merged.CASHU_DATA_DIR !== undefined;
  // Path(raw).expanduser().resolve(): `~` only as the first component of the normalized path.
  const pure = purePath(raw);
  const expanded = (pure.split("/")[0] ?? "").startsWith("~")
    ? expandUser(pure, userHome(ctx))
    : pure;
  return {
    path: pyRealpath(expanded, ctx.cwd),
    source: fromDevEnv ? "env.dev" : "env",
    devEnv,
  };
}
