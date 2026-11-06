// `cashu-host <command>`: the host's own entry (the `cashu host ...` commands of the shim, S56d, call
// the same protocol; `cashu migrate ...` runs `migrate` here in the foreground). Commands:
//   run     become the data dir's host (foreground; a detached spawn runs this too) until stopped,
//           idle, or handed over. Exit 0 clean, 3 another host owns the data dir, 75 handover.
//   status  ask the running host (role admin); exit 0 running, 3 not running. Never starts a host.
//   stop    ask the running host to stop; exit 0 stopped or not running.
//   migrate import the data dir's Python data in place, or `migrate verify` it (migration/cli.ts);
//           exit 0 done, 1 failed, 64 usage. Never a host session: a host refuses Python data.
// The data dir is `--data-dir <absolute path>` or CASHU_DATA_DIR; nothing else is guessed until the
// shim's data dir resolution lands (S56d). Output is English for operators; the shim maps exit codes to
// its localized texts (S56d).
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { adminStatusResultSchema } from "@cashu/host-protocol";
import { connectHost, HostBusyError, HostConnectError, RefusalError } from "@cashu/node-host";
import { legacySourceRoots } from "@cashu/node-host/admission";
import {
  bundlePathFromEntry,
  packagedBuildId,
  readBundleIdentity,
} from "@cashu/node-host/bundle-identity";
import { devicePreferences } from "@cashu/store/device";
import { DailyPriceLock } from "@cashu/store/investments/services";
import { runQuery } from "@cashu/store/query";
import { BankingRuntime } from "./banking/runtime.js";
import { bankingUiAction } from "./banking/uiAction.js";
import { bankingWorkerPort } from "./banking/workerPort.js";
import { ClassifierHostPorts } from "./classification/hostPorts.js";
import { connectorOwnerAction } from "./connectorOwnerAction.js";
import { type ConnectorRuntime, createConnectorRuntime } from "./connectorRuntime.js";
import { startLocalHost } from "./host.js";
import { recordStartupFailure } from "./localHost/startup.js";
import { createProductionMarket, type ProductionMarket } from "./market/production.js";
import { migrateCommand } from "./migration/cli.js";
import { classifyNativeCreationStartup } from "./nativeCreationJournal.js";
import { readExistingNativeInventory } from "./nativeInventory.js";
import { nativeSourceAdmission } from "./nativeSourceAdmission.js";
import { ProductionVaultSourceFactory } from "./productionVaultSource.js";
import { currentRuntime, shimProgram, shippedSkillsSource } from "./runtime.js";
import { hostUpdateBridge } from "./updateBridge.js";
import { createProductionWorkerBindings } from "./worker/production.js";
import { createProductionWorkspaceProvider } from "./workspace/production.js";

const USAGE_EXIT = 64;
const NOT_RUNNING_EXIT = 3;
const FAILURE_EXIT = 70;

const USAGE = `usage: cashu-host <run|status|stop> [--data-dir <absolute path>] [--linger-ms <ms>] [--bundle <file>]
       cashu-host migrate [verify] [--data-dir <absolute path>] [--recovery-file <file>] [--json]
  run     serve the data dir until stopped or idle (exit 0, 3 busy, 75 handover)
  status  show the running host (exit 0, 3 not running)
  stop    stop the running host
  migrate import the data dir's Python data in place (exit 0, 1 failed); verify re-checks it`;

export interface MainEnv {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** `run` installs SIGTERM / SIGINT handlers through this (tests pass a no-op). */
  readonly onSignal: (handler: () => void) => void;
  readonly build: string;
  /** One line of stdin without its newline, null at end of input (`migrate --json` words answer). */
  readonly readLine?: () => Promise<string | null>;
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
    dataDir,
    ...(lingerMs === undefined ? {} : { lingerMs }),
    ...(bundle === undefined ? {} : { bundle }),
  };
}

async function admin(dataDir: string, build: string) {
  try {
    return await connectHost({ dataDir, role: "admin", build });
  } catch (error) {
    if (error instanceof HostConnectError && error.kind !== "refused") return undefined;
    throw error;
  }
}

function checkedRuntime(
  args: Pick<Args, "bundle">,
  io: MainEnv,
): { bundle?: string; build: string; fingerprint?: string } {
  if (!requiresPackagedIdentity(currentRuntime().checkout)) {
    if (args.bundle !== undefined)
      throw new RefusalError("source host cannot claim a packaged bundle");
    return { build: io.build };
  }
  try {
    const ownEntry = realpathSync.native(import.meta.filename);
    const argvEntry = process.argv[1] ?? "";
    const stat = lstatSync(ownEntry);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      argvEntry !== ownEntry ||
      (args.bundle !== undefined && args.bundle !== ownEntry)
    )
      throw new Error("invalid bundle stamp");
    const bundle = bundlePathFromEntry(ownEntry);
    const identity = bundle ? readBundleIdentity(bundle) : { kind: "invalid" as const };
    if (
      identity.kind !== "present" ||
      ownEntry !== `${identity.canonicalPath}/Contents/Resources/host.mjs` ||
      realpathSync.native(process.execPath) !== `${identity.canonicalPath}/Contents/MacOS/cashU` ||
      io.env.ELECTRON_RUN_AS_NODE !== "1"
    )
      throw new Error("invalid bundle identity");
    const version = execFileSync(
      "/usr/bin/plutil",
      [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        "-o",
        "-",
        join(identity.canonicalPath, "Contents", "Info.plist"),
      ],
      { encoding: "utf8", timeout: 5_000 },
    ).trim();
    return {
      bundle,
      build: packagedBuildId(version, identity.contentDigest),
      fingerprint: identity.fingerprint,
    };
  } catch {
    throw new RefusalError("packaged host identity is unavailable");
  }
}

