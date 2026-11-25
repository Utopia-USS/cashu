// `cashu-host <command>`: the host's own entry (the `cashu host ...` commands of the shim, S56d, call
// the same protocol). Commands:
//   run     become the data dir's host (foreground; a detached spawn runs this too) until stopped,
//           idle, or handed over. Exit 0 clean, 3 another host owns the data dir, 75 handover.
//   status  ask the running host (role admin); exit 0 running, 3 not running. Never starts a host.
//   stop    ask the running host to stop; exit 0 stopped or not running.
// The data dir is `--data-dir <absolute path>` or CASHU_DATA_DIR; nothing else is guessed until the
// shim's data dir resolution lands (S56d). Output is English for operators; the shim maps exit codes to
// its localized texts (S56d).
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { adminStatusResultSchema } from "@cashu/host-protocol";
import {
  connectHost,
  connectOrStart,
  HostBusyError,
  HostConnectError,
  HostStartError,
  RefusalError,
  resolveReal,
  samePath,
} from "@cashu/node-host";
import {
  bundlePathFromEntry,
  packagedBuildId,
  packagedLayout,
  packagedVersion,
  readBundleIdentity,
} from "@cashu/node-host/bundle-identity";
import { processFlavor, workspacesRoot } from "@cashu/node-host/flavor";
import { enterTestBuildKeyringNamespace } from "@cashu/node-host/keyring";
import { readTestBuildMarker, type TestBuildMarker } from "@cashu/node-host/test-build";
import { DailyPriceLock } from "@cashu/store/investments/services";
import { BankingRuntime } from "./banking/runtime.js";
import { bankingUiAction } from "./banking/uiAction.js";
import { bankingWorkerPort } from "./banking/workerPort.js";
import { ClassifierHostPorts } from "./classification/hostPorts.js";
import { connectorOwnerAction } from "./connectorOwnerAction.js";
import { type ConnectorRuntime, createConnectorRuntime } from "./connectorRuntime.js";
import { fetchAuthorityIssue, refreshFetchAuthority } from "./fetchAuthority.js";
import { startLocalHost } from "./host.js";
import { appLanguage, systemLanguage } from "./language.js";
import { recordStartupFailure } from "./localHost/startup.js";
import { createProductionMarket, type ProductionMarket } from "./market/production.js";
import { classifyNativeCreationStartup } from "./nativeCreationJournal.js";
import { readExistingNativeInventory } from "./nativeInventory.js";
import { ProductionVaultSourceFactory } from "./productionVaultSource.js";
import { nativeAccountRemovalApprovals } from "./proposals/accountRemovalApproval.js";
import { nativeStrategyApprovals } from "./proposals/strategyApproval.js";
import { productionRelayOptions } from "./relay/production.js";
import { currentRuntime, shimProgram, shippedSkillsSource } from "./runtime.js";
import { hostUpdateBridge } from "./updateBridge.js";
import { createProductionWorkerBindings } from "./worker/production.js";
import { createProductionWorkspaceProvider } from "./workspace/production.js";

const USAGE_EXIT = 64;
const NOT_RUNNING_EXIT = 3;
const FAILURE_EXIT = 70;

const USAGE = `usage: cashu-host <run|status|stop> [--data-dir <absolute path>] [--linger-ms <ms>] [--bundle <file>]
  run     serve the data dir until stopped or idle (exit 0, 3 busy, 75 handover)
  status  show the running host (exit 0, 3 not running)
  stop    stop the running host`;

export interface MainEnv {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** `run` installs SIGTERM / SIGINT handlers through this (tests pass a no-op). */
  readonly onSignal: (handler: () => void) => void;
  readonly build: string;
}

interface Args {
  readonly command: string;
  readonly dataDir: string;
  readonly lingerMs?: number;
  readonly bundle?: string;
}

export function requiresPackagedIdentity(checkout: string | undefined): boolean {
  return checkout === undefined;
}

/**
 * The home folder of the user the host runs for (agent workspaces root, skill installs): HOME on
 * macOS and Linux; on Windows USERPROFILE, never HOME (a Git Bash or MSYS shell sets a POSIX one
 * there), else the account's own folder (`os.homedir()`).
 */
