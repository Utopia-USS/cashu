// Per-vault private strategy directories for worker tests: the read-only worker port and the
// device's publication files + journal over the same pinned temp directory (0700 / 0600).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StrategyFileSyncPorts, StrategyFilesPort } from "@cashu/store/investments/services";
import { strategyPublicationPorts } from "../proposals/strategyFiles.js";
import type { OpenVault } from "../stores.js";
import { workerStrategyFiles } from "../worker/strategyFiles.js";
import { tempDir } from "./harness.js";

/** Each vault gets its own directory holding `yaml` as strategy.yaml (none when undefined/null). */
export function testStrategyDirs(yaml?: string | null) {
  const root = tempDir("cashu-strategy-dirs-");
  chmodSync(root, 0o700);
  const dirs = new Map<string, { files: StrategyFilesPort; sync: StrategyFileSyncPorts }>();
  const of = (vault: OpenVault | string) => {
    const id = typeof vault === "string" ? vault : vault.id;
    let entry = dirs.get(id);
    if (entry === undefined) {
      const directory = join(root, id);
      mkdirSync(directory, { mode: 0o700 });
      if (typeof yaml === "string")
        writeFileSync(join(directory, "strategy.yaml"), yaml, { mode: 0o600 });
      const authority = { vault: id, privateRoot: root, directory, isCurrent: () => true };
      entry = { files: workerStrategyFiles(authority), sync: strategyPublicationPorts(authority) };
      dirs.set(id, entry);
    }
    return entry;
  };
  return {
    files: (vault: OpenVault | string): StrategyFilesPort => of(vault).files,
    strategySync: (vault: OpenVault | string): StrategyFileSyncPorts => of(vault).sync,
    directory: (vault: OpenVault | string) =>
      join(root, typeof vault === "string" ? vault : vault.id),
  };
}
