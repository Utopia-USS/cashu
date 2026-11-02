// The synchronous native tool boundary. The host owns queues and supplies a buffered command writer.
import type { IsoDate } from "@cashu/domain";
import type { market } from "@cashu/domain/investments";
import type { Command, CommandOutcome } from "@cashu/store";
import type { ProfileView } from "@cashu/store/core";
import type { Read } from "@cashu/store/query";

export interface ToolInventoryEntry {
  readonly name: string;
  readonly module: string;
  readonly also: readonly string[];
}

export interface NativeToolStore {
  /** Supplied only when the host establishes native market/strategy read authority. */
  readonly investments?: import("../providers/investmentReadTypes.js").InvestmentReads;
  readonly investmentHistory?: import("../providers/investmentHistoryTypes.js").InvestmentHistoryReads;
  /** Same checked-file policy as the existing budget reader, with investments extensions. */
  readonly readInvestmentImportFile?: (rawPath: string) => {
    readonly name: string;
    readonly bytes: Uint8Array;
  };
  /** Profile-only YAML authority; deliberately separate from general import-file authority. */
  readonly readInvestmentMappingFile?: (rawPath: string) => string;
  readonly read: Read;
  run<I, R>(command: Command<I, R>, input: unknown): CommandOutcome<R>;
  readonly prices: market.PriceCache | null;
  readonly fxNewest: string | null;
  readonly profile: ProfileView;
  readonly today: IsoDate;
  /** Fixed at the start of this call, shared with command execution. */
  readonly now: () => number;
  readonly toolInventory: readonly ToolInventoryEntry[];
  /** Host-bound checked file reader, scoped to the current profile and MCP session. */
  readonly readBudgetImportFile?: (rawPath: string) => {
    readonly name: string;
    readonly bytes: Uint8Array;
  };
}
