// How the machine of the host and its clients spells a path. The host and every client of it run on
// the same machine, so a path a client sends (a working directory) is judged by the host's own
// platform: a POSIX host refuses `C:\work` and a Windows host refuses `/work` (on Windows that is
// relative to the current drive, not fully qualified). Platform free: the platform is passed in.

/** The path rules of one machine. */
export type PathFlavor = "posix" | "win32";

/** The path rules of a Node `process.platform` value. */
export function pathFlavor(platform: string): PathFlavor {
  return platform === "win32" ? "win32" : "posix";
}

/** `C:\...` with either separator (never the drive-relative `C:work`). */
const WIN_DRIVE = /^[A-Za-z]:[\\/]/;
/** `\\server\share...` with either separator: a non-empty server and share. */
const WIN_UNC = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;
/** `\\?\` (verbatim, skips normalization) and `\\.\` (devices): never a working directory. */
const WIN_NAMESPACE = /^[\\/]{2}[?.][\\/]/;

/**
 * A fully qualified working directory under `flavor`: POSIX `/...`; Windows `C:\...` (either
 * separator) or a UNC share `\\server\share\...` (Node's `process.cwd()` returns one when a shell
 * sits in a network folder, and `path.win32` resolves against it). Never a NUL. Every Windows path
 * accepted here is also accepted by `winIsAbsolute` of `@cashu/node-host/windows-path`, which this
 * package sits below and cannot import: the two must agree.
 */
export function isAbsoluteCwd(path: string, flavor: PathFlavor): boolean {
  if (path.includes("\u0000")) return false;
  if (flavor === "posix") return path.startsWith("/");
  return WIN_DRIVE.test(path) || (WIN_UNC.test(path) && !WIN_NAMESPACE.test(path));
}
