// An in-memory profile strategy directory for tests: the read port (`StrategyFilesPort`) and the
// device's publication files + private journal (`StrategyFileSyncPorts`) over the same two texts.
import {
  StrategyPublicationError,
  type StrategyPublicationFiles,
  type StrategyPublicationJournal,
} from "../services/proposalPublication.js";
import {
  STRATEGY_MD,
  STRATEGY_YAML,
  type StrategyFileName,
  type StrategyFilesPort,
  type StrategyReadError,
} from "../services/strategy.js";
import type { StrategyFileSyncPorts } from "../services/strategyFileSync.js";

export class MemoryStrategyDir implements StrategyFilesPort {
  readonly texts = new Map<StrategyFileName, string>();
  readonly errors = new Map<StrategyFileName, string>();
  writes = 0;
  journal: StrategyPublicationJournal | null = null;
  readonly sync: StrategyFileSyncPorts;
  readonly vault: string;

  constructor(vault: string) {
    this.vault = vault;
    const image = () => {
      if (this.errors.size > 0) throw new StrategyPublicationError("unavailable");
      return {
        yaml: this.texts.get(STRATEGY_YAML) ?? null,
        md: this.texts.get(STRATEGY_MD) ?? null,
      };
    };
    const files: StrategyPublicationFiles = {
      vault,
      isCurrent: () => true,
      read: async () => image(),
      readSync: image,
      stage: async (name, text) => ({ name, text }),
      install: async (name, temporary) => {
        const staged = temporary as { name: StrategyFileName; text: string };
        if (staged.name !== name) throw new Error("wrong synthetic temporary");
        this.writes += 1;
        this.texts.set(name, staged.text);
      },
      remove: async (name) => {
        this.writes += 1;
        this.texts.delete(name);
      },
      discard: async () => {},
    };
    this.sync = {
      files,
      journal: {
        vault,
        read: async () => (this.journal === null ? null : structuredClone(this.journal)),
        write: async (next) => {
          this.journal = structuredClone(next);
        },
      },
    };
  }

  async read(name: StrategyFileName): Promise<string | null | StrategyReadError> {
    const error = this.errors.get(name);
    if (error !== undefined) return { error };
    return this.texts.get(name) ?? null;
  }

  async write(name: StrategyFileName, text: string): Promise<void> {
    this.writes += 1;
    this.texts.set(name, text);
  }

  async exists(name: StrategyFileName): Promise<boolean> {
    return this.texts.has(name);
  }
}
