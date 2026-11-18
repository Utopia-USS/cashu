// Start-up of the local host, in order: admission before the lock (vault source,
// bundle identity or refused paths, native inventory), the advertised features, then under the lock
// the crash record, the writer lease, the creation service and the stores (`openHostState`), and
// the stable launcher.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  NATIVE_BANKING_FEATURE,
  NATIVE_CONNECTORS_FEATURE,
  NATIVE_CREATION_FEATURE,
  NATIVE_DEVICES_FEATURE,
  NATIVE_PAIRING_FEATURE,
  NATIVE_RELAY_FEATURE,
  NOTIFICATION_INTENT_FEATURE,
} from "@cashu/host-protocol";
import { classifyStartupError, StartupFailureError } from "@cashu/host-protocol/startup-failure";
import {
  hostRunPaths,
  type RunningHost,
  refusePaths,
  samePath,
  writeStartupFailureRecord,
} from "@cashu/node-host";
import {
  type PackagedLayout,
  packagedLayout,
  readBundleIdentity,
} from "@cashu/node-host/bundle-identity";
import { recentUncleanStarts, recordStart, type StartRecord } from "../crashLoop.js";
import { writeLauncher } from "../launcher.js";
import { takeWriterLease, type WriterLease } from "../lease.js";
import { errorName, fileLog, type HostLog } from "../log.js";
import { createNativeCreationService } from "../nativeCreation.js";
import { classifyNativeCreationStartup } from "../nativeCreationJournal.js";
import { privateNotificationIntents } from "../notifications/intentLedger.js";
import type { HostRelay } from "../relay/service.js";
import { currentRuntime, type HostRuntime, shimProgram } from "../runtime.js";
import {
  type HostStores,
  openHostStores,
  openNativeHostStores,
  openNativeSetupStores,
} from "../stores.js";
import { validateNativeVaultInventorySet } from "../sync/keys/deviceAuthority.js";
import type { LocalHostOptions } from "./options.js";

const requireNative = createRequire(import.meta.url);

type VaultSource = NonNullable<LocalHostOptions["vaultSource"]>;
/** The creation journal's verdict, for the production source only. */
type CreationStartup = ReturnType<typeof classifyNativeCreationStartup> | null;
type NativeCreation = ReturnType<typeof createNativeCreationService>;

interface Admission {
  readonly vaultSource: VaultSource;
  readonly startup: CreationStartup;
}

/** Checks everything that must hold before the host takes the lock. Throws a `StartupFailureError`. */
export function admitStart(options: LocalHostOptions): Admission {
  const vaultSource = options.vaultSource;
  if (vaultSource === undefined)
    throw new StartupFailureError(
      "native_inventory_unavailable",
      "native_vault_provider_unavailable",
    );
  if (options.bundlePath !== undefined) assertBundleIdentity(options.bundlePath, vaultSource);
  else
    refusePaths(
      { dataDir: { label: "data dir", path: options.dataDir }, outputs: [] },
      options.home ?? homedir(),
    );
  if (vaultSource.kind === "native") {
    if (vaultSource.provider.inventory.length === 0)
      throw new StartupFailureError("native_inventory_unavailable", undefined, { vaults: 0 });
    validateNativeVaultInventorySet(vaultSource.provider.inventory, resolve(options.dataDir));
  }
  const startup =
    vaultSource.kind === "native-production"
      ? classifyNativeCreationStartup(resolve(options.dataDir))
      : null;
  if (startup === "ready" && vaultSource.kind === "native-production")
    vaultSource.factory.preflight();
  return { vaultSource, startup };
}

/**
 * A running path in the form the bundle identity uses: resolved on macOS, the native realpath on
 * Windows (whose canonical bundle path is native: long names, on-disk case).
 */
function runningPath(path: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return resolve(path);
  try {
    return realpathSync.native(path);
  } catch {
    return ""; // matches no bundle path: refused
  }
}

