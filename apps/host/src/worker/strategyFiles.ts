/** Read-only worker file port over the pinned private strategy directory. */
import {
  STRATEGY_MD,
  STRATEGY_YAML,
  type StrategyFileName,
  type StrategyFilesPort,
} from "@cashu/store/investments/services";
import {
  type StrategyDirectoryAuthority,
  strategyPublicationPorts,
} from "../proposals/strategyFiles.js";

export function workerStrategyFiles(authority: StrategyDirectoryAuthority): StrategyFilesPort {
  const files = strategyPublicationPorts(authority).files;
  if (files.vault !== authority.vault || !files.isCurrent())
    throw new Error("strategy file authority unavailable");
  // A missing YAML/Markdown file is valid; an unreadable or swapped target is not.
  files.readSync();
  const value = (name: StrategyFileName, image: Awaited<ReturnType<typeof files.read>>) => {
    if (name === STRATEGY_YAML) return image.yaml;
    if (name === STRATEGY_MD) return image.md;
    throw new Error("strategy file authority unavailable");
  };
  return {
    async read(name) {
      return value(name, await files.read());
    },
    async exists(name) {
      return value(name, await files.read()) !== null;
    },
    async write() {
      throw new Error("worker_strategy_write_unavailable");
    },
  };
}
