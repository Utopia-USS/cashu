// Entry point of a native vault session. Opening, recovery and wiring live here; each capability of
// the session is built in ./nativeVault/ from one shared NativeVaultContext.
import { join } from "node:path";
import { StartupFailureError } from "@cashu/host-protocol/startup-failure";
import { NodeFolderFs } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  metaClockStore,
  metaGateStateStore,
  mintUlid,
  type SqlDriver,
  Store,
  vaultSalt,
} from "@cashu/store";
import {
  assertReplayedDeviceAuthority,
  metaClockGuardStore,
  SqlProvenanceStore,
} from "@cashu/store/sync";
import {
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  FolderTransport,
  type PullHistory,
  type SyncEngine,
} from "@cashu/sync";
import { SqlAttemptJournal } from "./attemptJournal.js";
import { leaseAttempts } from "./devices/leaseAttempts.js";
import type { WriterLease } from "./lease.js";
import { scrubIncompleteNativeCheckpoints } from "./nativeCheckpoint.js";
import { sessionBindings } from "./nativeVault/bindings.js";
import { type NativeVaultContext, profileGid } from "./nativeVault/context.js";
import { deviceReads } from "./nativeVault/deviceReads.js";
import { warnCause } from "./nativeVault/diagnostics.js";
import { fetchAuthorityRefresh } from "./nativeVault/fetchAuthority.js";
import { sessionGuards } from "./nativeVault/guards.js";
import { pairingPruner, pairingWrites, reconcilePendingPairings } from "./nativeVault/pairing.js";
import { existing, sidecars } from "./nativeVault/paths.js";
import { reconcileAttemptHistory } from "./nativeVault/recovery.js";
import { revocation } from "./nativeVault/revocation.js";
import { REVOKE_COMMAND } from "./nativeVault/revokeIntent.js";
import { syncControl } from "./nativeVault/sync.js";
import type { NativeVaultSession, NativeVaultSource } from "./nativeVault/types.js";
import { PairingJournal } from "./pairing/journal.js";
import { WriteQueue } from "./queue.js";
import {
  loadDeviceAuthority,
  type NativeVaultInventoryEntry,
} from "./sync/keys/deviceAuthority.js";

export type {
  NativeDeviceRevokeDraft,
  NativeVaultSession,
  NativeVaultSource,
} from "./nativeVault/types.js";

/**
 * Opens only an already provisioned native vault. No directory or key is created here. Both the
 * private metadata DB and view must exist; a corrupt view is preserved for a later verified rebuild.
 */
