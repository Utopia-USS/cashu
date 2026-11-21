import { lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** The Vite output consumed by the app protocol and macOS package assembly. */
export function rendererArtifactRoot(repoRoot) {
  return join(resolve(repoRoot), "apps", "desktop", "dist", "renderer");
}

/** Refuse a stale, missing or redirected renderer before building a package. */
export function checkedRendererArtifact(repoRoot) {
  const expected = rendererArtifactRoot(repoRoot);
  const root = realpathSync.native(expected);
  if (root !== expected || !lstatSync(expected).isDirectory())
    throw new Error("Native renderer artifact is redirected");
  const index = join(root, "index.html");
  const actual = realpathSync.native(index);
  const rel = relative(root, actual);
  if (actual !== index || rel === ".." || rel.startsWith(`..${sep}`) || !lstatSync(index).isFile())
    throw new Error("Native renderer entry is invalid");
  return root;
}
