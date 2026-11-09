// The synchronous native tool boundary. The host owns queues and supplies a buffered command writer.
import type { IsoDate } from "@cashu/domain";
import type { market } from "@cashu/domain/investments";
import type { Command, CommandResult } from "@cashu/store";
import type { ProfileView } from "@cashu/store/core";
import type { Read } from "@cashu/store/query";

export interface ToolInventoryEntry {
  readonly name: string;
  readonly module: string;
  readonly also: readonly string[];
}

export interface NativeToolStore {
  /** Host-checked connector catalog and profile-scoped read authority. No owner approval or secrets. */
  readonly connectors?: {
    list(): Promise<{
      readonly installed: readonly {
        readonly id: string;
        readonly name: string;
        readonly module: string;
        readonly kind: string;
        readonly status: string;
        readonly bindings: number;
        readonly lastRun: {
          readonly command: string;
          readonly outcome: string;
          readonly errorKind: string | null;
          readonly at: string;
          readonly records: number;
        } | null;
      }[];
      readonly catalog: readonly {
        readonly id: string;
        readonly name: string;
        readonly module: string;
        readonly kind: string;
        readonly version: string;
        readonly maintainer: string | null;
        readonly lastVerified: string | null;
        readonly countries: readonly string[] | null;
        readonly contentSha256: string;
        readonly stale: boolean;
        readonly valid: boolean;
        readonly installedStatus: string | null;
        readonly installedSameContent: boolean | null;
      }[];
    }>;
    testFile(input: {
      readonly path: string;
      readonly file?: string;
      readonly fixture?: string;
    }): Promise<{
      readonly ok: boolean;
      readonly id: string | null;
      readonly version: string | null;
      readonly interpreter: string | null;
      readonly module: string | null;
      readonly kind: string | null;
      readonly detect: boolean | null;
      readonly documentValid: boolean | null;
      readonly errorKind: string | null;
      readonly records: number;
      readonly runs: readonly {
        readonly command: "detect" | "convert" | "fetch";
        readonly outcome: "ok" | "failed";
        readonly errorKind: string | null;
        readonly records: number;
      }[];
      readonly document: {
        readonly format: string;
        readonly counts: Readonly<Record<string, number>>;
        readonly issueKinds: readonly string[];
      } | null;
    }>;
    propose(input: { readonly path?: string; readonly catalogId?: string }): Promise<{
      readonly id: string;
      readonly status: "pending";
      readonly replaced: boolean;
      readonly contentSha256: string;
      readonly module: string;
      readonly kind: string;
      readonly hosts: readonly string[];
      readonly secretIds: readonly string[];
    }>;
  };
  readonly investmentAsync?: import("../providers/investmentAsyncTypes.js").InvestmentAsyncCapabilities;
  readonly investmentWrites?: import("../providers/investmentWriteTypes.js").InvestmentWriteServices;
  readonly research?: import("../providers/researchTypes.js").ResearchServices;
  /** Supplied only when the host establishes native market/strategy read authority. */
  readonly investments?: import("../providers/investmentReadTypes.js").InvestmentReads;
  readonly investmentHistory?: import("../providers/investmentHistoryTypes.js").InvestmentHistoryReads;
  /** Same checked-file policy as the existing budget reader, with investments extensions. */
  readonly readInvestmentImportFile?: (rawPath: string) => {
    readonly name: string;
    readonly bytes: Uint8Array;
  };
  /** Profile-only YAML authority; deliberately separate from general import-file authority. */
  readonly readInvestmentMappingFile?: (rawPath: string) => string | Promise<string>;
  readonly read: Read;
  run<I, R>(command: Command<I, R>, input: unknown): CommandResult<R> | Promise<CommandResult<R>>;
  readonly prices: market.PriceCache | null;
  /** A resolved exact-vault market image, including migrated alias-less instruments. */
  readonly marketData?: market.CachedMarketData;
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
