// Explicitly injected private strategy-file authority. No production path or vault is inferred here.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_STRATEGY_CHARS } from "@cashu/domain/investments/strategy";
import {
  type PrivateStrategyJournal,
  STRATEGY_MD,
  STRATEGY_YAML,
  type StrategyFileImage,
  type StrategyFileName,
  type StrategyPublicationFiles,
  type StrategyPublicationJournal,
} from "@cashu/store/investments/services";
import { z } from "zod";

const FILE_LIMIT = MAX_STRATEGY_CHARS * 4;
const JOURNAL_LIMIT = 20 * 1024 * 1024;
const JOURNAL_NAME = ".proposal-publication.json";
const nofollow = constants.O_NOFOLLOW ?? 0;
const nonblock = constants.O_NONBLOCK ?? 0;
// Python read_text(encoding="utf-8") keeps an initial U+FEFF in digest and rollback source text.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const stagedOwners = new Map<string, { owner: object; current: () => boolean }>();

export interface StrategyDirectoryAuthority {
  readonly vault: string;
  /** Already authorized private root and one profile's strategy directory under it. */
  readonly privateRoot: string;
  readonly directory: string;
  /** Live vault/file capability; revocation is checked for every read and write. */
  isCurrent(): boolean;
}

function unavailable(): never {
  throw new Error("strategy file authority unavailable");
}

function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function pinnedDirectory(path: string) {
  if (!isAbsolute(path) || realpathSync.native(path) !== resolve(path)) unavailable();
  const info = lstatSync(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) unavailable();
  return { path: resolve(path), dev: info.dev, ino: info.ino };
}

function checkedDirectory(authority: StrategyDirectoryAuthority) {
  const vault = authority.vault;
  const isCurrent = authority.isCurrent.bind(authority);
  if (!vault) unavailable();
  const root = pinnedDirectory(authority.privateRoot);
  const dir = pinnedDirectory(authority.directory);
  const within = relative(root.path, dir.path);
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) unavailable();
  const current = (): boolean => {
    try {
      if (!isCurrent()) return false;
      for (const pin of [root, dir]) {
        const info = lstatSync(pin.path);
        if (
          !info.isDirectory() ||
          info.dev !== pin.dev ||
          info.ino !== pin.ino ||
          (info.mode & 0o077) !== 0 ||
          realpathSync.native(pin.path) !== pin.path
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  const requireCurrent = () => {
    if (!current()) unavailable();
  };
  return { directory: dir.path, current, requireCurrent, vault };
}

/** Finish only our interrupted link publication, never an arbitrary two-link target. */
function recoverCreatingLink(dir: ReturnType<typeof checkedDirectory>, name: StrategyFileName) {
  dir.requireCurrent();
  const target = join(dir.directory, name);
  const current = lstatSync(target, { throwIfNoEntry: false });
  if (current?.nlink !== 2) return;
  if (!current.isFile() || (current.mode & 0o077) !== 0) unavailable();
  const pattern = new RegExp(
    `^\\.${name.replace(".", "\\.")}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.creating$`,
  );
  const entries = readdirSync(dir.directory);
  if (entries.length > 1_000) unavailable();
  const candidates = entries.filter((entry) => {
    if (!pattern.test(entry)) return false;
    try {
      const info = lstatSync(join(dir.directory, entry));
      return (
        info.isFile() &&
        info.nlink === 2 &&
        (info.mode & 0o077) === 0 &&
        info.dev === current.dev &&
        info.ino === current.ino
      );
    } catch {
      return false;
    }
  });
  if (candidates.length !== 1) unavailable();
  const staged = join(dir.directory, candidates[0] as string);
  const info = lstatSync(staged);
  if (
    !info.isFile() ||
    info.nlink !== 2 ||
    (info.mode & 0o077) !== 0 ||
    info.dev !== current.dev ||
    info.ino !== current.ino
  )
    unavailable();
  dir.requireCurrent();
  const before = lstatSync(target);
  if (before.dev !== current.dev || before.ino !== current.ino || before.nlink !== 2) unavailable();
  const stageBefore = lstatSync(staged);
  if (stageBefore.dev !== current.dev || stageBefore.ino !== current.ino || stageBefore.nlink !== 2)
    unavailable();
  unlinkSync(staged);
  fsyncDirectory(dir.directory);
  dir.requireCurrent();
  const after = lstatSync(target);
  if (
    !after.isFile() ||
    after.dev !== current.dev ||
    after.ino !== current.ino ||
    after.nlink !== 1 ||
    (after.mode & 0o077) !== 0
  )
    unavailable();
}

/** Pinned private directory access shared by native document and CLI adapters. */
export function strategyDirectoryAccess(authority: StrategyDirectoryAuthority) {
  const dir = checkedDirectory(authority);
  return {
    ...dir,
    readFixed(name: StrategyFileName): string | null {
      dir.requireCurrent();
      if (name !== STRATEGY_YAML && name !== STRATEGY_MD) unavailable();
      recoverCreatingLink(dir, name);
      const text = readBounded(join(dir.directory, name), FILE_LIMIT);
      dir.requireCurrent();
      return text;
    },
    createAbsent(name: StrategyFileName, text: string): "created" | "exists" {
      dir.requireCurrent();
      const stage = stagedOwners.get(dir.directory);
      if (stage?.current() === true) unavailable();
      if (stage) stagedOwners.delete(dir.directory);
      if (name !== STRATEGY_YAML && name !== STRATEGY_MD) unavailable();
      const bytes = Buffer.from(text, "utf8");
      if (bytes.length > FILE_LIMIT) unavailable();
      const target = join(dir.directory, name);
      recoverCreatingLink(dir, name);
      // Refuse unsafe existing targets before and after staging. linkSync is the no-overwrite commit.
      if (checkedRegular(target)) return "exists";
      const temporary = join(dir.directory, `.${name}.${randomUUID()}.creating`);
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
        0o600,
      );
      let staged: { dev: number; ino: number } | null = null;
      try {
        try {
          fchmodSync(fd, 0o600);
          staged = fstatSync(fd);
          let written = 0;
          while (written < bytes.length)
            written += writeSync(fd, bytes, written, bytes.length - written);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        dir.requireCurrent();
        const info = lstatSync(temporary);
        if (
          !staged ||
          !info.isFile() ||
          info.nlink !== 1 ||
          info.dev !== staged.dev ||
          info.ino !== staged.ino ||
          (info.mode & 0o077) !== 0
        )
          unavailable();
        checkedRegular(target);
        try {
          linkSync(temporary, target);
        } catch (error) {
          if (
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "EEXIST"
          )
            return "exists";
          throw error;
        }
        fsyncDirectory(dir.directory);
        return "created";
      } finally {
        const info = lstatSync(temporary, { throwIfNoEntry: false });
        if (dir.current() && staged && info?.dev === staged.dev && info.ino === staged.ino) {
          unlinkSync(temporary);
          fsyncDirectory(dir.directory);
        }
      }
    },
  };
}

function checkedRegular(path: string): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info === undefined) return false;
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) unavailable();
  return true;
}

