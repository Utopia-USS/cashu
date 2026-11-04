// The commands the host runs itself. S39 slices add theirs here and delete their lines from
// delegated.ts in the same change.
import { homedir, tmpdir } from "node:os";
import type { market } from "@cashu/domain/investments";
import type { HostService } from "@cashu/node-host";
import type { PerformanceService } from "@cashu/store/investments/performance";
import type { InvestmentScreenSources } from "@cashu/store/investments/screen";
import type { Read } from "@cashu/store/query";
import type { createNativeCreationService } from "../nativeCreation.js";
import { currentRuntime, type HostRuntime, shippedSkillsSource } from "../runtime.js";
import type { HostStores, OpenVault } from "../stores.js";
import type { HostWorker } from "../worker/service.js";
import type { WorkspaceProvider } from "../workspace/index.js";
import { assetCommands } from "./assets/index.js";
import { type BankingCliDeps, bankingCommands } from "./banking.js";
import type { CategorizeProvider, CloudCategorizeProvider } from "./budget/categorizeOllama.js";
import { budgetCommands } from "./budget/index.js";
import { commandStatusCommand } from "./commandStatus.js";
import { type ConnectorCliDeps, connectorCommands } from "./connectors/index.js";
import { accountCommands } from "./core/accounts.js";
import { printConsole } from "./core/console.js";
import { profileCommands } from "./core/profiles.js";
import { skillsCommand } from "./core/skills.js";
import { statsCommand } from "./core/stats.js";
import { genesisCommand } from "./genesis/command.js";
import type { StrategyCliFiles } from "./investments/context.js";
import { investmentCommands } from "./investments/index.js";
import { loansCommands } from "./loans/index.js";
import type { PortedCommand } from "./tree.js";
import { workerWorkspaceCommands } from "./workerWorkspace.js";

export interface PortedDeps {
  readonly home?: string;
  readonly tmpDir?: string;
  readonly now?: () => number;
  readonly runtime?: HostRuntime;
  /** Explicit packaged resource location; source builds derive it from the checkout. */
  readonly skillsSource?: string;
  /** Supplied only when Python is absent: mixed sessions retain Python financial ownership. */
  readonly nativeStores?: Pick<HostStores, "vaults">;
  readonly strategyFiles?: (vault: OpenVault, profileSlug: string) => StrategyCliFiles | null;
  readonly classifier?: CategorizeProvider;
  readonly cloudClassifier?: CloudCategorizeProvider;
  readonly investmentSources?: InvestmentScreenSources;
  readonly performance?: PerformanceService;
  readonly prices?: market.PriceCache | null;
  readonly marketData?: (read: Read, vault: string) => market.CachedMarketData | null;
  readonly creation?: Pick<
    ReturnType<typeof createNativeCreationService>,
    "prepare" | "commit" | "inspect"
  >;
  readonly onCreationReady?: () => void;
  readonly workspace?: WorkspaceProvider;
  readonly worker?: () => HostWorker | null;
  readonly service?: () => HostService | null;
  readonly connectors?: ConnectorCliDeps;
  readonly banking?: BankingCliDeps;
}

export function portedCommands(deps: PortedDeps = {}): PortedCommand[] {
  let runs = 0;
  return [
    ...(deps.nativeStores === undefined ? [] : [commandStatusCommand(deps.nativeStores)]),
    ...(deps.nativeStores === undefined
      ? []
      : budgetCommands({
          stores: deps.nativeStores,
          now: deps.now ?? Date.now,
          strategyFiles: deps.strategyFiles,
          classifier: deps.classifier,
          cloudClassifier: deps.cloudClassifier,
        })),
    ...(deps.nativeStores === undefined
      ? []
      : assetCommands({
          stores: deps.nativeStores,
          now: deps.now ?? Date.now,
          render: (text, io) =>
            printConsole(io, text, {
              spans: [{ start: 0, end: 7, style: { color: 32 } }],
            }),
        })),
    ...(deps.nativeStores === undefined
      ? []
      : [
          ...accountCommands({ stores: deps.nativeStores, now: deps.now ?? Date.now }),
          ...profileCommands({
            stores: deps.nativeStores,
            creation: deps.creation,
            onCreationReady: deps.onCreationReady,
          }),
          statsCommand({
            stores: deps.nativeStores,
            now: deps.now ?? Date.now,
            prices: deps.prices ?? null,
            marketData: deps.marketData,
          }),
          ...loansCommands({ stores: deps.nativeStores, now: deps.now ?? Date.now }),
        ]),
    ...(deps.nativeStores && deps.investmentSources && deps.performance
      ? investmentCommands({
          stores: deps.nativeStores,
          now: deps.now ?? Date.now,
          sources: deps.investmentSources,
          performance: deps.performance,
          strategyFiles: deps.strategyFiles,
          worker: deps.worker,
        })
      : []),
    ...(deps.nativeStores && deps.worker
      ? workerWorkspaceCommands({
          stores: deps.nativeStores,
          worker: deps.worker,
          ...(deps.service ? { service: deps.service } : {}),
          ...(deps.workspace ? { workspace: deps.workspace } : {}),
        })
      : []),
    ...(deps.connectors ? connectorCommands(deps.connectors) : []),
    ...(deps.banking ? bankingCommands(deps.banking) : []),
    skillsCommand(deps.skillsSource ?? shippedSkillsSource(deps.runtime ?? currentRuntime())),
    {
      // Lab / dev: the genesis event log of a Python data dir (S26). Synchronous work: it holds the
      // host's event loop for its duration (a worker thread is the S39 runner's call).
      name: "genesis",
      async run(args, io) {
        runs += 1;
        return genesisCommand(args, {
          home: deps.home ?? homedir(),
          tmpDir: deps.tmpDir ?? tmpdir(),
          runId: `${process.pid}-${runs}`,
          now: deps.now ?? Date.now,
          stdout: (line) => io.stdout(`${line}\n`),
          stderr: (line) => io.stderr(`${line}\n`),
        });
      },
    },
  ];
}
