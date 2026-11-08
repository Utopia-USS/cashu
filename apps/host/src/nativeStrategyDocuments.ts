/** Native strategy documents over an explicitly injected, pinned private vault directory. */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  watch,
} from "node:fs";
import { join } from "node:path";
import type { StrategyDoc } from "@cashu/store/investments/services";
import type { StrategyCliFiles } from "./cli/investments/context.js";
import {
  type StrategyDirectoryAuthority,
  strategyDirectoryAccess,
  strategyPublicationPorts,
} from "./proposals/strategyFiles.js";
import type { StrategyScreenCapability } from "./strategiesScreen.js";

const DOC_LIMIT = 512_000;
const nofollow = constants.O_NOFOLLOW ?? 0;
const nonblock = constants.O_NONBLOCK ?? 0;
const safeSegment = (part: string) =>
  part !== "" && part !== "." && part !== ".." && !/[/\\\0]/.test(part);
const normalized = (text: string) => text.replace(/\r\n?/g, "\n");
type WatchDirectory = (
  path: string,
  changed: (event: string, name: string | Buffer | null) => void,
) => { on(event: "error", listener: (error: Error) => void): unknown; close(): void };
const watchDirectory: WatchDirectory = (path, changed) => watch(path, { recursive: true }, changed);
type NativeFileOptions = {
  readonly watchDirectory?: WatchDirectory;
};

function nativeAccess(authority: StrategyDirectoryAuthority) {
  const dir = strategyDirectoryAccess(authority);
  const checkedPath = (parts: readonly string[], leaf: "file" | "directory") => {
    dir.requireCurrent();
    if (parts.length > 5 || parts.some((part) => !safeSegment(part)))
      throw new Error("invalid_strategy_path");
    let current = dir.directory;
    const pins: { path: string; dev: number; ino: number }[] = [];
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const info = lstatSync(current);
      const last = index === parts.length - 1;
      if (
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 ||
        (last && leaf === "file" ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
      )
        throw new Error("strategy_file_authority_unavailable");
      pins.push({ path: current, dev: info.dev, ino: info.ino });
    }
    dir.requireCurrent();
    return { path: current, pins };
  };
  const verify = (pins: readonly { path: string; dev: number; ino: number }[]) => {
    dir.requireCurrent();
    for (const pin of pins) {
      const info = lstatSync(pin.path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.dev !== pin.dev ||
        info.ino !== pin.ino ||
        (info.mode & 0o077) !== 0
      )
        throw new Error("strategy_directory_changed");
    }
    dir.requireCurrent();
  };
  const path = (parts: readonly string[], leaf: "file" | "directory") =>
    checkedPath(parts, leaf).path;
  const readText = (parts: readonly string[], limit: number, fatal: boolean): string | null => {
    let file: string;
    try {
      file = path(parts, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const fd = openSync(file, constants.O_RDONLY | nofollow | nonblock);
    try {
      const before = fstatSync(fd);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > limit ||
        (before.mode & 0o077) !== 0
      )
        throw new Error("strategy_file_authority_unavailable");
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
        const n = readSync(fd, chunk, 0, chunk.length, null);
        if (n === 0) break;
        total += n;
        if (total > limit) throw new Error("strategy_document_too_large");
        chunks.push(chunk.subarray(0, n));
      }
      const after = fstatSync(fd);
      const checked = path(parts, "file");
      const final = lstatSync(checked);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        final.dev !== before.dev ||
        final.ino !== before.ino
      )
        throw new Error("strategy_document_changed");
      return normalized(
        new TextDecoder("utf-8", { fatal, ignoreBOM: true }).decode(Buffer.concat(chunks, total)),
      );
    } finally {
      closeSync(fd);
    }
  };
  const list = (parts: readonly string[]) => {
    let selected: ReturnType<typeof checkedPath>;
    try {
      selected = checkedPath(parts, "directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const entries = readdirSync(selected.path);
    if (entries.length > 1_000) throw new Error("strategy_directory_too_large");
    const result = entries.map((name) => {
      const info = lstatSync(join(selected.path, name));
      return {
        name,
        kind: info.isSymbolicLink()
          ? ("symlink" as const)
          : (info.mode & 0o077) !== 0 || (info.isFile() && info.nlink !== 1)
            ? ("other" as const)
            : info.isFile()
              ? ("file" as const)
              : info.isDirectory()
                ? ("dir" as const)
                : ("other" as const),
        size: info.size,
      };
    });
    verify(selected.pins);
    return result;
  };
  return { dir, path, readText, list };
}

/** CLI file port with explicit no-overwrite init and force-only per-file replacement. */
export function nativeStrategyCliFiles(authority: StrategyDirectoryAuthority): StrategyCliFiles {
  const access = nativeAccess(authority);
  const sync = strategyPublicationPorts(authority);
  const publication = sync.files;
  return {
    sync,
    async read(name) {
      try {
        const value = access.dir.readFixed(name);
        return value === null ? null : normalized(value);
      } catch {
        return { error: "strategy_file_unreadable" };
      }
    },
    async exists(name) {
      return access.dir.readFixed(name) !== null;
    },
    async write() {
      throw new Error("strategy_write_requires_explicit_authority");
    },
    async createAbsent(name, text) {
      return access.dir.createAbsent(name, text);
    },
    async replaceForced(name, text) {
      const token = await publication.stage(name, text);
      // install retires the token and cleans its pinned stage in its own finally, including failure.
      await publication.install(name, token);
    },
  };
}

/** Strategies screen capability for the same native authority as CLI and proposal publication. */
export function nativeStrategyDocuments(
  authority: StrategyDirectoryAuthority,
  options: NativeFileOptions = {},
): StrategyScreenCapability {
  const access = nativeAccess(authority);
  const files = nativeStrategyCliFiles(authority);
  let watchFailed = false;
  const isCurrent = () => !watchFailed && access.dir.current();
  return {
    vault: authority.vault,
    generation: randomUUID(),
    isCurrent,
    files,
    ...(files.sync === undefined ? {} : { sync: files.sync }),
    paths: {
      yaml: join(access.dir.directory, "strategy.yaml"),
      md: join(access.dir.directory, "strategy.md"),
      folder: join(access.dir.directory, "strategies"),
    },
    documents: {
      async list(parts) {
        return access.list(parts);
      },
      async readText(parts) {
        try {
          return access.readText(parts, DOC_LIMIT, false);
        } catch {
          return null;
        }
      },
    },
    async filePath(document: StrategyDoc, relative: string) {
      if (!document.files.includes(relative)) return null;
      try {
        return access.path([...document.root, ...relative.split("/")], "file");
      } catch {
        return null;
      }
    },
    createAbsent: {
      async create(name, text) {
        return { status: access.dir.createAbsent(name, text) };
      },
    },
    watch(changed) {
      const watcher = (options.watchDirectory ?? watchDirectory)(
        access.dir.directory,
        (_event, name) => {
          if (
            !name ||
            String(name)
              .split(/[/\\]/)
              .some((part) => part.startsWith("."))
          )
            return;
          if (isCurrent()) changed();
        },
      );
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        watcher.close();
      };
      watcher.on("error", () => {
        if (watchFailed) return;
        watchFailed = true;
        try {
          stop();
        } catch {
          process.emitWarning("strategy_watch_cleanup_failed");
        }
        changed();
      });
      return stop;
    },
  };
}
