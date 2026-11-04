/// <reference types="node" />
// Keep generated Playwright output away from the built renderer. The active suite is native
// desktop specs; the old frontend browser specs remain in frontend/ as historical reference.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = resolve(HERE, "..");
export const REPO = resolve(APP_DIR, "..", "..");
export const GENERATED = join(APP_DIR, "dist", "e2e-run");

export function prepareSpecs(): string {
  mkdirSync(GENERATED, { recursive: true });
  return join(HERE, "desktop-specs");
}
