// The local host's composition root: one per data dir, the only process that opens this device's
// stores. Started on demand by its first client (owner decision: no always-on service), it:
//   1. takes the machine lock and the socket (`startHost`, @cashu/node-host; a second host fails with
//      HostBusyError, exit 3) after admission (localHost/startup.ts),
//   2. records its start (crash-loop detection: after repeated crashes it runs in safe mode),
//   3. opens the stores under the writer lease (exclusive SQLite opens; damaged views recovered),
//   4. serves sessions by role: `ui` gets the store channel and the host RPCs (localHost/uiSession.ts),
//      `admin` gets status / stop / handover, `cli` the hosted command tree (cli/runner.ts,
//      localHost/commands.ts), `mcp` an MCP server for its profile (localHost/mcp.ts); writes the
//      stable launcher `<data dir>/bin/cashu` (launcher.ts),
//   5. lingers while idle (no session, no queued write) and then exits 0; exits 75 when its bundle
//      was replaced (handover); a signal or `admin.stop` exits 0 (localHost/lifecycle.ts).
// Everything is logged as codes and counts (log.ts). A clean exit clears the crash record.
import type { AdminStatus } from "@cashu/host-protocol";
import { classifyStartupError } from "@cashu/host-protocol/startup-failure";
import { type HostSession, type RunningHost, startHost } from "@cashu/node-host";
import { classifierSettingsQuery } from "@cashu/store/core/classifier-settings";
import { deviceListQuery } from "@cashu/store/core/desktop-settings";
import { NotificationQueue } from "@cashu/store/investments/local";
import type { ChangeSource } from "@cashu/store/query";
import type { SyncResult } from "@cashu/sync";
import { handleAdmin } from "./admin.js";
import { defaultProfileSlug } from "./cli/defaultProfile.js";
import { serveCliSession } from "./cli/runner.js";
import { connectorSettingsServed } from "./connectorSettings.js";
import { deviceListSource } from "./devices/listSource.js";
import { createDeviceService } from "./devices/service.js";
import { investmentsRunningQuery } from "./investmentsRunning.js";
import { pinnedLanguage } from "./language.js";
import type { WriterLease } from "./lease.js";
import { hostedCommands } from "./localHost/commands.js";
import { adminStatus, applySliced, syncVault } from "./localHost/handle.js";
import { createHostLifecycle, type ExitReason } from "./localHost/lifecycle.js";
import { marketAuthorities, startMarket } from "./localHost/market.js";
import { createMcpSessions } from "./localHost/mcp.js";
import { hostNotifications } from "./localHost/notificationRpc.js";
import type { LocalHostOptions } from "./localHost/options.js";
import { createScreenSurfaces } from "./localHost/screens.js";
import { admitStart, hostFeatures, openHostState, writeHostLauncher } from "./localHost/startup.js";
import { createUiSessions } from "./localHost/uiSession.js";
import { startHostWorker } from "./localHost/worker.js";
import { errorName, fileLog } from "./log.js";
import { ConnectorProposalReceipts } from "./mcp/connectorReceipt.js";
import { removeLegacyLanCarrier } from "./nativeVault/paths.js";
import { relayMemberUids, startMemberSweep } from "./pairing/members.js";
import { createPairingService, type PairingService } from "./pairing/service.js";
import { startStrategyFollower } from "./proposals/strategyFollow.js";
import { servedCommands } from "./registry.js";
import { createHostRelay, type HostRelay } from "./relay/service.js";
import { currentRuntime } from "./runtime.js";
import { settingsInfoQuery } from "./settingsInfo.js";
import { settingsWorkspaceStatus } from "./settingsScreen.js";
import type { HostStores } from "./stores.js";

export type { LocalHostOptions } from "./localHost/options.js";

const DEFAULT_LINGER_MS = 10 * 60 * 1000;

/** The services `startLocalHost` started so far; the lifecycle releases only these. */
interface StartedServices {
  market?: ReturnType<typeof startMarket>;
  devices?: ReturnType<typeof createDeviceService>;
  pairing?: PairingService;
  memberSweep?: ReturnType<typeof startMemberSweep>;
  notifications?: ReturnType<typeof hostNotifications>;
  worker?: ReturnType<typeof startHostWorker>;
  mcp?: ReturnType<typeof createMcpSessions>;
  strategyFollower?: ReturnType<typeof startStrategyFollower>;
  relay?: HostRelay;
}

