import { cpSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alive, hostPid } from "./electron-test.ts";

/** Restore only the generated native test target, at its authenticated inventory path. */
export function restoreNativeBaseline(dataDir: string): void {
  const root = process.env.E2E_ROOT;
  const baseline = process.env.E2E_NATIVE_BASELINE_DIR;
  const tempRoot = realpathSync(tmpdir());
  if (
    !root ||
    !baseline ||
    realpathSync(root) !== root ||
    !root.startsWith(`${tempRoot}/cashu-e2e-desktop-`) ||
    baseline !== join(root, "native-baseline") ||
    dataDir !== join(root, "native-data") ||
    realpathSync(baseline) !== baseline ||
    realpathSync(dataDir) !== dataDir
  )
    throw new Error("isolated native baseline paths are absent");
  const previous = hostPid(dataDir);
  if (previous !== null && alive(previous))
    throw new Error("synthetic native baseline restore refused while a host is live");
  rmSync(dataDir, { recursive: true, force: true });
  cpSync(baseline, dataDir, { recursive: true });
}
