// The Node flags of a source run (a dev checkout runs TypeScript through `--experimental-transform-types`
// and the repo's `--import` resolver), handed on to a process this one starts: the host starting the
// `cashu` shim for its launcher, the shim starting a host. The child may start in another working
// directory, so a relative `--import` is made absolute against the cwd this process started in.
import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A relative `--import` path made absolute (Node resolves it against the cwd of the start). POSIX
 * keeps the plain path; Windows needs a `file:` URL, because Node reads `C:\...` as a URL with the
 * scheme `c:` and refuses it. Anything else (a package name, a URL) passes unchanged.
 */
function absoluteSpecifier(spec: string, cwd: string, platform: NodeJS.Platform): string {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return spec;
  if (platform !== "win32") return posix.resolve(cwd, spec);
  return pathToFileURL(win32.resolve(cwd, spec), { windows: true }).href;
}

/** Node flags that run TypeScript from source; anything else (an inspector, a loader) is not passed on. */
const SOURCE_FLAG = /^--(experimental-transform-types|no-warnings|disable-warning=.+|import=.+)$/;

/**
 * The flags of `execArgv` that run TypeScript from source, in order, made independent of the cwd the
 * next process starts in (`--experimental-strip-types` becomes `--experimental-transform-types`).
 */
export function sourceRunFlags(
  execArgv: readonly string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i] as string;
    if (arg === "--import" && execArgv[i + 1] !== undefined) {
      out.push(arg, absoluteSpecifier(execArgv[i + 1] as string, cwd, platform));
      i++;
    } else if (arg.startsWith("--import=")) {
      out.push(`--import=${absoluteSpecifier(arg.slice("--import=".length), cwd, platform)}`);
    } else if (arg === "--experimental-strip-types") out.push("--experimental-transform-types");
    else if (SOURCE_FLAG.test(arg)) out.push(arg);
  }
  return out;
}