export interface LocalHost {
  readonly server: RunningHost;
  /** Device pairing over the sync relay; absent in safe mode and on a synthetic harness. */
  readonly pairing?: PairingService;
  readonly lease: WriterLease;
  readonly stores: HostStores;
  readonly safeMode: boolean;
  /** What may run besides serving sessions: nothing in safe mode (rule 6 under crash loops). */
  readonly capabilities: { readonly jobs: boolean; readonly network: boolean };
  /** Resolves with the exit code once the host stopped (0 clean, 75 handover). */
  readonly exit: Promise<number>;
  status(): AdminStatus;
  /** Fires after the worker part of `status()` changed (its state, last tick, job runs). */
  readonly statusChanges: ChangeSource;
  /** Stops: refuses new sessions, drains the write queues, closes stores, releases the lock. */
  stop(reason?: ExitReason): Promise<number>;
  /**
   * Applies `envelopes` to a vault in slices (one transaction each) through its write queue, so
   * commands of other sessions run between slices. Resolves with the applied count.
   */
  applySliced(vault: string, envelopes: readonly unknown[], sliceEvents?: number): Promise<number>;
  /** Native-only authenticated inbound fold/push through the shared vault queue. */
  syncVault(vault: string): Promise<SyncResult>;
  /** The sync relay (unconfigured: `configured` false, every action refused). */
  readonly relay: HostRelay;
}

