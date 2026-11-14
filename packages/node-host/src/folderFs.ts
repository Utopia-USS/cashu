// The production Node `FolderFs` (the file-system port of `@cashu/sync`'s folder transport) for the
// hosts that keep a log on disk: the sync daemon's own-log copy and its folder remotes. Durable where
// the port's semantics need it: `write` fsyncs the file before resolving, `rename` fsyncs the target
// directory, so an append (temp write + rename over the segment) survives a crash once its promise
// resolves; new directories are fsynced into their parent. Private: directories are created 0700 and
// files 0600. The root itself is never created: a missing or unreadable root rejects with
// `TransportError("unavailable")` (an unmounted volume must not turn into an empty vault).
import { watch as fsWatch, mkdirSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** fsync a directory so the entries created, renamed or removed in it are on stable storage. */
async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class NodeFolderFs implements FolderFs {
  readonly root: string;

  /** `root` is an absolute path to an existing directory (the folder; never created here). */
  constructor(root: string) {
    this.root = root;
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
      await syncDir(parent);
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
      await rename(src, dst);
      await syncDir(dirname(dst));
      if (dirname(src) !== dirname(dst)) await syncDir(dirname(src));
    });
  }

  /** Only temp files and superseded copies are removed: no fsync, a resurrected one is harmless. */
  async remove(path: string): Promise<void> {
    const abs = this.#abs(path);
    return this.#guard(() => rm(abs, { force: true }));
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
