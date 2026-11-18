// The production Node `FolderFs` (the file-system port of `@cashu/sync`'s folder transport) for the
// hosts that keep a log on disk: the sync daemon's own-log copy and its folder remotes. Durable where
// the port's semantics need it: `write` fsyncs the file before resolving, `rename` fsyncs the target
// directory, so an append (temp write + rename over the segment) survives a crash once its promise
// resolves; new directories are fsynced into their parent. Private: directories are created 0700 and
// files 0600. The root itself is never created: a missing or unreadable root rejects with
// `TransportError("unavailable")` (an unmounted volume must not turn into an empty vault).
//
// Windows differs in two ways (and only there; macOS and Linux behave as described above):
// - A directory cannot be fsynced (FlushFileBuffers needs write access to the handle, so it fails with
//   EPERM, which would read as "folder unreachable" on every append). `syncDir` is a no-op there, the
//   rule `syncDirectory` in host/privateFs.ts follows: the file's own bytes are fsynced before the
//   rename, and NTFS journals the directory change itself.
// - A rename over a file, or a removal, fails while another handle has that file open without
//   FILE_SHARE_DELETE (EPERM / EACCES / EBUSY), where POSIX just replaces or unlinks the name. Node opens
//   files with FILE_SHARE_DELETE, and every handle this class opens is closed before its call resolves
//   (the temp file is closed before it is renamed over the segment), so such a holder is a short-lived
//   one: a concurrent `read` of the same segment, an antivirus or indexer scan of the fresh file, a
//   cloud-sync client copying it. `rename` and `remove` therefore wait that out (`retryWhileLocked`,
//   about two seconds; graceful-fs does the same for renames on Windows) before the error maps to
//   unavailable. A folder whose permission is really gone reports unavailable that much later there.
import { watch as fsWatch, mkdirSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type FolderEntry, type FolderFs, TransportError } from "@cashu/sync";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function code(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;
}

const unavailable = () =>
  new TransportError("unavailable", "the synced folder is not reachable", "outage");

/** Permission lost on the folder counts as the folder being unreachable (port contract). */
function mapError(e: unknown): unknown {
  const c = code(e);
  return c === "EACCES" || c === "EPERM" ? unavailable() : e;
}

/**
 * fsync a directory so the entries created, renamed or removed in it are on stable storage. A no-op on
 * Windows, where a directory cannot be fsynced (see the header).
 */
export async function syncDir(dir: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The pauses between tries while a Windows file is held open by another handle (about 2.3 s). */
const LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640, 1000] as const;
/** The errors Windows reports for a name another handle keeps open (ERROR_ACCESS_DENIED, sharing). */
const LOCKED = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Runs `op`, and on Windows tries it again while it fails because another handle keeps the file open
 * (see the header), up to `LOCK_RETRY_DELAYS_MS`; then the last error propagates. Elsewhere `op` runs
 * once: EPERM / EACCES there mean permission lost on the folder and map to unavailable at once.
 */
