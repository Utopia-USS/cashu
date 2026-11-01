// Where a data dir's host lives. Everything is per data dir (the demo data dir of a dev checkout and
// the owner's real one have different hosts): `<data dir>/run/` (0700) holds the lock DB, the socket,
// the token and host.json. A socket path over 100 bytes (sun_path is 104 bytes on macOS, 108 on
// Linux) moves to `$TMPDIR/cashu-<id16>/` (Linux with XDG_RUNTIME_DIR: `$XDG_RUNTIME_DIR/cashu/<id16>/`),
// a 0700 directory of this user; host.json records the socket path either way. Windows (named pipes
// per user SID) is design-level only and refused here.
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveReal } from "../guard.js";

/** Longest socket path used as is; longer ones move to the fallback directory. */
export const MAX_SOCKET_PATH_BYTES = 100;

export interface HostPathEnv {
  readonly platform?: NodeJS.Platform;
  /** Defaults to `os.tmpdir()` (macOS: the per-user `$TMPDIR`). */
  readonly tmpDir?: string;
  /** Linux `$XDG_RUNTIME_DIR`. */
  readonly xdgRuntimeDir?: string;
}

export interface HostRunPaths {
  /** The data dir's real path. */
  readonly dataDir: string;
  /** SHA-256 of `dataDir`, hex: the id a client's hello names. */
  readonly dataDirId: string;
  readonly runDir: string;
  readonly lockPath: string;
  readonly socketPath: string;
  /** The directory holding the socket when it is not `runDir` (fallback for long paths). */
  readonly socketDir: string;
  readonly tokenPath: string;
  readonly discoveryPath: string;
  /** The detached host's stdout / stderr. */
  readonly logPath: string;
}

export class HostPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostPathError";
  }
}

const bytes = (path: string) => Buffer.byteLength(path, "utf8");

/**
 * The host files of `dataDir` (which need not exist yet). The socket path may still be too long when
 * the temp dir itself is long: a client then finds the socket through host.json, and `startHost`
 * refuses (`assertSocketPath`).
 */
export function hostRunPaths(dataDir: string, env: HostPathEnv = {}): HostRunPaths {
  const platform = env.platform ?? process.platform;
  if (platform === "win32") {
    throw new HostPathError("the local host is not supported on Windows yet (named pipes)");
  }
  const real = resolveReal(resolve(dataDir));
  const dataDirId = createHash("sha256").update(real, "utf8").digest("hex");
  const runDir = join(real, "run");
  let socketDir = runDir;
  if (bytes(join(runDir, "host.sock")) > MAX_SOCKET_PATH_BYTES) {
    const short = dataDirId.slice(0, 16);
    socketDir =
      platform === "linux" && env.xdgRuntimeDir
        ? join(env.xdgRuntimeDir, "cashu", short)
        : join(env.tmpDir ?? tmpdir(), `cashu-${short}`);
  }
  const socketPath = join(socketDir, "host.sock");
  return {
    dataDir: real,
    dataDirId,
    runDir,
    lockPath: join(runDir, "host.lock.db"),
    socketPath,
    socketDir,
    tokenPath: join(runDir, "host.token"),
    discoveryPath: join(runDir, "host.json"),
    logPath: join(real, "logs", "host.log"),
  };
}

/** Throws when the host could not bind `paths.socketPath` (over 100 bytes). */
export function assertSocketPath(paths: HostRunPaths): void {
  if (bytes(paths.socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new HostPathError("no socket path under 100 bytes: set a shorter TMPDIR");
  }
}

/**
 * Creates `dir` (and parents) if needed and makes sure it is a real directory of this user with mode
 * 0700. Refuses a symlink or a directory another user owns (a pre-created fallback dir in a shared
 * /tmp would otherwise let that user replace the socket).
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new HostPathError(`${dir} is not a directory`);
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new HostPathError(`${dir} belongs to another user`);
  }
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}
