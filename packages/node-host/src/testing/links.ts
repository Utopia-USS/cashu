// Links for tests that check a link refusal on every platform, so the Windows claim "links and
// junctions are refused" is exercised there too. Node's lstat reports a Windows junction and a
// Windows symlink as a symbolic link (libuv reads both reparse points as links), so the same refusal
// paths run. On macOS and Linux the link type is ignored: both helpers are a plain symlinkSync there.
import { symlinkSync } from "node:fs";

/**
 * Links the directory `path` to `target`: a junction on Windows (no privilege needed; the target is
 * made absolute against the link's parent), a symlink elsewhere.
 */
export function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Links the file `path` to `target` (which may be missing). A file symlink needs Developer Mode or an
 * elevated shell on Windows: without either the test is skipped through `skip` (the test context's
 * `ctx.skip`) instead of failing. Any other error, and every error elsewhere, propagates.
 */
export function linkFile(target: string, path: string, skip: (note: string) => never): void {
  try {
    symlinkSync(target, path, "file");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")
      skip("file symlinks need Developer Mode or an elevated shell on Windows");
    throw error;
  }
}