/** Where a packaged host process runs from, as the process reports it. */
export interface RunningBundleInput {
  /** The bundle the host was started for (`--bundle` stamp's bundle). */
  readonly bundlePath: string;
  readonly execPath: string;
  /** The directory of the running host entry (`currentRuntime().dir`). */
  readonly runtimeDir: string;
  readonly electronRunAsNode: string | undefined;
  readonly platform: NodeJS.Platform;
}

/**
 * The layout of the verified bundle this process runs from: the bundle verifies, this process is its
 * executable in Node mode and its entry sits in the bundle's resources. Undefined otherwise.
 */
export function runningBundleLayout(input: RunningBundleInput): PackagedLayout | undefined {
  const { platform } = input;
  const identity = readBundleIdentity(input.bundlePath, platform);
  if (identity.kind !== "present" || input.electronRunAsNode !== "1") return undefined;
  const layout = packagedLayout(identity.canonicalPath, platform);
  return samePath(runningPath(input.execPath, platform), layout.executable, platform) &&
    samePath(runningPath(input.runtimeDir, platform), layout.resources, platform)
    ? layout
    : undefined;
}

/**
 * A packaged host runs only from the verified bundle it was started from. On macOS the notification
 * helper also confirms the bundle's code signature; a Windows install has no native helper (and no
 * signature check yet), so its manifest and content digest are the whole check.
 */
function assertBundleIdentity(bundlePath: string, vaultSource: VaultSource): void {
  const platform = process.platform;
  const layout = runningBundleLayout({
    bundlePath,
    execPath: process.execPath,
    runtimeDir: currentRuntime().dir,
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
    platform,
  });
  if (layout === undefined || vaultSource.kind === "synthetic-harness")
    throw new StartupFailureError("unknown", "bundle_identity_unavailable");
  if (platform === "win32") return;
  const notification = requireNative(
    join(layout.resources, "native", "CashUNotifications.node"),
  ) as { identity(): { verified: boolean } };
  if (notification.identity().verified !== true)
    throw new StartupFailureError("unknown", "bundle_identity_unavailable");
}

/** The handshake features this host advertises. */
export function hostFeatures(input: {
  readonly options: LocalHostOptions;
  readonly vaultSource: VaultSource;
  readonly nativeMode: boolean;
}): string[] {
  const { options, vaultSource, nativeMode } = input;
  return [
    "store.v2",
    ...(vaultSource.kind === "native-production" ? [NATIVE_CREATION_FEATURE] : []),
    ...(options.connectorCatalog !== undefined ? [NATIVE_CONNECTORS_FEATURE] : []),
    ...(nativeMode && options.banking !== undefined ? [NATIVE_BANKING_FEATURE] : []),
    ...(nativeMode ? [NATIVE_DEVICES_FEATURE] : []),
    // Pairing runs over the sync relay: an invite without it is refused `no_config` / `relay_off`.
    ...(nativeMode ? [NATIVE_PAIRING_FEATURE] : []),
    ...(nativeMode ? [NOTIFICATION_INTENT_FEATURE] : []),
    ...(nativeMode ? [NATIVE_RELAY_FEATURE] : []),
    "admin.handover",
    "cli.exec",
    "mcp.lines",
    "worker.status",
  ];
}

interface HostState {
  readonly record: StartRecord;
  readonly lease: WriterLease;
  readonly stores: HostStores;
  readonly creation: NativeCreation | undefined;
  readonly notificationIntents: ReturnType<typeof privateNotificationIntents> | undefined;
}

/**
 * Under the host lock: records the start, takes the writer lease, opens the creation service and
 * the stores. On failure logs `host.start-failed`, closes the stores it opened and the server, and
 * rethrows.
 */
