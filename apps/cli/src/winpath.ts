// Windows path semantics of the data dir resolution (the shim on win32). There is no Python reference
// to mirror on Windows (the retired Python app never ran there), so these follow Windows itself:
// drive-letter and UNC paths, either separator, `..` folded lexically (as the Win32 path parser does
// before any reparse point is followed), `~` against the user's profile folder, and the existing part of
// the path canonicalized on disk (junctions and symlinks followed, the stored letter case), so two
// spellings of one folder never name two hosts. Whether a path is fully qualified is
// `winIsAbsolute` of @cashu/node-host/windows-path, shared with the desktop shell.
import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { UnsupportedHomeError } from "./pypath.js";

/**
 * `~` and `~\...` (or `~/...`) against `home`; any other value unchanged. A `~user` path is refused:
 * Windows has no lookup of another user's profile that the shim could rely on.
 */
export function winExpandUser(value: string, home: string): string {
  if (!value.startsWith("~")) return value;
  const end = value.search(/[\\/]/);
  if ((end === -1 ? value : value.slice(0, end)) !== "~") throw new UnsupportedHomeError();
  return win32.join(home, value.slice(1));
}

/** The canonical on-disk path of an existing path (throws when it does not exist). */
export type RealPath = (path: string) => string;

const nativeRealpath: RealPath = (path) => realpathSync.native(path);

/**
 * `path` made absolute against `cwd` (a fully qualified path), then the longest existing prefix
 * replaced by its canonical form; the components that do not exist yet are kept as written.
 */
export function winResolve(path: string, cwd: string, realpath: RealPath = nativeRealpath): string {
  const full = win32.resolve(cwd, path);
  const missing: string[] = [];
  let head = full;
  for (;;) {
    try {
      const real = realpath(head);
      return missing.length === 0 ? real : win32.join(real, ...missing.reverse());
    } catch {
      const parent = win32.dirname(head);
      if (parent === head) return full;
      missing.push(win32.basename(head));
      head = parent;
    }
  }
}
