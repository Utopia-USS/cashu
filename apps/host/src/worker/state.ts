/** Explicit private bookkeeping only; a corrupt throttle record refuses instead of resetting it. */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isOwnerOnly, O_NOFOLLOW, O_NONBLOCK, syncDirectory } from "@cashu/node-host";
import { z } from "zod";
import { emptyWorkerState, type WorkerState, type WorkerStatePort } from "./contracts.js";

const MAX_BYTES = 4 * 1024 * 1024;
const stamp = z.iso.datetime({ offset: true });
const schema = z
  .object({
    version: z.literal(1),
    runs: z.record(
      z.string(),
      z
        .object({
          day: z.iso.date(),
          startedAt: stamp,
          finishedAt: stamp.nullable(),
          status: z.enum(["ok", "partial", "failed", "skipped"]),
          code: z.string().max(64).optional(),
          stats: z.record(z.string(), z.number().finite()).optional(),
        })
        .strict(),
    ),
    backfills: z
      .record(
        z.string(),
        z
          .object({
            day: z.iso.date(),
            startedAt: stamp,
            finishedAt: stamp.nullable(),
            status: z.enum(["ok", "partial", "failed", "skipped"]),
            code: z.string().max(64).optional(),
            stats: z.record(z.string(), z.number().finite()).optional(),
          })
          .strict(),
      )
      .default({}),
    budget: z.record(
      z.string(),
      z
        .object({
          last_attempt: stamp.optional(),
          last_success: stamp.optional(),
          throttled_until: stamp.optional(),
          last_status: z.string().max(32).optional(),
        })
        .strict(),
    ),
    digests: z.record(z.string(), z.iso.date()),
    uncertain: z
      .record(
        z.string(),
        z
          .object({
            job: z.enum(["investments.daily", "investments.backfill"]),
            phase: z.enum(["prepared", "outcome_unknown"]),
            command: z.string().min(1).max(128),
            key: z.string().min(1).max(128),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();
const fail = (): never => {
  throw new Error("worker_state_unavailable");
};

/**
 * The worker's private bookkeeping file in `directory`. On macOS and Linux the directory and the file
 * belong to this user with nothing for group and others; on Windows the modes are synthetic and privacy
 * rests on the data dir's per-user ACL (@cashu/node-host privateFs). `platform` is a test seam only.
 */
export function privateWorkerState(
  directory: string,
  isCurrent: () => boolean,
  platform: NodeJS.Platform = process.platform,
): WorkerStatePort {
  const root = realpathSync.native(directory),
    pinned = lstatSync(root);
  const check = () => {
    if (!isCurrent()) fail();
    const info = lstatSync(root);
    if (
      !info.isDirectory() ||
      info.dev !== pinned.dev ||
      info.ino !== pinned.ino ||
      !isOwnerOnly(info, platform)
    )
      fail();
  };
  const path = join(root, "native-state.json");
  const regular = () => {
    try {
      const info = lstatSync(path);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > MAX_BYTES ||
        !isOwnerOnly(info, platform)
      )
        fail();
      return info;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return fail();
    }
  };
  check();
  return {
    async load() {
      check();
      const info = regular();
      if (info === null) return emptyWorkerState();
      const fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      try {
        const current = fstatSync(fd);
        if (
          !current.isFile() ||
          current.nlink !== 1 ||
          current.dev !== info.dev ||
          current.ino !== info.ino ||
          current.size > MAX_BYTES ||
          !isOwnerOnly(current, platform)
        )
          fail();
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          const n = readSync(fd, bytes, size, bytes.length - size, null);
          if (n === 0) break;
          size += n;
        }
        if (size > MAX_BYTES) fail();
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(0, size),
        );
        const result = schema.safeParse(JSON.parse(text));
        if (!result.success) return fail();
        check();
        const final = regular();
        if (final?.dev !== info.dev || final.ino !== info.ino) fail();
        return result.data;
      } catch {
        return fail();
      } finally {
        closeSync(fd);
      }
    },
    async save(state: WorkerState) {
      check();
      if (!schema.safeParse(state).success) fail();
      const bytes = Buffer.from(JSON.stringify(state));
      if (bytes.length > MAX_BYTES) fail();
      regular();
      const temporary = join(root, `.native-state-${randomUUID()}.tmp`);
      const fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW,
        0o600,
      );
      try {
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        check();
        regular();
        renameSync(temporary, path);
        syncDirectory(root, platform);
        check();
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}
