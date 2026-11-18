// Where a data dir's host lives. Everything is per data dir (the demo data dir of a dev checkout and
// the owner's real one have different hosts): `<data dir>/run/` (0700) holds the lock DB, the socket,
// the token and host.json. A socket path over 100 bytes (sun_path is 104 bytes on macOS, 108 on
// Linux) moves to `$TMPDIR/cashu-<id16>/` (Linux with XDG_RUNTIME_DIR: `$XDG_RUNTIME_DIR/cashu/<id16>/`),
// a 0700 directory of this user; host.json records the socket path either way.
//
// Windows has no Unix sockets for this: the host listens on a named pipe instead
// (`transport: "named-pipe"`), `\\.\pipe\cashu-host-<first 32 hex of the data dir id>-<16 random hex>`,
// a fresh name at every start (`hostPipeName`). A pipe lives in the machine-wide pipe namespace, not in
// the run dir, so there is no fallback directory (`socketDir === runDir`), no length limit, no chmod and
// no unlink of a stale one (the OS removes a pipe with its last handle). host.json records the pipe
// name in `socket` exactly like a socket path, and it is the only way a client finds the host: there
// is no computed name to fall back to, so another local user cannot pre-create the pipe of a data dir.
// A missing host.json, or one naming a pipe that is gone, reads as "no host" and a client starts one.
// Who may connect rests on the mutual token handshake: a client verifies the host's proof before it
// proves itself, so a process listening on a pipe it was pointed to learns no token and gets no session.
//
// The token, host.json and the vault files are private on Windows through the data dir's DACL, not
// through modes: `startHost` gives the data dir a protected owner-only DACL (this user's SID and
// SYSTEM, inherited by everything below) before it writes anything, wherever the data dir lives
// (%LOCALAPPDATA% or a CASHU_DATA_DIR such as C:\cashu, whose inherited ACL would let other local
// users in), and refuses to run when it cannot (`windowsAcl.ts`).
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveReal } from "../guard.js";
import { hasPosixModes } from "./privateFs.js";

/** Longest socket path used as is; longer ones move to the fallback directory. */
export const MAX_SOCKET_PATH_BYTES = 100;

/** The Windows named-pipe namespace (`\\.\pipe\`). */
const PIPE_NAMESPACE = "\\\\.\\pipe\\";

const DATA_DIR_ID = /^[0-9a-f]{64}$/;
const PIPE_SUFFIX = /^[0-9a-f]{16}$/;

/**
 * The named pipe of one host start of the data dir with id `dataDirId` (SHA-256 hex of its real
 * path); `suffix` is 16 random hex digits drawn per start.
 */
export function hostPipeName(dataDirId: string, suffix: string): string {
  if (!DATA_DIR_ID.test(dataDirId) || !PIPE_SUFFIX.test(suffix)) {
    throw new HostPathError("invalid host pipe name parts");
  }
  return `${PIPE_NAMESPACE}cashu-host-${dataDirId.slice(0, 32)}-${suffix}`;
}

/**
 * Whether `name` is a host pipe of the data dir `dataDirId` on this machine: exactly the
 * `hostPipeName` shape, never a path, another data dir's pipe or a pipe on another machine
 * (`\\server\pipe\...`, which would send this user's credentials over the network).
 */
export function isHostPipeName(name: string, dataDirId: string): boolean {
  const prefix = `${PIPE_NAMESPACE}cashu-host-${dataDirId.slice(0, 32)}-`;
  return (
    DATA_DIR_ID.test(dataDirId) &&
    name.startsWith(prefix) &&
    PIPE_SUFFIX.test(name.slice(prefix.length))
  );
}

export interface HostPathEnv {
  readonly platform?: NodeJS.Platform;
  /** Defaults to `os.tmpdir()` (macOS: the per-user `$TMPDIR`). */
  readonly tmpDir?: string;
  /** Linux `$XDG_RUNTIME_DIR`. */
  readonly xdgRuntimeDir?: string;
}

interface HostRunFiles {
  /** The data dir's real path. */
  readonly dataDir: string;
  /** SHA-256 of `dataDir`, hex: the id a client's hello names. */
  readonly dataDirId: string;
  readonly runDir: string;
  readonly lockPath: string;
  /**
   * The directory holding the socket when it is not `runDir` (fallback for long paths). Always
   * `runDir` for a named pipe, which lives in no directory.
   */
  readonly socketDir: string;
  readonly tokenPath: string;
  readonly discoveryPath: string;
  /** The detached host's stdout / stderr. */
  readonly logPath: string;
}

/** macOS and Linux: the host's Unix socket has a fixed path. */
export interface UnixSocketRunPaths extends HostRunFiles {
  readonly transport: "unix-socket";
  readonly socketPath: string;
}

/** Windows: the host's named pipe is new at every start and found through host.json only. */
interface NamedPipeRunPaths extends HostRunFiles {
  readonly transport: "named-pipe";
}

export type HostRunPaths = UnixSocketRunPaths | NamedPipeRunPaths;

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
 * refuses (`assertSocketPath`). On Windows the socket is a named pipe (see the header).
 */
export function hostRunPaths(dataDir: string, env: HostPathEnv = {}): HostRunPaths {
  const platform = env.platform ?? process.platform;
  const real = resolveReal(resolve(dataDir));
  const dataDirId = createHash("sha256").update(real, "utf8").digest("hex");
  const runDir = join(real, "run");
  const files = {
    dataDir: real,
    dataDirId,
    runDir,
    lockPath: join(runDir, "host.lock.db"),
    tokenPath: join(runDir, "host.token"),
    discoveryPath: join(runDir, "host.json"),
    logPath: join(real, "logs", "host.log"),
  };
  if (platform === "win32") return { ...files, transport: "named-pipe", socketDir: runDir };
  let socketDir = runDir;
  if (bytes(join(runDir, "host.sock")) > MAX_SOCKET_PATH_BYTES) {
    const short = dataDirId.slice(0, 16);
    socketDir =
      platform === "linux" && env.xdgRuntimeDir
        ? join(env.xdgRuntimeDir, "cashu", short)
        : join(env.tmpDir ?? tmpdir(), `cashu-${short}`);
  }
  return {
    ...files,
    transport: "unix-socket",
    socketPath: join(socketDir, "host.sock"),
    socketDir,
  };
}

/** Throws when the host could not bind `paths.socketPath` (a Unix socket over 100 bytes). */
export function assertSocketPath(paths: HostRunPaths): void {
  if (paths.transport === "named-pipe") return;
  if (bytes(paths.socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new HostPathError("no socket path under 100 bytes: set a shorter TMPDIR");
  }
}

/**
 * Creates `dir` (and parents) if needed and makes sure it is a real directory of this user with mode
 * 0700. Refuses a symlink or a directory another user owns (a pre-created fallback dir in a shared
 * /tmp would otherwise let that user replace the socket). On Windows only the type is checked (a
 * directory, not a symlink or junction): modes and owners are synthetic there, and the directory
 * inherits the data dir's owner-only DACL (`windowsAcl.ts`, `privateFs.ts`).
 */
export function ensurePrivateDir(dir: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new HostPathError(`${dir} is not a directory`);
  }
  if (!hasPosixModes(platform)) return;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new HostPathError(`${dir} belongs to another user`);
  }
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}