export function hostHome(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string {
  return (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
}

/**
 * The host features each platform runs. Classifier: HTTP (local Ollama or the Anthropic API), the
 * OS keyring and per-vault settings in a private directory checked per platform
 * (classification/production.ts over @cashu/node-host privateFs), so Windows too. Open Banking: HTTP, a loopback HTTPS callback with an in-memory TLS identity and
 * the OS keyring only, so Windows too. Connectors need the macOS sandbox (`sandbox_unavailable`
 * elsewhere). OS notifications: only the macOS helper routes a click back into the app.
 */
export function hostFeatureGates(platform: NodeJS.Platform): {
  readonly classifier: boolean;
  readonly banking: boolean;
  readonly connectors: boolean;
  readonly notifications: boolean;
} {
  return {
    classifier: platform === "darwin" || platform === "linux" || platform === "win32",
    banking: platform === "darwin" || platform === "linux" || platform === "win32",
    connectors: platform === "darwin",
    notifications: platform === "darwin",
  };
}

function parse(argv: readonly string[], env: MainEnv["env"]): Args | string {
  const [command, ...rest] = argv;
  if (command === undefined) return "a command is required";
  let dataDir = env.CASHU_DATA_DIR;
  let lingerMs: number | undefined;
  let bundle: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) return `${flag} needs a value`;
    if (flag === "--data-dir") dataDir = value;
    else if (flag === "--linger-ms" && /^\d{1,10}$/.test(value)) lingerMs = Number(value);
    else if (flag === "--bundle" && isAbsolute(value)) bundle = value;
    else return `unknown or invalid flag ${flag}`;
  }
  if (dataDir === undefined || !isAbsolute(dataDir)) {
    return "the data dir must be an absolute path (--data-dir or CASHU_DATA_DIR)";
  }
  return {
    command,
    // Windows: the canonical spelling (resolveReal: on-disk letter case, long names instead of 8.3
    // ones), the one `hostRunPaths` gives the server. The vault inventory's roots are built from this
    // path and checked against the server's, so another spelling of the same directory
    // (CASHU_DATA_DIR=C:\Users\RUNNER~1\...) would refuse every vault. macOS and Linux keep it as given.
    dataDir: process.platform === "win32" ? resolveReal(dataDir) : dataDir,
    ...(lingerMs === undefined ? {} : { lingerMs }),
    ...(bundle === undefined ? {} : { bundle }),
  };
}

/** An admin session on the running host; "starting" while it opens its stores, undefined when none. */
async function admin(dataDir: string, build: string, waitStarting = false) {
  try {
    if (!waitStarting) return await connectHost({ dataDir, role: "admin", build });
    return (await connectOrStart({ dataDir, role: "admin", build })).connection;
  } catch (error) {
    if (error instanceof HostStartError && error.starting) return "starting" as const;
    if (error instanceof HostConnectError && error.kind === "starting") return "starting" as const;
    if (error instanceof HostConnectError && error.kind !== "refused") return undefined;
    throw error;
  }
}

function checkedRuntime(
  args: Pick<Args, "bundle">,
  io: MainEnv,
): { bundle?: string; build: string; fingerprint?: string; testBuild?: TestBuildMarker } {
  if (!requiresPackagedIdentity(currentRuntime().checkout)) {
    if (args.bundle !== undefined)
      throw new RefusalError("source host cannot claim a packaged bundle");
    return { build: io.build };
  }
  try {
    const identity = packagedHostIdentity({
      ownEntry: realpathSync.native(import.meta.filename),
      argvEntry: process.argv[1] ?? "",
      execPath: realpathSync.native(process.execPath),
      bundleArg: args.bundle,
      env: io.env,
      platform: process.platform,
    });
    // A sealed test build (manifest-verified marker) never addresses a production keychain item:
    // every OS keyring service of this process maps into the cashu-next-test.<hex> namespace.
    if (identity.testBuild) enterTestBuildKeyringNamespace();
    return identity;
  } catch {
    throw new RefusalError("packaged host identity is unavailable");
  }
}

/** What a packaged host process knows about itself, resolved by the caller. */
export interface PackagedHostInput {
  /** This module's file, native realpath. */
  readonly ownEntry: string;
  /** `process.argv[1]`: the entry the process was started with. */
  readonly argvEntry: string;
  /** The running executable, native realpath. */
  readonly execPath: string;
  /** The `--bundle <file>` stamp, when given. */
  readonly bundleArg: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}

/**
 * The verified identity of a packaged host: its entry is the bundle's `host.mjs` (the `--bundle`
 * stamp, when given, names the same file), run by the bundle's own executable in Node mode, and the
 * bundle verifies (`readBundleIdentity`). The bundle is a `.app` on macOS, the install dir on Windows.
 * Throws on anything else.
 */
