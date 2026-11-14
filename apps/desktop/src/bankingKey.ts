import { lstatSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

/** The application ID the host accepts (`bankingConfigureParamsSchema.appId`). */
const APP_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A PEM private key is a few KB; anything far larger is not one. */
const MAX_KEY_BYTES = 64 * 1024;

/**
 * The Enable Banking application ID: the one the owner typed, else the key file's name (the Control
 * Panel saves the browser-generated key as `<application id>.pem`). Null when neither is valid.
 */
export function bankingAppId(typed: string, keyFilePath: string): string | null {
  const value = typed.trim() || basename(keyFilePath).replace(/\.pem$/i, "");
  return APP_ID.test(value) ? value : null;
}

/**
 * A key file path that did not come from the main process's own chooser (a file the owner dropped on
 * the window, resolved by the preload): an absolute path to a regular `.pem` file of key size. A
 * symlink, a directory or anything else is refused before the host reads it.
 */
export function acceptedDroppedKey(path: string): boolean {
  if (!isAbsolute(path) || !/\.pem$/i.test(path)) return false;
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_KEY_BYTES;
  } catch {
    return false;
  }
}