function readBounded(path: string, limit: number): string | null {
  if (!checkedRegular(path)) return null;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | nofollow | nonblock);
  } catch (error) {
    if (missing(error)) return null;
    return unavailable();
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit || (info.mode & 0o077) !== 0)
      unavailable();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > limit) unavailable();
      chunks.push(chunk.subarray(0, n));
    }
    const now = lstatSync(path);
    const after = fstatSync(fd);
    if (
      !now.isFile() ||
      now.nlink !== 1 ||
      now.dev !== info.dev ||
      now.ino !== info.ino ||
      (now.mode & 0o077) !== 0 ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      unavailable();
    // Private recovery keeps exact bytes; the planner separately computes Python's semantic read.
    return decoder.decode(Buffer.concat(chunks, total));
  } catch {
    return unavailable();
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A bounded, 0600 fixed-name temporary; at most one orphan per managed target. */
function writeTemporary(directory: string, name: string, text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > limit) unavailable();
  const path = join(directory, `${name.startsWith(".") ? "" : "."}${name}.approving`);
  if (checkedRegular(path)) unlinkSync(path);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(directory);
  return path;
}

const image = z.strictObject({
  yaml: z.string().max(FILE_LIMIT).nullable(),
  md: z.string().max(FILE_LIMIT).nullable(),
});
const digests = z.strictObject({ yaml: z.string().nullable(), md: z.string().nullable() });
const managed = z.strictObject({
  image,
  digests,
  approvalEid: z.string().nullable(),
  version: z.string().nullable(),
  recorded: z.literal(true).optional(),
});
const journalSchema = z.strictObject({
  vault: z.string().min(1),
  baseline: image,
  baselineDigests: digests,
  baselineVersion: z.string().nullable(),
  managed,
  pending: z.strictObject({ before: managed, after: managed }).nullable(),
  receipts: z.array(managed),
});

