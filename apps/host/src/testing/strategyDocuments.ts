/** Generated-demo-only file capability. The caller supplies the private synthetic root explicitly. */
import { randomUUID } from "node:crypto";
import { constants, lstatSync, watch } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StrategyFileName } from "@cashu/store/investments/services";
import { MAX_STRATEGY_FILE_BYTES } from "@cashu/store/investments/services";
import type { StrategyScreenCapability } from "../strategiesScreen.js";
export async function syntheticStrategyDocuments(options: {
  readonly root: string;
  readonly vault: string;
  readonly generation: string;
  isCurrent(): boolean;
  /** Synthetic race/failure tests only: invoked after complete private staging, before publication. */
  beforePublish?(name: StrategyFileName): Promise<void>;
}): Promise<StrategyScreenCapability> {
  const root = resolve(options.root);
  const pinned = await lstat(root);
  if (
    !pinned.isDirectory() ||
    pinned.isSymbolicLink() ||
    (pinned.mode & 0o077) !== 0 ||
    (await realpath(root)) !== root
  )
    throw new Error("invalid_synthetic_strategy_root");
  const isCurrent = () => {
    try {
      const stat = lstatSync(root);
      return (
        options.isCurrent() &&
        stat.dev === pinned.dev &&
        stat.ino === pinned.ino &&
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (stat.mode & 0o077) === 0
      );
    } catch {
      return false;
    }
  };
  const current = async () => {
    if (!isCurrent()) throw new Error("synthetic_strategy_authority_lost");
    const stat = await lstat(root);
    if (
      !isCurrent() ||
      stat.dev !== pinned.dev ||
      stat.ino !== pinned.ino ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("synthetic_strategy_authority_lost");
  };
  const checked = async (parts: readonly string[]) => {
    await current();
    let path = root;
    for (const [index, segment] of parts.entries()) {
      if (!segment || segment === "." || segment === ".." || /[/\\\0]/.test(segment))
        throw new Error("invalid_synthetic_strategy_path");
      path = join(path, segment);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
        throw new Error("invalid_synthetic_strategy_path");
    }
    await current();
    return path;
  };
  const read = async (parts: readonly string[], fatal: boolean, limit: number) => {
    await current();
    let path: string;
    try {
      path = await checked(parts);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const expected = await lstat(path);
    if (!expected.isFile() || expected.isSymbolicLink() || (expected.mode & 0o077) !== 0)
      throw new Error("invalid_synthetic_strategy_file");
    if (expected.size > limit) throw new Error("synthetic_strategy_too_large");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.dev !== expected.dev ||
        stat.ino !== expected.ino ||
        stat.size > limit ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error("invalid_synthetic_strategy_file");
      const bytes = new Uint8Array(limit + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > limit) throw new Error("synthetic_strategy_too_large");
      const after = await handle.stat();
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error("synthetic_strategy_changed");
      await checked(parts);
      await current();
      const final = await lstat(path);
      if (final.dev !== stat.dev || final.ino !== stat.ino)
        throw new Error("synthetic_strategy_changed");
      return new TextDecoder("utf-8", { fatal, ignoreBOM: true })
        .decode(bytes.subarray(0, length))
        .replace(/\r\n?/g, "\n");
    } finally {
      await handle.close();
    }
  };
  const cap: StrategyScreenCapability = {
    vault: options.vault,
    generation: options.generation,
    isCurrent,
    paths: {
      yaml: join(root, "strategy.yaml"),
      md: join(root, "strategy.md"),
      folder: join(root, "strategies"),
    },
    files: {
      async read(name) {
        try {
          return await read([name], true, MAX_STRATEGY_FILE_BYTES);
        } catch {
          return { error: "strategy_file_unreadable" };
        }
      },
      async exists(name) {
        try {
          const path = await checked([name]);
          const stat = await lstat(path);
          return stat.isFile() && !stat.isSymbolicLink();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
      async write() {
        throw new Error("synthetic_strategy_replace_forbidden");
      },
    },
    async filePath(document, relative) {
      if (!document.files.includes(relative)) return null;
      try {
        return await checked([...document.root, ...relative.split("/")]);
      } catch {
        return null;
      }
    },
    documents: {
      async list(parts) {
        try {
          const path = await checked(parts);
          const dir = await lstat(path);
          if (!dir.isDirectory() || dir.isSymbolicLink()) return null;
          const entries = await readdir(path);
          const result = [];
          for (const name of entries) {
            const stat = await lstat(join(path, name));
            result.push({
              name,
              kind: stat.isSymbolicLink()
                ? ("symlink" as const)
                : stat.isFile()
                  ? ("file" as const)
                  : stat.isDirectory()
                    ? ("dir" as const)
                    : ("other" as const),
              size: stat.size,
            });
          }
          await current();
          return result;
        } catch {
          return null;
        }
      },
      async readText(parts) {
        try {
          return await read(parts, false, 512_000);
        } catch {
          return null;
        }
      },
    },
    createAbsent: {
      async create(name, text) {
        if (name !== "strategy.yaml" && name !== "strategy.md")
          throw new Error("invalid_synthetic_strategy_target");
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > MAX_STRATEGY_FILE_BYTES) throw new Error("synthetic_strategy_too_large");
        await current();
        const temporary = join(root, `.strategy-${randomUUID()}.tmp`);
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        const staged = await handle.stat();
        try {
          await handle.writeFile(bytes);
          await handle.sync();
          await handle.close();
          await options.beforePublish?.(name);
          await current();
          const stat = await lstat(temporary);
          if (
            stat.dev !== staged.dev ||
            stat.ino !== staged.ino ||
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            (stat.mode & 0o077) !== 0
          )
            throw new Error("invalid_synthetic_strategy_stage");
          // link publishes complete staged bytes without replacing an existing final target.
          try {
            await link(temporary, join(root, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: "exists" };
            throw error;
          }
          await current();
          return { status: "created" };
        } finally {
          await handle.close().catch(() => {});
          // Only this private temporary name is cleaned; final targets are never removed.
          const remaining = await lstat(temporary).catch(() => null);
          if (remaining?.dev === staged.dev && remaining.ino === staged.ino)
            await unlink(temporary).catch(() => {});
        }
      },
    },
    watch(changed) {
      const watcher = watch(root, { recursive: true }, (_event, name) => {
        if (
          name &&
          String(name)
            .split(/[/\\]/)
            .some((part) => part.startsWith("."))
        )
          return;
        if (isCurrent()) changed();
      });
      return () => watcher.close();
    },
  };
  return cap;
}