export async function openNativeVault(
  entry: NativeVaultInventoryEntry,
  dataDir: string,
  source: NativeVaultSource,
  lease: WriterLease,
  now: () => number,
): Promise<NativeVaultSession> {
  lease.assertHeld();
  const root = entry.vaultRoot;
  const privatePath = existing(join(root, "private.db"), "file");
  const viewPath = existing(join(root, "view.db"), "file");
  const logPath = existing(join(root, "log"), "directory");
  sidecars(privatePath);
  sidecars(viewPath);
  // A read-only open refuses a missing or unreadable file without SQLite creating an empty one.
  const probe = openNodeSqlite(privatePath, { readOnly: true });
  try {
    const hasProvenance = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vault_key_provenance'")
      .get();
    const hasAttempts = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='host_attempts'")
      .get();
    if (!hasProvenance || !hasAttempts)
      throw new StartupFailureError("native_inventory_unavailable", "native_metadata_unavailable");
  } finally {
    probe.close();
  }
  // Load the exact ring once to bind the provenance table before VaultDevices construction.
  // A key store refusal keeps its typed code (keystore_corrupt / keystore_unavailable), which the
  // start-up failure classifier maps to vault_key_unavailable.
  const ring = await crypto.loadKeyring(source.keyStore, source.sodium, entry.vaultId);
  if (ring === null)
    throw new StartupFailureError("vault_key_unavailable", "native_authority_unavailable");
  let meta: SqlDriver | undefined;
  let candidate: Awaited<ReturnType<typeof loadDeviceAuthority>> | undefined;
  let viewDriver: SqlDriver | undefined;
  let store: Store | undefined;
  let engine: SyncEngine | undefined;
  const writeListeners = new Set<() => void>();
  try {
    meta = openNodeSqlite(privatePath, { exclusive: lease.lock() });
    // Attempt intent and key provenance must survive power loss before encrypted append begins.
    meta.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    const provenance = SqlProvenanceStore.open(meta, ring, "existing");
    const attempts = SqlAttemptJournal.open(meta, "existing", now);
    const pairingJournal = new PairingJournal(meta);
    const certificates = await source.bootstrapCertificates(entry);
    candidate = await loadDeviceAuthority({
      entry,
      dataDir,
      keyStore: source.keyStore,
      sodium: source.sodium,
      provenance,
      clock: now,
      bootstrapCertificates: certificates,
    });
    const saltKey = candidate.ring.gidSalt();
    const salt = vaultSalt(saltKey.expose().slice());
    saltKey.wipe();
    viewDriver = openNodeSqlite(viewPath, { exclusive: lease.lock() });
    try {
      // Opening runs a pending view upgrade (rebuild) in one transaction that rolls back on failure.
      store = Store.open({
        driver: viewDriver,
        vault: entry.vaultId,
        salt,
        modules: builtinModules(),
      });
    } catch {
      throw new StartupFailureError("view_rebuild_failed", "view_rebuild_failed");
    }
    const localTransport = new FolderTransport({ fs: new NodeFolderFs(logPath) });
    engine = notifyingWrites(
      await createSyncEngine({
        vault: entry.vaultId,
        device: entry.deviceId,
        local: localTransport,
        // None while the vault's sync is off: the engine then reports its pull `offline` (no remote).
        remotes: source.remoteTransports?.(entry) ?? [],
        codec: createOwnLogCodec({
          sodium: source.sodium,
          ring: candidate.ring,
          signer: candidate.identity,
        }),
        gate: candidate.gate,
        sink: store.sink(),
        clockStore: metaClockStore(store.driver, entry.deviceId),
        clockGuard: metaClockGuardStore(store.driver, entry.deviceId),
        physicalClock: { now },
        gateState: metaGateStateStore(store.driver, entry.deviceId),
        gossipEid: () => mintUlid(now()),
        ...pullHistoryOf(source, entry),
        ...(source.maxPushBytesPerPass === undefined
          ? {}
          : { maxPushBytesPerPass: source.maxPushBytesPerPass }),
      }),
      () => {
        for (const listener of [...writeListeners]) {
          try {
            listener();
          } catch (error) {
            // A write trigger (the relay push) cannot change what was committed.
            warnCause("native_write_listener_failed", error);
          }
        }
      },
    );
    const recovered = await engine.recoverLocal();
    await reconcilePendingPairings({ entry, engine, pairingJournal, now });
    assertReplayedDeviceAuthority(candidate, recovered, profileGid(store));
    if (candidate.devices.rotationNeeded() !== undefined)
      throw new StartupFailureError("unknown", "device_rotation_required");
    const queue = new WriteQueue(() => lease.assertHeld());
    // Created here: the pruner reads the clock once, after the queue and before attempt recovery.
    const prunePairing = pairingPruner(pairingJournal, entry.vaultId, now);
    const context: NativeVaultContext = {
      entry,
      dataDir,
      root,
      source,
      lease,
      now,
      meta,
      store,
      engine,
      candidate,
      attempts,
      provenance,
      pairingJournal,
      localTransport,
      certificates,
      queue,
      state: { current: true, syncing: false, activeFetches: 0 },
    };
    const { state } = context;
    const guards = sessionGuards(context);
    await reconcileAttemptHistory(context);
    // Authenticated local recovery may have merged wraps into the ring. Persist before exposure.
    await crypto.saveKeyring(source.keyStore, candidate.ring);
    attempts.pruneReceipts();
    pairingJournal.pruneReceipts(entry.vaultId, now());
    pairingJournal.pruneInvites(entry.vaultId, now());
    const activeEngine = engine;
    const activeCandidate = candidate;
    const leaseReports = leaseAttempts({
      vault: entry.vaultId,
      identity: activeCandidate.identity,
      store,
      engine: activeEngine,
      authority: activeCandidate.devices,
      attempts,
      queue,
      now,
      current: guards.isCurrent,
      canFetch: guards.canFetchPublicMarket,
      canPin: () =>
        state.current &&
        lease.held &&
        activeEngine.writeAdmission() === "ready" &&
        !attempts.hasPending(entry.vaultId, REVOKE_COMMAND) &&
        pairingJournal.pending(entry.vaultId).length === 0 &&
        (state.syncing || guards.canRunSideEffects()),
      canPinTarget: (leader, force) =>
        force ||
        leader === entry.deviceId ||
        activeCandidate.devices.lease.holder !== entry.deviceId ||
        (state.activeFetches === 0 && guards.canFetchPublicMarket()),
    });
    await leaseReports.reconcilePending();
    scrubIncompleteNativeCheckpoints(root);
    const bindings = sessionBindings(context, guards);
    const syncOps = syncControl(context, guards, leaseReports);
    const fetchPull = fetchAuthorityRefresh(context, guards, syncOps);
    const deviceOps = deviceReads(context, guards);
    const revoke = revocation(context, guards);
    const pairing = pairingWrites(context, guards, prunePairing);
    // An admission whose membership exists owes its append: retried before the session is exposed.
    await pairing.pairingResume();
    const deviceListeners = new Set<() => void>();
    const devicesChanged = () => {
      for (const listener of [...deviceListeners]) {
        try {
          listener();
        } catch (error) {
          // One subscriber cannot change device authority.
          warnCause("native_devices_listener_failed", error);
        }
      }
    };
    syncOps.onSyncSettled(devicesChanged);
    const thenDevicesChanged =
      <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
      (...args: A): Promise<R> =>
        run(...args).finally(devicesChanged);
    return {
      id: entry.vaultId,
      store,
      engine: activeEngine,
      attempts,
      queue,
      device: entry.deviceId,
      epoch: {},
      isCurrent: guards.isCurrent,
      workspaceAuthority: bindings.workspaceAuthority,
      canRunSideEffects: guards.canRunSideEffects,
      createMergeCheckpoint: bindings.createMergeCheckpoint,
      checkpointDirectory: bindings.checkpointDirectory,
      strategyDirectoryAuthority: bindings.strategyDirectoryAuthority,
      canFetchPublicMarket: guards.canFetchPublicMarket,
      refreshFetchAuthority: fetchPull.refreshFetchAuthority,
      mayObtainFetchAuthority: fetchPull.mayObtainFetchAuthority,
      fetchAuthorityIssue: fetchPull.fetchAuthorityIssue,
      beginFetch: bindings.beginFetch,
      recordFetch: () => leaseReports.recordFetched(),
      blobPublication: bindings.blobPublication,
      isSyncing: syncOps.isSyncing,
      onSyncSettled: syncOps.onSyncSettled,
      onDevicesChanged(listener) {
        deviceListeners.add(listener);
        return () => deviceListeners.delete(listener);
      },
      onLocalWrite(listener) {
        writeListeners.add(listener);
        return () => writeListeners.delete(listener);
      },
      sync: syncOps.sync,
      deviceList: deviceOps.deviceList,
      devicePreview: revoke.devicePreview,
      deviceCommit: thenDevicesChanged(revoke.deviceCommit),
      deviceInspect: thenDevicesChanged(revoke.deviceInspect),
      leaderPrepare: deviceOps.leaderPrepare,
      leaderCommit: thenDevicesChanged((leader, force, confirmationText, head, operationId) =>
        leaseReports.pin(leader, force, confirmationText, head, operationId),
      ),
      leaderInspect: thenDevicesChanged((operationId) =>
        leaseReports.inspect("native.devices.leaderPin", operationId),
      ),
      pairingStart: pairing.pairingStart,
      pairingRegisterInvite: pairing.pairingRegisterInvite,
      pairingBindJoiner: pairing.pairingBindJoiner,
      pairingAdmit: thenDevicesChanged(pairing.pairingAdmit),
      pairingOperation: pairing.pairingOperation,
      pairingAdmissions: pairing.pairingAdmissions,
      pairingResolve: thenDevicesChanged(pairing.pairingResolve),
      pairingResume: thenDevicesChanged(pairing.pairingResume),
      invalidate() {
        state.current = false;
        bindings.closeBlobPublication();
        queue.close();
        syncOps.notifySyncSettled();
      },
      async close() {
        state.current = false;
        bindings.closeBlobPublication();
        queue.close();
        await queue.idle();
        await activeEngine.close();
        context.store.close();
        activeCandidate.close();
        context.meta.close();
      },
    };
  } catch (error) {
    await engine?.close();
    store?.close();
    if (store === undefined) viewDriver?.close();
    candidate?.close();
    meta?.close();
    throw error;
  } finally {
    ring.wipe();
  }
}