export function packagedHostIdentity(input: PackagedHostInput): {
  bundle: string;
  build: string;
  fingerprint: string;
  testBuild?: TestBuildMarker;
} {
  const { ownEntry, platform } = input;
  const same = (a: string, b: string) => samePath(a, b, platform);
  const stat = lstatSync(ownEntry);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !same(input.argvEntry, ownEntry) ||
    (input.bundleArg !== undefined && !same(input.bundleArg, ownEntry))
  )
    throw new Error("invalid bundle stamp");
  const bundle = bundlePathFromEntry(ownEntry, platform);
  const identity = bundle ? readBundleIdentity(bundle, platform) : { kind: "invalid" as const };
  if (bundle === undefined || identity.kind !== "present")
    throw new Error("invalid bundle identity");
  const layout = packagedLayout(identity.canonicalPath, platform);
  if (
    !same(ownEntry, join(layout.resources, "host.mjs")) ||
    !same(input.execPath, layout.executable) ||
    input.env.ELECTRON_RUN_AS_NODE !== "1"
  )
    throw new Error("invalid bundle identity");
  const version = packagedVersion(identity.canonicalPath, platform);
  const testBuild = readTestBuildMarker(identity.canonicalPath, platform);
  return {
    bundle,
    build: packagedBuildId(version, identity.contentDigest),
    fingerprint: identity.fingerprint,
    ...(testBuild ? { testBuild } : {}),
  };
}

