import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { PreferenceStore, UpdatePreferences } from "./controller.js";

const DEFAULTS: UpdatePreferences = { auto: false, skippedVersion: null, dismissedVersion: null };
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_BYTES = 1024;

function notFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("update_preference_dir_not_private");
}

function checkedFile(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = fstatSync(fd);
  if (
    !stat.isFile() ||
    stat.size > MAX_BYTES ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  ) {
    closeSync(fd);
    throw new Error("update_preferences_not_private");
  }
  return fd;
}

function cleanStaleTemps(dataDir: string): void {
  for (const name of readdirSync(dataDir)) {
    if (!/^update-preferences\.json\.[a-f0-9-]{36}\.tmp$/.test(name)) continue;
    const path = join(dataDir, name);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0 ||
      Date.now() - stat.mtimeMs < 86_400_000
    )
      continue;
    unlinkSync(path);
  }
}

/** A separate private file avoids racing the shell's port preference writes. */
export function updatePreferences(dataDir: string): PreferenceStore {
  const path = join(dataDir, "update-preferences.json");
  return {
    read() {
      privateDirectory(dataDir);
      let fd: number;
      try {
        fd = checkedFile(path);
      } catch (error) {
        if (notFound(error)) return DEFAULTS;
        throw error;
      }
      let raw: string;
      try {
        raw = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid_update_preferences");
      const record = value as Record<string, unknown>;
      if (
        Object.keys(record).some(
          (key) => !["auto", "skippedVersion", "dismissedVersion"].includes(key),
        ) ||
        typeof record.auto !== "boolean" ||
        (record.skippedVersion !== null &&
          (typeof record.skippedVersion !== "string" || !VERSION.test(record.skippedVersion))) ||
        (record.dismissedVersion !== null &&
          (typeof record.dismissedVersion !== "string" || !VERSION.test(record.dismissedVersion)))
      )
        throw new Error("invalid_update_preferences");
      return {
        auto: record.auto,
        skippedVersion: record.skippedVersion,
        dismissedVersion: record.dismissedVersion,
      } as UpdatePreferences;
    },
    write(value) {
      privateDirectory(dataDir);
      cleanStaleTemps(dataDir);
      const payload = JSON.stringify(value);
      if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error("update_preferences_too_large");
      const temp = `${path}.${randomUUID()}.tmp`;
      let fd: number | undefined;
      try {
        fd = openSync(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        writeFileSync(fd, payload);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        try {
          const existing = checkedFile(path);
          closeSync(existing);
        } catch (error) {
          if (!notFound(error)) throw error;
        }
        renameSync(temp, path);
        const dirFd = openSync(dirname(path), constants.O_RDONLY);
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } finally {
        if (fd !== undefined) closeSync(fd);
        try {
          unlinkSync(temp);
        } catch {
          /* a failed cleanup leaves only a private, unreferenced temp file */
        }
      }
    },
  };
}