/** The persisted sync history as an engine option; a failing reader only loses the history. */
function pullHistoryOf(
  source: NativeVaultSource,
  entry: NativeVaultInventoryEntry,
): { pullHistory?: PullHistory } {
  try {
    const history = source.pullHistory?.(entry);
    return history === undefined ? {} : { pullHistory: history };
  } catch (error) {
    warnCause("native_pull_history_unavailable", error);
    return {};
  }
}

/**
 * The engine with a notification after every committed local append (commands, pairing, revocation,
 * lease reports): the relay pushes shortly after own writes. A write that throws is not reported; the
 * next pass carries whatever reached the local log. `write` stays replaceable (fault-injection tests
 * wrap it): a replacement is kept beside the engine, so wrapping the notifying write never loops.
 */
function notifyingWrites(engine: SyncEngine, written: () => void): SyncEngine {
  const raw = engine.write.bind(engine);
  let write: SyncEngine["write"] = async (...args) => {
    const result = await raw(...args);
    written();
    return result;
  };
  return new Proxy(engine, {
    get(target, property) {
      if (property === "write") return write;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property !== "write") return Reflect.set(target, property, value, target);
      write = value;
      return true;
    },
    defineProperty(target, property, descriptor) {
      if (property !== "write") return Reflect.defineProperty(target, property, descriptor);
      if (typeof descriptor.value !== "function") return false;
      write = descriptor.value;
      return true;
    },
    getOwnPropertyDescriptor(target, property) {
      if (property !== "write") return Reflect.getOwnPropertyDescriptor(target, property);
      return { value: write, writable: true, enumerable: false, configurable: true };
    },
  });
}