export async function openHostState(input: {
  readonly server: RunningHost;
  readonly admission: Admission;
  readonly nativeMode: boolean;
  readonly log: HostLog;
  readonly now: () => number;
  /** The sync relay: adds its remote to the vaults enabled on this device (relay/service.ts). */
  readonly relay: HostRelay;
}): Promise<HostState> {
  const { server, admission, nativeMode, log, now, relay } = input;
  const { vaultSource, startup } = admission;
  let stores: HostStores | undefined;
  try {
    const record = recordStart(server.paths.runDir, now());
    const lease = takeWriterLease(server.lock);
    let creation: NativeCreation | undefined;
    if (vaultSource.kind === "native-production") {
      const checked = classifyNativeCreationStartup(server.paths.dataDir);
      if (checked !== startup)
        throw new StartupFailureError("native_inventory_unavailable", "native_inventory_changed");
      creation = createNativeCreationService({
        dataDir: server.paths.dataDir,
        lock: server.lock,
        now,
        createKeyStore: vaultSource.factory.creationKeyStoreFactory(),
      });
      // Authenticate completed anchors before native sessions take exclusive SQLite opens.
      await creation.primeVerifiedCompleted();
    }
    const source =
      vaultSource.kind === "native-production" && startup === "ready"
        ? { kind: "native" as const, provider: await vaultSource.factory.open(server.lock) }
        : vaultSource;
    if (source.kind === "native") {
      if (source.provider.inventory.length === 0)
        throw new StartupFailureError("native_inventory_unavailable", undefined, { vaults: 0 });
      validateNativeVaultInventorySet(source.provider.inventory, server.paths.dataDir);
    }
    stores =
      source.kind === "native"
        ? await openNativeHostStores(
            server.paths.dataDir,
            relay.wrapSource(source.provider),
            lease,
            log,
            now,
            (device) => relay.attachDevice(device),
          )
        : source.kind === "native-production"
          ? openNativeSetupStores(server.paths.dataDir, lease, log, now)
          : openHostStores(server.paths.dataDir, lease, log, now);
    // Construction checks the private directory while the host lock is held. A bad ledger
    // prevents a native host from advertising click resolution.
    const notificationIntents = nativeMode
      ? privateNotificationIntents(
          server.paths.dataDir,
          () => server.lock.held && !server.stopping,
          now,
        )
      : undefined;
    return { record, lease, stores, creation, notificationIntents };
  } catch (error) {
    const failure = classifyStartupError(error);
    log.error("host.start-failed", {
      error: errorName(error),
      code: failure.code,
      detail: failure.detail ?? null,
    });
    // Stores opened before the failure close before the lock goes (their exclusive SQLite opens).
    try {
      await stores?.close();
    } finally {
      await server.close();
    }
    throw error;
  }
}

/** Writes the stable launcher (`launcherPath`); a failure is logged, never fatal. */
export function writeHostLauncher(dataDir: string, runtime: HostRuntime, log: HostLog): void {
  try {
    if (writeLauncher(dataDir, shimProgram(runtime))) log.info("host.launcher-written");
  } catch (error) {
    log.warn("host.launcher-failed", { error: errorName(error) });
  }
}

/**
 * A failed start's last act: the typed failure record in `<data dir>/diagnostics/` (what Electron
 * main shows on the recovery screen) and a `host.start-failure` log line with the same codes. Only
 * codes and counts are written. Best effort: it never replaces the error being reported.
 */
export function recordStartupFailure(
  dataDir: string,
  error: unknown,
  build: string,
  now: number = Date.now(),
): void {
  try {
    const paths = hostRunPaths(dataDir);
    const failure = classifyStartupError(error, {
      recentCrashes: recentUncleanStarts(paths.runDir, now),
    });
    writeStartupFailureRecord(paths.dataDir, failure, build, now);
    fileLog(paths.logPath).error("host.start-failure", {
      code: failure.code,
      detail: failure.detail ?? null,
      stage: failure.stage,
      error: errorName(error),
    });
  } catch {
    // No diagnostics directory (a read-only or foreign data dir): the exit code still reports it.
  }
}
