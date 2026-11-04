import { cpSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alive, hostPid, stopHost } from "./electron-test.ts";

/**
 * Restore only the generated native test target, at its authenticated inventory path. A synthetic
 * host an earlier spec left behind (a timed-out test never reaches its cleanup) is stopped first:
 * the stores are never replaced under a live host.
 */
export async function restoreNativeBaseline(dataDir: string): Promise<void> {
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
  await stopHost(dataDir);
  const previous = hostPid(dataDir);
  if (previous !== null && alive(previous))
    throw new Error("synthetic native baseline restore refused while a host is live");
  rmSync(dataDir, { recursive: true, force: true });
  cpSync(baseline, dataDir, { recursive: true });
}