function canonicalDir(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Runs one command; resolves with the exit code. */
export async function main(argv: readonly string[], io: MainEnv): Promise<number> {
  const args = parse(argv, io.env);
  if (typeof args === "string") {
    io.stderr(`cashu-host: ${args}\n${USAGE}`);
    return USAGE_EXIT;
  }
  try {
    const runtime = checkedRuntime(args, io);
    if (runtime.testBuild && canonicalDir(args.dataDir) !== runtime.testBuild.dataDir)
      throw new RefusalError("a test build runs only on its own data dir");
    switch (args.command) {
      case "run": {
        const home = hostHome(io.env, process.platform);
        const flavor = processFlavor();
        const sourceRuntime = currentRuntime();
        let workspaceStores: import("./stores.js").HostStores | undefined;
        const skillSource = shippedSkillsSource(sourceRuntime);
        const homeRoot = realpathSync.native(home);
        const workspacesOverride = io.env.CASHU_WORKSPACES_DIR;
        if (
          workspacesOverride &&
          (!isAbsolute(workspacesOverride) || resolve(workspacesOverride) !== workspacesOverride)
        )
          throw new Error("workspace_root_invalid");
        // A test build keeps its workspaces in the marker's dir, never ~/cashU.
        if (
          runtime.testBuild &&
          workspacesOverride &&
          workspacesOverride !== runtime.testBuild.workspacesDir
        )
          throw new RefusalError("a test build keeps its workspaces in its own dir");
        const workspace =
          skillSource === undefined
            ? undefined
            : createProductionWorkspaceProvider({
                dataRoot: args.dataDir,
                home: homeRoot,
                workspacesRoot:
                  runtime.testBuild?.workspacesDir ??
                  workspacesOverride ??
                  workspacesRoot(flavor, homeRoot),
                protectedRoots: [
                  sourceRuntime.dir,
                  ...(sourceRuntime.checkout === undefined ? [] : [sourceRuntime.checkout]),
                ],
                ...(sourceRuntime.checkout === undefined
                  ? {}
                  : { checkout: sourceRuntime.checkout }),
                skillSource,
                version: runtime.build,
                program: shimProgram(sourceRuntime),
                sessions: (vault) => workspaceStores?.vaults.get(vault)?.native ?? null,
                inventory: () => readExistingNativeInventory(args.dataDir).entries,
              });
        const assertAdmission = () => {
          if (classifyNativeCreationStartup(args.dataDir) !== "ready")
            throw new Error("worker_native_admission_unavailable");
        };
        const system = systemLanguage();
        const updateBridge =
          runtime.fingerprint === undefined
            ? undefined
            : hostUpdateBridge(args.dataDir, runtime.build, runtime.fingerprint);
        const dailyLock = new DailyPriceLock();
        let connectors: ConnectorRuntime | undefined;
        let banking: BankingRuntime | undefined;
        let market: ProductionMarket | undefined;
        const classifier = new ClassifierHostPorts();
        let connectorLock: import("@cashu/node-host").HostLock | undefined;
        let workerBindings: ReturnType<typeof createProductionWorkerBindings> | undefined;
        const languageForStores = (stores: import("./stores.js").HostStores) =>
          appLanguage(stores, system);
        const language = (context: Parameters<typeof createProductionWorkerBindings>[0]) =>
          languageForStores(context.stores);
        // The sync relay (relay/production.ts): absent or a bad config file -> no relay.
        const relay = productionRelayOptions({
          dataDir: args.dataDir,
          packaged: runtime.bundle !== undefined,
          testBuild: runtime.testBuild !== undefined,
          env: io.env,
          stderr: io.stderr,
        });
        try {
          const host = await startLocalHost({
            dataDir: args.dataDir,
            build: runtime.build,
            ...(relay === undefined ? {} : { relay }),
            ...(updateBridge === undefined ? {} : { updates: updateBridge }),
            vaultSource: {
              kind: "native-production",
              factory: new ProductionVaultSourceFactory(args.dataDir),
            },
            proposals: {
              bind: (vault, stores) => connectors?.proposals.bind(vault, stores) ?? null,
            },
            strategyProposals: nativeStrategyApprovals({ dailyLock }),
            accountProposals: nativeAccountRemovalApprovals({ dailyLock }),
            strategyLock: dailyLock,
            ...(workspace === undefined ? {} : { workspace }),
            marketFactory: (stores, isCurrent, now) => {
              market = createProductionMarket({
                stores,
                isCurrent,
                now,
                fetch: globalThis.fetch,
                language: () => languageForStores(stores),
                ...(workspace === undefined ? {} : { workspace }),
              });
              return market;
            },
            signals: { bind: (vault) => market?.signals(vault) ?? null },
            connectorCatalog: () => (connectorLock?.held ? connectors?.catalog : undefined),
            banking: () => banking,
            budgetClassifiers: { local: classifier.local, cloud: classifier.cloud },
            classifierSettings: classifier.settings,
            uiActions: [
              bankingUiAction(() => banking),
              classifier.action,
              connectorOwnerAction({
                runtime: () => connectors,
                worker: () => workerBindings,
                dataDir: args.dataDir,
                lock: () => connectorLock,
                now: () => Date.now(),
              }),
            ],
            worker: (context, notifications, queue, lock) => {
              assertAdmission();
              const gates = hostFeatureGates(process.platform);
              workspaceStores = context.stores;
              if (lock?.held && gates.classifier) {
                classifier.bind({
                  dataDir: args.dataDir,
                  lock,
                  stores: context.stores,
                  isCurrentVault: context.isCurrent,
                });
              }
              if (lock?.held && gates.banking) {
                banking = new BankingRuntime({
                  dataDir: args.dataDir,
                  lock,
                  stores: context.stores,
                  isCurrentVault: context.isCurrent,
                  redirectUrl: "https://127.0.0.1:18888/eb/callback",
                  language: () => language(context),
                  isOwnerAction: () => false,
                });
              }
              if (gates.connectors && lock?.held) {
                connectorLock = lock;
                connectors = createConnectorRuntime({
                  dataDir: args.dataDir,
                  lock,
                  stores: context.stores,
                  device: context.stores.device.store,
                  dailyLock,
                  current: context.isCurrent,
                  holder: (vault) => vault.native?.canFetchPublicMarket() === true,
                  refreshHolder: refreshFetchAuthority,
                  now: context.now,
                });
              }
              let notifier: ReturnType<NonNullable<typeof notifications>["notifier"]> = null;
              // On macOS, the checked helper routes activation into Electron. Other platform
              // click routing is still unavailable and must not silently discard a click.
              if (gates.notifications) {
                try {
                  notifier = notifications?.notifier(() => {}) ?? null;
                } catch {
                  notifier = null;
                }
              }
              workerBindings = createProductionWorkerBindings(context, {
                dataDir: args.dataDir,
                assertAdmission,
                strategyDirectory: (vault) => vault.native?.strategyDirectoryAuthority() ?? null,
                canFetchPublicMarket: (vault) => vault.native?.canFetchPublicMarket() ?? false,
                refreshFetchAuthority,
                fetchAuthorityIssue,
                ...(market === undefined ? {} : { market }),
                language: () => language(context),
                dailyLock,
                ...(connectors === undefined ? {} : { connectors: connectors.worker }),
                ...(banking === undefined ? {} : { budget: bankingWorkerPort(banking) }),
                ...(queue === undefined ? {} : { notifications: queue }),
                ...(notifier === null ? {} : { notifier }),
              });
              return workerBindings;
            },
            ...(args.lingerMs === undefined ? {} : { lingerMs: args.lingerMs }),
            ...(runtime.bundle === undefined ? {} : { bundlePath: runtime.bundle }),
          });
          io.onSignal(() => void host.stop("signal"));
          io.stdout(
            `cashu-host: serving (pid ${process.pid}${host.safeMode ? ", safe mode" : ""})`,
          );
          return await host.exit;
        } finally {
          connectors?.catalog.close();
          await banking?.close();
          market?.close();
          updateBridge?.close();
        }
      }
      case "status": {
        const conn = await admin(args.dataDir, runtime.build);
        if (conn === undefined) {
          io.stdout("cashu-host: not running");
          return NOT_RUNNING_EXIT;
        }
        if (conn === "starting") {
          io.stdout("cashu-host: starting (opening the stores)");
          return 0;
        }
        try {
          const s = adminStatusResultSchema.parse(await conn.call("admin.status"));
          const sessions = Object.entries(s.sessions)
            .map(([role, n]) => `${role} ${n}`)
            .join(", ");
          io.stdout(
            [
              `cashu-host: running (pid ${s.pid}, build ${s.build}, protocol ${s.protocol.major}.${s.protocol.minor})`,
              `  started   ${s.startedAt}`,
              `  sessions  ${sessions}`,
              `  vaults    ${s.vaults ?? "?"}, pending writes ${s.pendingWrites ?? "?"}`,
              `  safe mode ${s.safeMode === true ? "yes (no jobs, no network after repeated crashes)" : "no"}`,
              ...(s.sync === undefined
                ? []
                : [
                    `  sync      ${s.sync.state}${s.sync.reason === undefined ? "" : ` (${s.sync.reason})`}, pending ${s.sync.pending ?? "?"}, last run ${s.sync.lastRunAt ?? "never"}`,
                    ...s.sync.vaults.map(
                      (v) =>
                        `    vault ${v.ordinal}: leader ${v.leader ? "yes" : "no"}, intent ${v.intentOpen ? "open" : "closed"}, pipe ${v.pipeSeq}`,
                    ),
                  ]),
              ...(s.stopping ? ["  stopping"] : []),
            ].join("\n"),
          );
          return 0;
        } finally {
          conn.close();
        }
      }
      case "stop": {
        // A starting host is waited for (bounded, connectOrStart), then stopped.
        const conn = await admin(args.dataDir, runtime.build, true);
        if (conn === undefined) {
          io.stdout("cashu-host: not running");
          return 0;
        }
        if (conn === "starting") {
          io.stderr("cashu-host: the host is still starting; try again in a moment");
          return FAILURE_EXIT;
        }
        const closed = new Promise<void>((resolve) => conn.onClose(resolve));
        await conn.call("admin.stop");
        await closed;
        io.stdout("cashu-host: stopped");
        return 0;
      }
      default:
        io.stderr(`cashu-host: unknown command\n${USAGE}`);
        return USAGE_EXIT;
    }
  } catch (error) {
    if (error instanceof HostBusyError) {
      io.stderr("cashu-host: another host owns this data dir");
      return error.exitCode;
    }
    if (args.command === "run") recordStartupFailure(args.dataDir, error, io.build);
    if (error instanceof RefusalError) {
      io.stderr(`cashu-host: ${error.message}`);
      return error.exitCode;
    }
    if (error instanceof HostConnectError) {
      io.stderr(`cashu-host: ${error.message}`);
      return FAILURE_EXIT;
    }
    if (error instanceof Error) {
      const inventoryMessage: Record<string, string> = {
        native_setup_required: "native vault setup required",
        native_provisioning_pending: "native vault provisioning is incomplete",
        native_inventory_invalid: "native vault inventory is invalid",
        native_inventory_changed: "native vault inventory changed during startup",
      };
      const message = inventoryMessage[error.message];
      if (message) {
        io.stderr(`cashu-host: ${message}`);
        return FAILURE_EXIT;
      }
    }
    io.stderr(`cashu-host: failed (${error instanceof Error ? error.name : "error"})`);
    return FAILURE_EXIT;
  }
}
