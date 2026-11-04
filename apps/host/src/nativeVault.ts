// Entry point of a native vault session. Opening, recovery and wiring live here; each capability of
// the session is built in ./nativeVault/ from one shared NativeVaultContext.
import { join } from "node:path";
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
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  FolderTransport,
  type SyncEngine,
} from "@cashu/sync";
import { SqlAttemptJournal } from "./attemptJournal.js";
import { leaseAttempts } from "./devices/leaseAttempts.js";
import type { WriterLease } from "./lease.js";
import { nativeClockGuard } from "./market/clockGuard.js";
import { scrubIncompleteNativeCheckpoints } from "./nativeCheckpoint.js";
import { sessionBindings } from "./nativeVault/bindings.js";
import { carrierEndpoint } from "./nativeVault/carrier.js";
import { type NativeVaultContext, profileGid } from "./nativeVault/context.js";
import { deviceReads } from "./nativeVault/deviceReads.js";
import { sessionGuards } from "./nativeVault/guards.js";
import { ensureOwnLanMirror, reconcilePendingPairings } from "./nativeVault/lanMirror.js";
import { pairingPruner, pairingWrites } from "./nativeVault/pairing.js";
import { existing, lanCarrierRoot, sidecars } from "./nativeVault/paths.js";
import { reconcileAttemptHistory } from "./nativeVault/recovery.js";
import { revocation } from "./nativeVault/revocation.js";
import { REVOKE_COMMAND } from "./nativeVault/revokeIntent.js";
import { syncControl } from "./nativeVault/sync.js";
import type { NativeVaultSession, NativeVaultSource } from "./nativeVault/types.js";
import { HostLanCarrier } from "./pairing/carrier.js";
import { PairingJournal } from "./pairing/journal.js";
import { pairingReadCapability } from "./pairing/readCapability.js";
import { WriteQueue } from "./queue.js";
import {
  assertReplayedDeviceAuthority,
  loadDeviceAuthority,
  type NativeVaultInventoryEntry,
} from "./sync/keys/deviceAuthority.js";
import { SqlProvenanceStore } from "./sync/keys/sqlProvenance.js";

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
    if (!hasProvenance || !hasAttempts) throw new Error("native_metadata_unavailable");
  } finally {
    probe.close();
  }
  // Load the exact ring once to bind the provenance table before VaultDevices construction.
  const ring = await crypto.loadKeyring(source.keyStore, source.sodium, entry.vaultId);
  if (ring === null) throw new Error("native_authority_unavailable");
  let meta: SqlDriver | undefined;
  let candidate: Awaited<ReturnType<typeof loadDeviceAuthority>> | undefined;
  let viewDriver: SqlDriver | undefined;
  let store: Store | undefined;
  let engine: SyncEngine | undefined;
  try {
    meta = openNodeSqlite(privatePath, { exclusive: lease.lock() });
    // Attempt intent and key provenance must survive power loss before encrypted append begins.
    meta.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    const provenance = SqlProvenanceStore.open(meta, ring, "existing");
    const attempts = SqlAttemptJournal.open(meta, "existing", now);
    const pairingJournal = new PairingJournal(meta);
    const carrierRoot = lanCarrierRoot(dataDir);
    const lanCarrier = new HostLanCarrier(carrierRoot);
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
    store = Store.open({
      driver: viewDriver,
      vault: entry.vaultId,
      salt,
      modules: builtinModules(),
    });
    const localTransport = new FolderTransport({ fs: new NodeFolderFs(logPath) });
    const lanRemote = new FolderTransport({
      fs: new NodeFolderFs(carrierRoot),
      owner: entry.deviceId,
    });
    engine = await createSyncEngine({
      vault: entry.vaultId,
      device: entry.deviceId,
      local: localTransport,
      remotes: [lanRemote, ...(source.remoteTransports?.(entry) ?? [])],
      codec: createOwnLogCodec({
        sodium: source.sodium,
        ring: candidate.ring,
        signer: candidate.identity,
      }),
      gate: candidate.gate,
      sink: store.sink(),
      clockStore: metaClockStore(store.driver, entry.deviceId),
      clockGuard: nativeClockGuard(store.driver, entry.deviceId),
      physicalClock: { now },
      gateState: metaGateStateStore(store.driver, entry.deviceId),
      gossipEid: () => mintUlid(now()),
    });
    const recovered = await engine.recoverLocal();
    await reconcilePendingPairings({
      entry,
      engine,
      localTransport,
      lanCarrier,
      pairingJournal,
      now,
    });
    assertReplayedDeviceAuthority(candidate, recovered, profileGid(store));
    if (candidate.devices.rotationNeeded() !== undefined)
      throw new Error("device_rotation_required");
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
      lanCarrier,
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
    const deviceOps = deviceReads(context, guards);
    const revoke = revocation(context, guards);
    const pairing = pairingWrites(context, guards, prunePairing);
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
      beginFetch: bindings.beginFetch,
      recordFetch: () => leaseReports.recordFetched(),
      blobPublication: bindings.blobPublication,
      isSyncing: syncOps.isSyncing,
      onSyncSettled: syncOps.onSyncSettled,
      sync: syncOps.sync,
      deviceList: deviceOps.deviceList,
      devicePreview: revoke.devicePreview,
      deviceCommit: revoke.deviceCommit,
      deviceInspect: revoke.deviceInspect,
      leaderPrepare: deviceOps.leaderPrepare,
      leaderCommit: (leader, force, confirmationText, head, operationId) =>
        leaseReports.pin(leader, force, confirmationText, head, operationId),
      leaderInspect: (operationId) => leaseReports.inspect("native.devices.leaderPin", operationId),
      pairingStart: pairing.pairingStart,
      pairingRegisterInvite: pairing.pairingRegisterInvite,
      pairingBindJoiner: pairing.pairingBindJoiner,
      pairingAppend: pairing.pairingAppend,
      ...pairingReadCapability({
        vault: entry.vaultId,
        journal: pairingJournal,
        engine: activeEngine,
        queue,
        registry: () => activeCandidate.devices.registry,
        isCurrent: guards.isCurrent,
        prune: prunePairing,
        mirrorOwnBatch: () => ensureOwnLanMirror(context),
        now,
      }),
      carrierRequest: carrierEndpoint(context, guards, prunePairing),
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