/** Returns two ports over the same pinned profile directory; call only with a real injected authority. */
export function strategyPublicationPorts(authority: StrategyDirectoryAuthority): {
  files: StrategyPublicationFiles;
  journal: PrivateStrategyJournal;
} {
  const dir = checkedDirectory(authority);
  const owner = {};
  const release = () => {
    if (active.size === 0 && stagedOwners.get(dir.directory)?.owner === owner)
      stagedOwners.delete(dir.directory);
  };
  const retire = (
    token: object,
    temp: { path: string; name: StrategyFileName; dev: number; ino: number },
  ) => {
    tokens.delete(token);
    if (active.get(temp.name) === token) active.delete(temp.name);
    release();
    if (dir.current() && ownsTemp(temp)) {
      unlinkSync(temp.path);
      fsyncDirectory(dir.directory);
    }
  };
  const path = (name: StrategyFileName) => {
    if (name !== STRATEGY_YAML && name !== STRATEGY_MD) unavailable();
    recoverCreatingLink(dir, name);
    return join(dir.directory, name);
  };
  const tokens = new WeakMap<
    object,
    { path: string; name: StrategyFileName; dev: number; ino: number }
  >();
  const active = new Map<StrategyFileName, object>();
  const ownsTemp = (temp: { path: string; dev: number; ino: number }): boolean => {
    const info = lstatSync(temp.path, { throwIfNoEntry: false });
    return (
      info?.isFile() === true && info.nlink === 1 && info.dev === temp.dev && info.ino === temp.ino
    );
  };
  const read = (): StrategyFileImage => {
    dir.requireCurrent();
    const yaml = readBounded(path(STRATEGY_YAML), FILE_LIMIT);
    const md = readBounded(path(STRATEGY_MD), FILE_LIMIT);
    dir.requireCurrent();
    return { yaml, md };
  };
  const files: StrategyPublicationFiles = {
    vault: dir.vault,
    isCurrent: dir.current,
    read: async () => read(),
    readSync: read,
    async stage(name, text) {
      dir.requireCurrent();
      if (name !== STRATEGY_YAML && name !== STRATEGY_MD) unavailable();
      const held = stagedOwners.get(dir.directory);
      if (held?.owner !== owner && held?.current() === true) unavailable();
      if (active.has(name)) unavailable();
      stagedOwners.set(dir.directory, { owner, current: dir.current });
      try {
        const tempPath = writeTemporary(dir.directory, name, text, FILE_LIMIT);
        dir.requireCurrent();
        const token = {};
        const info = lstatSync(tempPath);
        tokens.set(token, { path: tempPath, name, dev: info.dev, ino: info.ino });
        active.set(name, token);
        return token;
      } catch (error) {
        release();
        throw error;
      }
    },
    async install(name, token) {
      const temp = tokens.get(token);
      if (temp === undefined || temp.name !== name || active.get(name) !== token) unavailable();
      try {
        dir.requireCurrent();
        if (!ownsTemp(temp)) unavailable();
        checkedRegular(path(name));
        renameSync(temp.path, path(name));
        fsyncDirectory(dir.directory);
        dir.requireCurrent();
      } finally {
        retire(token, temp);
      }
    },
    async remove(name) {
      dir.requireCurrent();
      const held = stagedOwners.get(dir.directory);
      if (held?.owner !== owner && held?.current() === true) unavailable();
      if (checkedRegular(path(name))) {
        unlinkSync(path(name));
        fsyncDirectory(dir.directory);
      }
      dir.requireCurrent();
    },
    async discard(token) {
      const temp = tokens.get(token);
      if (temp !== undefined) {
        try {
          dir.requireCurrent();
          if (active.get(temp.name) !== token || !ownsTemp(temp)) unavailable();
        } finally {
          retire(token, temp);
        }
      }
      dir.requireCurrent();
    },
  };
  const journalPath = join(dir.directory, JOURNAL_NAME);
  const journal: PrivateStrategyJournal = {
    vault: dir.vault,
    async read(): Promise<StrategyPublicationJournal | null> {
      dir.requireCurrent();
      const text = readBounded(journalPath, JOURNAL_LIMIT);
      dir.requireCurrent();
      if (text === null) return null;
      try {
        const parsed = journalSchema.parse(JSON.parse(text));
        if (parsed.vault !== dir.vault) unavailable();
        return parsed;
      } catch {
        return unavailable();
      }
    },
    async write(value) {
      dir.requireCurrent();
      const parsed = journalSchema.parse(value);
      if (parsed.vault !== dir.vault) unavailable();
      checkedRegular(journalPath);
      const temp = writeTemporary(
        dir.directory,
        JOURNAL_NAME,
        `${JSON.stringify(parsed)}\n`,
        JOURNAL_LIMIT,
      );
      dir.requireCurrent();
      renameSync(temp, journalPath);
      fsyncDirectory(dir.directory);
      dir.requireCurrent();
    },
  };
  return { files, journal };
}
