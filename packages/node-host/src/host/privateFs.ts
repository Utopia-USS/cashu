// Private files and directories on every platform the host runs on. On macOS and Linux a private file
// is a regular file of this user with mode 0600 (a directory: 0700), and the checks below compare
// exactly that. On Windows Node synthesizes `st_mode` from the read-only attribute (a writable file
// reads as 0666) and there is no `process.getuid`, so the mode and owner checks are skipped there:
// privacy rests on the data dir's owner-only DACL, which the host makes sure of at every start and
// everything below inherits (`windowsAcl.ts`). The type checks (a regular file or a directory, never a
// symlink or a junction: Node's lstat reports both as symbolic links) and the dev / ino / nlink checks
// of the callers stay on every platform.
//
// Windows also lacks O_NOFOLLOW, O_DIRECTORY and O_NONBLOCK (`fs.constants` leaves them undefined), so
// the flags below are 0 there and a caller that relies on O_NOFOLLOW compares the opened file with an
// lstat of its path instead (`openedWithoutLink`). A directory cannot be fsynced on Windows (FlushFileBuffers
// needs write access to the handle), so `syncDirectory` is a no-op there: the renamed or linked file's
// own bytes are fsynced before the rename, and NTFS journals the directory change itself.
//
// NTFS names are case-insensitive, so a path compared with its realpath (a check that no link or
// junction sits on it) matches without letter case on Windows (`samePath`).
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  type Stats,
} from "node:fs";

/** Whether `platform` reports real POSIX permission bits and owners (every one but Windows). */
export const hasPosixModes = (platform: NodeJS.Platform = process.platform): boolean =>
  platform !== "win32";

const optional = constants as Partial<typeof constants>;

/** `O_NOFOLLOW` where the OS has it, else 0 (Windows; see `openedWithoutLink`). */
export const O_NOFOLLOW: number = optional.O_NOFOLLOW ?? 0;
/** `O_DIRECTORY` where the OS has it, else 0 (Windows). */
const O_DIRECTORY: number = optional.O_DIRECTORY ?? 0;
/** `O_NONBLOCK` where the OS has it, else 0 (Windows, where opening a FIFO path is not possible). */
export const O_NONBLOCK: number = optional.O_NONBLOCK ?? 0;

type ModeStat = Pick<Stats, "mode" | "uid">;

const ownedByThisUser = (stat: ModeStat): boolean =>
  typeof process.getuid !== "function" || stat.uid === process.getuid();

/**
 * Whether `stat` has exactly the permission bits `mode` and belongs to this user. Always true on
 * Windows, where both are synthetic (the file type is the caller's check on every platform).
 */
export function hasPrivateMode(
  stat: ModeStat,
  mode: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return !hasPosixModes(platform) || ((stat.mode & 0o777) === mode && ownedByThisUser(stat));
}

/**
 * Whether `stat` grants nothing to group and others, whoever owns it: for entries whose owner is not
 * part of the rule (a strategy folder, a vault binding's directories). Always true on Windows, where
 * the mode is synthetic (the file type is the caller's check on every platform).
 */
export function hasNoGroupOrOtherBits(
  stat: Pick<Stats, "mode">,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return !hasPosixModes(platform) || (stat.mode & 0o077) === 0;
}

/**
 * Whether `stat` grants nothing to group and others and belongs to this user. Always true on Windows,
 * where both are synthetic (the file type is the caller's check on every platform).
 */
export function isOwnerOnly(stat: ModeStat, platform: NodeJS.Platform = process.platform): boolean {
  return !hasPosixModes(platform) || ((stat.mode & 0o077) === 0 && ownedByThisUser(stat));
}

/** Whether two stats name the same file (device and inode; Windows: volume serial and file index). */
export const sameFile = (a: Pick<Stats, "dev" | "ino">, b: Pick<Stats, "dev" | "ino">): boolean =>
  a.dev === b.dev && a.ino === b.ino;

/**
 * Whether two paths name the same location as written: exactly on macOS and Linux, ignoring letter
 * case on Windows (NTFS names are case-insensitive, and the native realpath returns the case stored on
 * disk). For a path against its realpath or a known layout; `sameFile` compares the files themselves.
 */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Whether the file opened from `path` (its fstat: `opened`) was reached without a symlink or junction.
 * Where O_NOFOLLOW exists the open itself refused a link, so this is true; on Windows the path is
 * lstat-ed again and must be no link and the very file that was opened.
 */
export function openedWithoutLink(path: string, opened: Pick<Stats, "dev" | "ino">): boolean {
  if (O_NOFOLLOW !== 0) return true;
  try {
    const link = lstatSync(path);
    return !link.isSymbolicLink() && sameFile(link, opened);
  } catch {
    return false;
  }
}

/**
 * Whether nothing at all exists at `path` (lstat says ENOENT). An open that failed with ENOENT means
 * "missing" only when this holds too: Windows has no O_NOFOLLOW, so its open follows a dangling link
 * or junction to ENOENT where macOS / Linux refuse it (ELOOP). Any other lstat failure throws.
 */
export function nothingAt(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** Makes `dir`'s entries durable (fsync of the directory). A no-op on Windows (see the header). */
export function syncDirectory(dir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  const fd = openSync(dir, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * fsyncs the private directory `path` (exactly 0700, this user's), opened without following a link and
 * checked again through its descriptor. False when the opened entry is not such a directory (nothing
 * synced); open errors propagate. Always true on Windows, where a directory cannot be fsynced.
 */
export function syncPrivateDirectory(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return true;
  const fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_DIRECTORY | O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || !hasPrivateMode(stat, 0o700, platform)) return false;
    fsyncSync(fd);
    return true;
  } finally {
    closeSync(fd);
  }
}