/** Starts the data dir's host. Throws `HostBusyError` when another host holds the lock. */
export async function startLocalHost(options: LocalHostOptions): Promise<LocalHost> {
  // Admission before the lock; the UI surfaces need no store yet.
  const admission = admitStart(options);
  const { vaultSource } = admission;
  const now = options.now ?? Date.now;
  const nativeMode = vaultSource.kind !== "synthetic-harness";
  const build = options.build ?? "dev";
  const screens = createScreenSurfaces({ options, nativeMode, now });

  // The lock and the socket, in the starting phase: hellos are refused as `starting` (clients wait
  // for this host) until the host is wired (`server.ready()` below). `dispatch` closes a session
  // only if one got through before that.
  let dispatch: (session: HostSession) => void = (session) => session.close();
  const server = await startHost({
    dataDir: options.dataDir,
    build,
    starting: true,
    features: hostFeatures({ options, vaultSource, nativeMode }),
    ...(options.pathEnv === undefined ? {} : { pathEnv: options.pathEnv }),
    onSession: (session) => dispatch(session),
  }).catch((error: unknown) => {
    screens.close();
    throw error;
  });
  const log = options.log ?? fileLog(server.paths.logPath);
  // The sync relay of a native host with a relay config; its remote joins the vaults that are switched
  // on for it on this device when they open below.
  const relay = createHostRelay({
    options: nativeMode ? options.relay : undefined,
    lock: server.lock,
    now,
    log,
  });

  // Under the lock: crash record, writer lease, creation service, stores (closed again, with the
  // server, when this step fails).
  const { record, lease, stores, creation, notificationIntents } = await openHostState({
    server,
    admission,
    nativeMode,
    log,
    now,
    relay,
  }).catch((error: unknown) => {
    screens.close();
    throw error;
  });
  const safeMode = record.safeMode;

  // Lifecycle first: the services below check it, and each registers in `started` as it starts, so
  // the idle check and `stop` see only services that exist. On stop they are released in this order,
  // then the stores drain and close, then the lock goes.
  const started: StartedServices = {};
  const lifecycle = createHostLifecycle({
    server,
    stores,
    record,
    log,
    build,
    dataDir: options.dataDir,
    pathEnv: options.pathEnv,
    lingerMs: options.lingerMs ?? DEFAULT_LINGER_MS,
    bundlePath: options.bundlePath,
    bundleCheckMs: options.bundleCheckMs,
    busy: () =>
      (started.pairing?.pending() ?? 0) > 0 ||
      (started.worker?.pending ?? 0) > 0 ||
      (creation?.pending() ?? 0) > 0 ||
      (started.devices?.pending() ?? 0) > 0 ||
      (started.relay?.pending() ?? 0) > 0,
    beforeIdleExit: (signal) => started.relay?.finalPush({ signal }) ?? Promise.resolve(),
    release: async (reason) => {
      // Pairing first: its open relay sessions are deleted with the relay client still up.
      started.memberSweep?.close();
      await started.pairing?.close();
      started.relay?.close();
      await started.mcp?.stop(reason);
      started.strategyFollower?.close();
      await started.strategyFollower?.settled();
      await started.worker?.stop();
      started.notifications?.capability?.dispose();
      started.devices?.close();
      await Promise.allSettled([...lifecycle.inFlightRequests]);
      await creation?.drain();
      screens.close();
      started.market?.close();
    },
  });
  try {
    return await serveHost();
  } catch (error) {
    // A start that fails after the stores opened (a LAN resume may already have armed the idle
    // timer) releases what started, closes the stores and the server, and keeps the crash record.
    const failure = classifyStartupError(error);
    log.error("host.start-failed", {
      error: errorName(error),
      code: failure.code,
      detail: failure.detail ?? null,
    });
    // The start error is what the caller reports; a cleanup failure is only logged.
    await lifecycle.abortStart().catch((cleanup: unknown) => {
      log.warn("host.start-abort-failed", { error: errorName(cleanup) });
    });
    throw error;
  }

  async function serveHost(): Promise<LocalHost> {
    screens.attach(stores);
    const market = startMarket({ options, nativeMode, server, stores, record, now });
    started.market = market;
    const authorities = marketAuthorities(options, market);
    const investmentSources = screens.investmentSources(market?.market);
    const signalQueue = new NotificationQueue(stores.device.driver);
    const signalActions = screens.signalActions({
      stores,
      queue: signalQueue,
      prices: authorities.prices,
    });
    const runtime = options.runtime ?? currentRuntime();
    const workerBound = !nativeMode || options.worker !== undefined;
    const capabilities = { jobs: !safeMode && workerBound, network: !safeMode && workerBound };
    if (options.launcher ?? true) writeHostLauncher(server.paths.dataDir, runtime, log);
    log.info("host.started", {
      pid: process.pid,
      build,
      vaults: stores.vaults.size,
      recovered: stores.recovered,
      safeMode,
      recentCrashes: record.recentCrashes,
    });
    if (safeMode) log.warn("host.safe-mode", { recentCrashes: record.recentCrashes });

    if (nativeMode) {
      // The LAN carrier's folder of older builds (a copy of each vault's own sealed log) goes once.
      try {
        if (removeLegacyLanCarrier(server.paths.dataDir) === "removed")
          log.info("host.lan-carrier-removed", {});
      } catch (error) {
        log.warn("host.lan-carrier-unremoved", { error: errorName(error) });
      }
    }
    const devices = createDeviceService(stores, now);
    started.devices = devices;
    // Safe mode runs no network work: no relay passes (the switch and status still answer).
    started.relay = relay;
    if (!safeMode) relay.start({ stores, closing: lifecycle.closing });
    // Pairing and the membership of revoked devices go through the relay: no network in safe mode.
    const memberUids = relayMemberUids(() => stores);
    const pairingWarn = (event: string, error: unknown) =>
      log.warn(event, { error: errorName(error) });
    const pairing =
      nativeMode && !safeMode
        ? createPairingService({
            vault: (id) => stores.vaults.get(id)?.native,
            relay,
            now,
            warn: pairingWarn,
          })
        : undefined;
    started.pairing = pairing;
    if (nativeMode && !safeMode && relay.configured)
      started.memberSweep = startMemberSweep({
        stores,
        relay,
        memberUids,
        now,
        warn: pairingWarn,
      });
    const notifications = hostNotifications({
      intents: notificationIntents,
      stores,
      lock: server.lock,
      closing: lifecycle.closing,
    });
    started.notifications = notifications;
    const worker = startHostWorker({
      factory: options.worker,
      server,
      stores,
      now,
      capabilities,
      stopRequested: lifecycle.stopRequested,
      bundleReplaced: lifecycle.bundleReplaced,
      notifications: notifications.capability,
      queue: signalQueue,
      log,
    });
    started.worker = worker;
    // Each device's strategy files follow the recorded version (after every sync pass).
    if (nativeMode && !safeMode && options.strategyLock !== undefined)
      started.strategyFollower = startStrategyFollower({
        stores,
        dailyLock: options.strategyLock,
        onError: (_vault, error) => log.warn("strategy.follow-failed", { error: errorName(error) }),
      });
    const connectorReceipts =
      nativeMode && options.connectorCatalog !== undefined
        ? new ConnectorProposalReceipts(server.paths.dataDir)
        : undefined;
    const ported = hostedCommands({
      options,
      nativeMode,
      runtime,
      now,
      server,
      stores,
      creation,
      market: authorities,
      investmentSources,
      performance: screens.performance,
      strategies: screens.strategies,
      worker,
      bundleReplaced: lifecycle.bundleReplaced,
      onCreationReady: lifecycle.handoverSoon,
    });
    const mcp = createMcpSessions({
      options,
      nativeMode,
      server,
      stores,
      runtime,
      market: authorities,
      connectorReceipts,
      bundleReplaced: lifecycle.bundleReplaced,
      now,
      log,
    });
    started.mcp = mcp;
    lifecycle.watchBundle();
    const serveUi = createUiSessions({
      rpc: {
        nativeMode,
        server,
        stores,
        now,
        log,
        connectorCatalog: options.connectorCatalog,
        banking: options.banking,
        creation,
        devices,
        pairing,
        relay,
        notificationIntents,
        notificationAuthority: notifications.authority,
        inFlightRequests: lifecycle.inFlightRequests,
        armIdle: lifecycle.armIdle,
        closing: lifecycle.closing,
        bundleReplaced: lifecycle.bundleReplaced,
        handover: () => void lifecycle.stop("handover"),
        handoverSoon: lifecycle.handoverSoon,
      },
      channel: {
        queries: screens.queries({
          market,
          prices: authorities.prices,
          sources: investmentSources,
          settingsInfo: settingsInfoQuery({
            version: build,
            changes: worker.changes,
            dataDir: () => server.paths.dataDir,
            worker: () => worker.status(),
            stores: () => stores,
          }),
          running: investmentsRunningQuery({
            changes: worker.runningChanges,
            running: (vault) => worker.running(vault),
          }),
          ...(options.classifierSettings === undefined
            ? {}
            : { classifierSettings: classifierSettingsQuery(options.classifierSettings) }),
          ...(nativeMode ? { deviceList: deviceListQuery(deviceListSource(() => stores)) } : {}),
          ...(options.workspace === undefined
            ? {}
            : {
                workspaceStatus: settingsWorkspaceStatus({
                  provider: options.workspace,
                  stores: () => stores,
                }),
              }),
          connectorSettings: connectorSettingsServed({
            catalog: () => (nativeMode ? options.connectorCatalog?.() : undefined),
            shows: (vault) => stores.vaults.get(vault)?.mode === "native",
          }),
        }),
        commands: servedCommands({ strategy: investmentSources.strategy }),
        actions: screens.uiActions(signalActions),
        prepareQuery: screens.prepareQuery,
        privateQuery: screens.privateQuery,
        ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
        ...(options.afterCommit === undefined ? {} : { afterCommit: options.afterCommit }),
      },
    });

    const status = () => adminStatus({ server, build, safeMode, stores, worker });
    dispatch = (session) => {
      lifecycle.admit(session);
      switch (session.role) {
        case "ui":
          serveUi(session);
          return;
        case "admin":
          handleAdmin(session, { status, stop: lifecycle.stop, log });
          return;
        case "cli":
          serveCliSession(session, {
            dataDir: server.paths.dataDir,
            ported,
            defaultProfile: () => defaultProfileSlug(stores),
            log,
            pinned: () => pinnedLanguage(stores),
          });
          return;
        case "mcp":
          mcp.serve(session);
          return;
      }
    };
    server.ready();
    lifecycle.armIdle();
    return {
      server,
      ...(pairing === undefined ? {} : { pairing }),
      lease,
      stores,
      safeMode,
      capabilities,
      exit: lifecycle.exit,
      status,
      statusChanges: worker.changes,
      stop: lifecycle.stop,
      applySliced: (vaultId, envelopes, sliceEvents) =>
        applySliced(stores, vaultId, envelopes, sliceEvents),
      syncVault: (vaultId) => syncVault(stores, vaultId),
      relay,
    };
  }
}
