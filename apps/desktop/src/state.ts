/// <reference types="node" />
import { chmodSync, existsSync, mkdirSync } from "node:fs";

/** A newly created private data directory is owner-only. */
export function ensurePrivateDir(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(path, 0o700);
  }
  return path;
}
