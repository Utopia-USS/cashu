// Temp directories for the shim's tests (resolved, removed after each test file).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReal } from "@cashu/node-host";
import { removeTempDir } from "@cashu/node-host/testing/temp-dirs";

const dirs = new Set<string>();

export function tempDir(prefix = "cashu-shim-"): string {
  const dir = resolveReal(mkdtempSync(join(tmpdir(), prefix)));
  dirs.add(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of dirs) removeTempDir(dir);
  dirs.clear();
}
