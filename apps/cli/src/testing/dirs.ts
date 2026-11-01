// Temp directories for the shim's tests (resolved, removed after each test file).
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs = new Set<string>();

export function tempDir(prefix = "cashu-shim-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.add(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
}
