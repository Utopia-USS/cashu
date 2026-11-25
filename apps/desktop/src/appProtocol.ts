/// <reference types="node" />
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";

export const APP_ENTRY = "app://cashu/assets/desktop/index.html";
const PREFIX = "/assets/desktop/";
const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const CSP =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'";

/** Resolve only Vite's fixed renderer subtree; no decoded or symlink path may escape it. */
export function appAssetPath(rawUrl: string, resourcesPath: string): string | null {
  const match = /^app:\/\/cashu(\/[^?#]*)(?:[?#].*)?$/.exec(rawUrl);
  if (!match) return null;
  const rawPath = match[1] ?? "";
  if (
    !rawPath.startsWith(PREFIX) ||
    rawPath.includes("%") ||
    rawPath.includes("\\") ||
    rawPath.includes("//") ||
    rawPath.split("/").some((part) => part === "." || part === "..")
  )
    return null;
  const suffix = rawPath.slice(PREFIX.length);
  if (!suffix || suffix.startsWith(".") || !/^[A-Za-z0-9_./-]+$/.test(suffix)) return null;
  try {
    const root = realpathSync.native(join(resourcesPath, "renderer"));
    const path = join(root, suffix);
    const actual = realpathSync.native(path);
    const rel = relative(root, actual);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !MIME[extname(path)]) return null;
    return actual;
  } catch {
    return null;
  }
}

export function appAssetResponse(rawUrl: string, resourcesPath: string): Response {
  const path = appAssetPath(rawUrl, resourcesPath);
  if (!path) return new Response("Not found", { status: 404 });
  return new Response(readFileSync(path), {
    headers: {
      "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
