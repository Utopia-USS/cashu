// Start-up of the local host, in order: admission before the lock (vault source, legacy data,
// bundle identity or refused paths, native inventory), the advertised features, then under the lock
// the crash record, the writer lease, the creation service and the stores (`openHostState`), and
// the stable launcher.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  NATIVE_BANKING_FEATURE,
  NATIVE_CONNECTORS_FEATURE,
  NATIVE_CREATION_FEATURE,
  NATIVE_DEVICES_FEATURE,
  NATIVE_PAIRING_FEATURE,
  NOTIFICATION_INTENT_FEATURE,
} from "@cashu/host-protocol";
import { type RunningHost, refusePaths } from "@cashu/node-host";
import { legacyDataAdmission } from "@cashu/node-host/admission";
import { readBundleIdentity } from "@cashu/node-host/bundle-identity";
import { recordStart, type StartRecord } from "../crashLoop.js";
import { writeLauncher } from "../launcher.js";
import { takeWriterLease, type WriterLease } from "../lease.js";
import { errorName, type HostLog } from "../log.js";
import { createNativeCreationService } from "../nativeCreation.js";
import { classifyNativeCreationStartup } from "../nativeCreationJournal.js";
import { privateNotificationIntents } from "../notifications/intentLedger.js";
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
  /** Refuses a data dir that still holds legacy Python data (and the entry's own source roots). */
  readonly assertNativeSourceAdmission: () => void;
}

/** Checks everything that must hold before the host takes the lock. Throws an error code. */
export function admitStart(options: LocalHostOptions): Admission {
  const vaultSource = options.vaultSource;
  if (vaultSource === undefined) throw new Error("native_vault_provider_unavailable");
  const assertNativeSourceAdmission = () => {
    // T54 replaces this temporary absence proof with authenticated completed migration.
    if (legacyDataAdmission(options.dataDir) !== "no_legacy_sentinel")
      throw new Error("legacy_python_db_awaits_s62");
    options.assertNativeSourceAdmission?.();
  };
  if (vaultSource.kind === "native-production") assertNativeSourceAdmission();
  if (options.bundlePath !== undefined) assertBundleIdentity(options.bundlePath, vaultSource);
  else
    refusePaths(
      { dataDir: { label: "data dir", path: options.dataDir }, outputs: [] },
      options.home ?? homedir(),
    );
  if (vaultSource.kind === "native") {
    if (vaultSource.provider.inventory.length === 0)
      throw new Error("native_inventory_unavailable");
    validateNativeVaultInventorySet(vaultSource.provider.inventory, resolve(options.dataDir));
  }
  const startup =
    vaultSource.kind === "native-production"
      ? classifyNativeCreationStartup(resolve(options.dataDir))
      : null;
  if (startup === "ready" && vaultSource.kind === "native-production")
    vaultSource.factory.preflight();
  return { vaultSource, startup, assertNativeSourceAdmission };
}

/** A packaged host runs only from the verified bundle it was started from. */
function assertBundleIdentity(bundlePath: string, vaultSource: VaultSource): void {
  const identity = readBundleIdentity(bundlePath);
  if (
    identity.kind !== "present" ||
    vaultSource.kind === "synthetic-harness" ||
    process.env.ELECTRON_RUN_AS_NODE !== "1" ||
    resolve(process.execPath) !== join(identity.canonicalPath, "Contents", "MacOS", "cashU") ||
    resolve(currentRuntime().dir) !== join(identity.canonicalPath, "Contents", "Resources")
  )
    throw new Error("bundle_identity_unavailable");
  const notification = requireNative(
    join(identity.canonicalPath, "Contents", "Resources", "native", "CashUNotifications.node"),
  ) as { identity(): { verified: boolean } };
  if (notification.identity().verified !== true) throw new Error("bundle_identity_unavailable");
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
    ...(nativeMode && options.lan !== undefined && options.lan.kind !== "off"
      ? [NATIVE_PAIRING_FEATURE]
      : []),
    ...(nativeMode ? [NOTIFICATION_INTENT_FEATURE] : []),
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
 * the stores. On failure logs `host.start-failed`, closes the server and rethrows.
 */
export async function openHostState(input: {
  readonly server: RunningHost;
  readonly admission: Admission;
  readonly nativeMode: boolean;
  readonly log: HostLog;
  readonly now: () => number;
}): Promise<HostState> {
  const { server, admission, nativeMode, log, now } = input;
  const { vaultSource, startup } = admission;
  try {
    const record = recordStart(server.paths.runDir, now());
    const lease = takeWriterLease(server.lock);
    let creation: NativeCreation | undefined;
    if (vaultSource.kind === "native-production") {
      const checked = classifyNativeCreationStartup(server.paths.dataDir);
      if (checked !== startup) throw new Error("native_inventory_changed");
      creation = createNativeCreationService({
        dataDir: server.paths.dataDir,
        lock: server.lock,
        now,
        createKeyStore: vaultSource.factory.creationKeyStoreFactory(),
        assertSourceAdmission: admission.assertNativeSourceAdmission,
      });
      // Authenticate completed anchors before native sessions take exclusive SQLite opens.
      await creation.primeVerifiedCompleted();
    }
    const source =
      vaultSource.kind === "native-production" && startup === "ready"
        ? { kind: "native" as const, provider: await vaultSource.factory.open(server.lock) }
        : vaultSource;
    if (source.kind === "native") {
      if (source.provider.inventory.length === 0) throw new Error("native_inventory_unavailable");
      validateNativeVaultInventorySet(source.provider.inventory, server.paths.dataDir);
    }
    const stores =
      source.kind === "native"
        ? await openNativeHostStores(server.paths.dataDir, source.provider, lease, log, now)
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
    log.error("host.start-failed", { error: errorName(error) });
    await server.close();
    throw error;
  }
}

/** Writes the stable launcher `<data dir>/bin/cashu`; a failure is logged, never fatal. */
export function writeHostLauncher(dataDir: string, runtime: HostRuntime, log: HostLog): void {
  try {
    if (writeLauncher(dataDir, shimProgram(runtime))) log.info("host.launcher-written");
  } catch (error) {
    log.warn("host.launcher-failed", { error: errorName(error) });
  }
}