/** `migrate ...`: the in-place Python import, in this process (never through a host session). */
async function migrate(argv: readonly string[], io: MainEnv): Promise<number> {
  let build: string;
  try {
    build = checkedRuntime({}, io).build;
  } catch (error) {
    io.stderr(`cashu-host: ${error instanceof RefusalError ? error.message : "failed"}`);
    return error instanceof RefusalError ? error.exitCode : FAILURE_EXIT;
  }
  return migrateCommand(argv, {
    env: io.env,
    stdout: io.stdout,
    stderr: io.stderr,
    readLine: io.readLine ?? (async () => null),
    build,
  });
}

/** Runs one command; resolves with the exit code. */
export async function main(argv: readonly string[], io: MainEnv): Promise<number> {
  if (argv[0] === "migrate") return migrate(argv.slice(1), io);
  const args = parse(argv, io.env);
  if (typeof args === "string") {
    io.stderr(`cashu-host: ${args}\n${USAGE}`);
    return USAGE_EXIT;
  }
  try {
    const runtime = checkedRuntime(args, io);
    switch (args.command) {
      case "run": {
        const home = io.env.HOME || homedir();
        const defaultDir =
          process.platform === "darwin"
            ? join(home, "Library", "Application Support", "cashU")
            : process.platform === "win32"
              ? join(io.env.APPDATA || join(home, "AppData", "Roaming"), "cashU")
              : join(io.env.XDG_DATA_HOME || join(home, ".local", "share"), "cashu");
        const sourceRuntime = currentRuntime();
        const projectRoot = sourceRuntime.checkout ?? sourceRuntime.dir;
        const explicitDataDir = resolve(args.dataDir) !== resolve(defaultDir);
        const legacyRoots = legacySourceRoots(
          args.dataDir,
          projectRoot,
          home,
          io.env,
          process.platform,
          explicitDataDir,
        );
        let workspaceStores: import("./stores.js").HostStores | undefined;
        const skillSource = shippedSkillsSource(sourceRuntime);
        const homeRoot = realpathSync.native(home);
        const workspacesOverride = io.env.CASHU_WORKSPACES_DIR;
        if (
          workspacesOverride &&
          (!isAbsolute(workspacesOverride) || resolve(workspacesOverride) !== workspacesOverride)
        )
          throw new Error("workspace_root_invalid");
        const workspace =
          skillSource === undefined
            ? undefined
            : createProductionWorkspaceProvider({
                dataRoot: args.dataDir,
                home: homeRoot,
                workspacesRoot: workspacesOverride ?? join(homeRoot, "Documents", "cashU"),
                protectedRoots: [
                  sourceRuntime.dir,
                  ...(sourceRuntime.checkout === undefined ? [] : [sourceRuntime.checkout]),
                  ...legacyRoots,
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
        const assertNativeSourceAdmission = nativeSourceAdmission({
          dataDir: args.dataDir,
          projectRoot,
          home,
          env: io.env,
          platform: process.platform,
          explicitDataDir,
        });
        const assertAdmission = () => {
          assertNativeSourceAdmission();
          if (classifyNativeCreationStartup(args.dataDir) !== "ready")
            throw new Error("worker_native_admission_unavailable");
        };
        const systemLanguage: "pl" | "en" = Intl.DateTimeFormat()
          .resolvedOptions()
          .locale.toLowerCase()
          .startsWith("pl")
          ? "pl"
          : "en";
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
        const languageForStores = (stores: import("./stores.js").HostStores) => {
          try {
            const pinned = runQuery(stores.device.store, devicePreferences, undefined).value
              .languagePin;
            return pinned === "pl" || pinned === "en" ? pinned : systemLanguage;
          } catch {
            return systemLanguage;
          }
        };
        const language = (context: Parameters<typeof createProductionWorkerBindings>[0]) =>
          languageForStores(context.stores);
        try {
          const host = await startLocalHost({
            dataDir: args.dataDir,
            build: runtime.build,
            ...(updateBridge === undefined ? {} : { updates: updateBridge }),
            vaultSource: {
              kind: "native-production",
              factory: new ProductionVaultSourceFactory(args.dataDir),
            },
            assertNativeSourceAdmission,
            proposals: { bind: (vault) => connectors?.proposals.bind(vault) ?? null },
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
            connectorCatalog: () => (connectorLock?.held ? connectors?.catalog : undefined),
            banking: () => banking,
            budgetClassifiers: { local: classifier.local, cloud: classifier.cloud },
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
            lan: { kind: "local" },
            worker: (context, notifications, queue, lock) => {
              assertAdmission();
              workspaceStores = context.stores;
              if (lock?.held && (process.platform === "darwin" || process.platform === "linux")) {
                classifier.bind({
                  dataDir: args.dataDir,
                  lock,
                  stores: context.stores,
                  isCurrentVault: context.isCurrent,
                });
              }
              if (lock?.held && (process.platform === "darwin" || process.platform === "linux")) {
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
              if (process.platform === "darwin" && lock?.held) {
                connectorLock = lock;
                connectors = createConnectorRuntime({
                  dataDir: args.dataDir,
                  lock,
                  stores: context.stores,
                  device: context.stores.device.store,
                  dailyLock,
                  current: context.isCurrent,
                  holder: (vault) => vault.native?.canFetchPublicMarket() === true,
                  now: context.now,
                });
              }
              let notifier: ReturnType<NonNullable<typeof notifications>["notifier"]> = null;
              // On macOS, the checked helper routes activation into Electron. Other platform
              // click routing is still unavailable and must not silently discard a click.
              if (process.platform === "darwin") {
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
        const conn = await admin(args.dataDir, runtime.build);
        if (conn === undefined) {
          io.stdout("cashu-host: not running");
          return 0;
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
