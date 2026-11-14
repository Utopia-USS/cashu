// Python path semantics the data dir resolution depends on (POSIX), so the shim resolves exactly the
// path `cashu.core.paths.data_dir()` does: `pathlib.PurePosixPath` normalization, `os.path.expanduser`
// for `~` and `os.path.realpath(path, strict=False)`.
import { lstatSync, readlinkSync } from "node:fs";

/** A `~user` path: Python looks the user up in the password database, which Node cannot. */
class UnsupportedHomeError extends Error {
  constructor() {
    super("a ~user path cannot be resolved by the cashu command");
    this.name = "UnsupportedHomeError";
  }
}

/**
 * `PurePosixPath(p)` as a string: empty and `.` components dropped, `..` kept, exactly two leading
 * slashes kept, no trailing slash; `""` becomes `.`.
 */
export function purePath(path: string): string {
  const lead =
    path.startsWith("//") && !path.startsWith("///") ? "//" : path.startsWith("/") ? "/" : "";
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  return lead + parts.join("/") || ".";
}

/** `os.path.expanduser` for `~` and `~/...`: HOME without its trailing slashes, `/` if empty. */
export function expandUser(value: string, home: string): string {
  if (!value.startsWith("~")) return value;
  const slash = value.indexOf("/");
  if ((slash === -1 ? value : value.slice(0, slash)) !== "~") throw new UnsupportedHomeError();
  return home.replace(/\/+$/, "") + value.slice(1) || "/";
}

const isLink = (path: string): string | undefined => {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
};

/**
 * `os.path.realpath(path, strict=False)` of Python 3.14 (the app's interpreter): an absolute path built
 * component by component from `/` or `cwd` (symlink free); `..` drops the last resolved component, a
 * symlink's target parts are walked in its place, an unreadable or missing component is kept as
 * written, a link loop stops expanding that link.
 */
export function pyRealpath(path: string, cwd: string): string {
  const rest: (string | null)[] = path.split("/").reverse();
  let count = rest.length;
  let current = path.startsWith("/") ? "/" : cwd;
  const seen = new Map<string, string | null>();
  while (count > 0) {
    const name = rest.pop() as string | null;
    if (name === null) {
      seen.set(rest.pop() as string, current);
      continue;
    }
    count -= 1;
    if (name === "" || name === ".") continue;
    if (name === "..") {
      current = current.slice(0, current.lastIndexOf("/")) || "/";
      continue;
    }
    const next = current === "/" ? `/${name}` : `${current}/${name}`;
    if (seen.has(next)) {
      const known = seen.get(next);
      current = known ?? next;
      continue;
    }
    const target = isLink(next);
    if (target === undefined) {
      current = next;
      continue;
    }
    if (target.startsWith("/")) current = "/";
    seen.set(next, null);
    rest.push(next, null);
    const parts = target.split("/").reverse();
    rest.push(...parts);
    count += parts.length;
  }
  return current;
}