export async function retryWhileLocked<T>(
  op: () => Promise<T>,
  platform: NodeJS.Platform,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<T> {
  if (platform !== "win32") return op();
  for (const delay of LOCK_RETRY_DELAYS_MS) {
    try {
      return await op();
    } catch (e) {
      const c = code(e);
      if (c === undefined || !LOCKED.has(c)) throw e;
    }
    await wait(delay);
  }
  return op();
}

export interface NodeFolderFsOptions {
  /** The OS whose file-system rules apply (tests); the running one by default. */
  readonly platform?: NodeJS.Platform;
}

export class NodeFolderFs implements FolderFs {
  readonly root: string;
  readonly #platform: NodeJS.Platform;

  /** `root` is an absolute path to an existing directory (the folder; never created here). */
  constructor(root: string, options: NodeFolderFsOptions = {}) {
    this.root = root;
    this.#platform = options.platform ?? process.platform;
  }

  /** The relative `/`-separated `path` split into components; `..` and empty parts are refused. */
  #parts(path: string): string[] {
    if (path === "") return [];
    const parts = path.split("/");
    if (parts.some((part) => part === ".." || part === "." || part === ""))
      throw new RangeError("path escapes the root");
    return parts;
  }

  #abs(path: string): string {
    return join(this.root, ...this.#parts(path));
  }

  async #checkRoot(): Promise<void> {
    let isDir: boolean;
    try {
      isDir = (await stat(this.root)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw unavailable();
  }

  /**
   * Create the directories of `parts` below the root one level at a time (never the root: a root
   * that vanished meanwhile gives ENOENT -> unavailable, not a fresh empty folder), then fsync the
   * parent of every directory created.
   */
  async #ensureDirs(parts: readonly string[]): Promise<void> {
    let dir = this.root;
    for (const part of parts) {
      const parent = dir;
      dir = join(dir, part);
      try {
        await mkdir(dir, { mode: DIR_MODE });
      } catch (e) {
        if (code(e) === "EEXIST") continue;
        if (code(e) === "ENOENT") throw unavailable();
        throw mapError(e);
      }
      await syncDir(parent, this.#platform);
    }
  }

  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    await this.#checkRoot();
    try {
      return await fn();
    } catch (e) {
      throw mapError(e);
    }
  }

  async list(path: string): Promise<readonly FolderEntry[] | undefined> {
    const dir = this.#abs(path);
    return this.#guard(async () => {
      let names: { name: string; isFile(): boolean; isDirectory(): boolean }[];
      try {
        names = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (code(e) === "ENOENT" || code(e) === "ENOTDIR") return undefined;
        throw e;
      }
      const out: FolderEntry[] = [];
      for (const d of names) {
        if (d.isDirectory()) out.push({ name: d.name, kind: "dir", size: 0 });
        else if (d.isFile()) {
          try {
            out.push({ name: d.name, kind: "file", size: (await stat(join(dir, d.name))).size });
          } catch (e) {
            if (code(e) !== "ENOENT") throw e; // renamed or removed meanwhile
          }
        }
      }
      return out;
    });
  }

  async read(path: string, offset: number): Promise<Uint8Array | undefined> {
    const abs = this.#abs(path);
    return this.#guard(async () => {
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(abs, "r");
      } catch (e) {
        if (code(e) === "ENOENT") return undefined;
        throw e;
      }
      try {
        const { size } = await handle.stat();
        if (offset >= size) return new Uint8Array(0);
        const buf = new Uint8Array(size - offset);
        let filled = 0;
        while (filled < buf.length) {
          const { bytesRead } = await handle.read(
            buf,
            filled,
            buf.length - filled,
            offset + filled,
          );
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return buf.subarray(0, filled);
      } finally {
        await handle.close();
      }
    });
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const parts = this.#parts(path);
    if (parts.length === 0) throw new RangeError("cannot write the root");
    const abs = this.#abs(path);
    return this.#guard(async () => {
      await this.#ensureDirs(parts.slice(0, -1));
      const handle = await open(abs, "w", FILE_MODE);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const src = this.#abs(from);
    const dst = this.#abs(to);
    return this.#guard(async () => {
      await retryWhileLocked(() => rename(src, dst), this.#platform);
      await syncDir(dirname(dst), this.#platform);
      if (dirname(src) !== dirname(dst)) await syncDir(dirname(src), this.#platform);
    });
  }

  /**
   * Only temp files and superseded copies are removed: no fsync, a resurrected one is harmless. On
   * Windows a removal waits out a short-lived holder of the file, as `rename` does.
   */
  async remove(path: string): Promise<void> {
    const abs = this.#abs(path);
    return this.#guard(() => retryWhileLocked(() => rm(abs, { force: true }), this.#platform));
  }

  /**
   * Recursive change notification below `path` (created 0700 below the root when missing). Throws
   * `TransportError("unavailable")` when the root is missing; a watcher that fails later (the folder
   * went away) closes and reports one change, so the caller re-lists and sees the folder offline.
   */
  watch(path: string, onChange: () => void): () => void {
    let dir = this.root;
    for (const part of this.#parts(path)) {
      dir = join(dir, part);
      try {
        mkdirSync(dir, { mode: DIR_MODE });
      } catch (e) {
        if (code(e) === "EEXIST") continue;
        if (code(e) === "ENOENT") throw unavailable();
        throw mapError(e);
      }
    }
    let watcher: ReturnType<typeof fsWatch>;
    try {
      watcher = fsWatch(dir, { recursive: true }, () => onChange());
    } catch (e) {
      if (code(e) === "ENOENT") throw unavailable();
      throw mapError(e);
    }
    watcher.on("error", () => {
      watcher.close();
      onChange();
    });
    return () => watcher.close();
  }
}
