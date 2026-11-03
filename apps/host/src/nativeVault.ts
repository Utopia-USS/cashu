import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { NodeFolderFs } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  metaClockStore,
  metaGateStateStore,
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
  type SyncResult,
  type Transport,
} from "@cashu/sync";
import { SqlAttemptJournal } from "./attemptJournal.js";
import type { WriterLease } from "./lease.js";
import { WriteQueue } from "./queue.js";
import {
  assertReplayedDeviceAuthority,
  loadDeviceAuthority,
  type NativeVaultInventoryEntry,
} from "./sync/keys/deviceAuthority.js";
import { SqlProvenanceStore } from "./sync/keys/sqlProvenance.js";

export interface NativeVaultSource {
  /** Candidate locators from the host-owned inventory, globally checked before opening. */
  readonly inventory: readonly NativeVaultInventoryEntry[];
  /** Exact namespace and data-dir bound provider. T44 supplies the production factory. */
  readonly keyStore: crypto.KeyStore;
  readonly sodium: crypto.Sodium;
  /** Authenticated creation/pairing certificate artifacts for this exact vault. */
  bootstrapCertificates(entry: NativeVaultInventoryEntry): Promise<readonly Uint8Array[]>;
  /** Explicit bound, manifest-gated carrier transports. Absence is offline local-only operation. */
  remoteTransports?(entry: NativeVaultInventoryEntry): readonly Transport[];
}

export interface NativeVaultSession {
  readonly id: string;
  readonly store: Store;
  readonly engine: SyncEngine;
  readonly attempts: SqlAttemptJournal;
  readonly queue: WriteQueue;
  readonly device: string;
  readonly epoch: object;
  isCurrent(): boolean;
  isSyncing(): boolean;
  onSyncSettled(listener: () => void): () => void;
  /** Serialize inbound fold and push with UI commands on this vault. */
  sync(): Promise<SyncResult>;
  invalidate(): void;
  close(): Promise<void>;
}

function existing(path: string, kind: "file" | "directory"): string {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("native_vault_unavailable");
    throw new Error("native_path_invalid");
  }
  if (
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (kind === "file" ? !stat.isFile() : !stat.isDirectory())
  )
    throw new Error("native_path_invalid");
  return path;
}

function sidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${path}${suffix}`;
    try {
      lstatSync(sidecar);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("native_path_invalid");
    }
    existing(sidecar, "file");
  }
}

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
  if (entry.legacyBridge !== undefined) throw new Error("legacy_bridge_unbound");
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
    candidate = await loadDeviceAuthority({
      entry,
      dataDir,
      keyStore: source.keyStore,
      sodium: source.sodium,
      provenance,
      clock: now,
      bootstrapCertificates: await source.bootstrapCertificates(entry),
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
    engine = await createSyncEngine({
      vault: entry.vaultId,
      device: entry.deviceId,
      local: new FolderTransport({ fs: new NodeFolderFs(logPath) }),
      remotes: source.remoteTransports?.(entry) ?? [],
      codec: createOwnLogCodec({
        sodium: source.sodium,
        ring: candidate.ring,
        signer: candidate.identity,
      }),
      gate: candidate.gate,
      sink: store.sink(),
      clockStore: metaClockStore(store.driver, entry.deviceId),
      gateState: metaGateStateStore(store.driver, entry.deviceId),
    });
    const recovered = await engine.recoverLocal();
    const profile = store.read<{ gid: string }>("SELECT gid FROM profiles");
    assertReplayedDeviceAuthority(
      candidate,
      recovered,
      profile.length === 1 ? profile[0]?.gid : undefined,
    );
    if (candidate.devices.rotationNeeded() !== undefined)
      throw new Error("device_rotation_required");
    const queue = new WriteQueue(() => lease.assertHeld());
    const epoch = {};
    let current = true;
    let syncing = false;
    const syncListeners = new Set<() => void>();
    const notifySyncSettled = () => {
      for (const listener of [...syncListeners]) {
        try {
          listener();
        } catch {
          /* One subscriber cannot change sync authority. */
        }
      }
    };
    const activeStore = store;
    const activeEngine = engine;
    const activeCandidate = candidate;
    const activeMeta = meta;
    const isCurrent = () => {
      if (!current || syncing || !lease.held) return false;
      try {
        const rows = activeStore.read<{ gid: string }>("SELECT gid FROM profiles");
        assertReplayedDeviceAuthority(
          activeCandidate,
          { complete: true, requiresViewRebuild: false, rolledBack: false },
          rows.length === 1 ? rows[0]?.gid : undefined,
        );
        // A revocation or recovery cut requires the device rotation protocol before another write.
        if (activeCandidate.devices.rotationNeeded() !== undefined) return false;
        return true;
      } catch {
        return false;
      }
    };
    // The original EIDs of confirmed attempts must remain in recovered authenticated history.
    // An EID alone never promotes an unknown attempt to semantic success.
    const completed = meta
      .prepare("SELECT eids FROM host_attempts WHERE phase='completed'")
      .all<{ eids: string }>();
    for (const row of completed) {
      const eids: unknown = JSON.parse(row.eids);
      if (!Array.isArray(eids) || !eids.every((eid) => typeof eid === "string"))
        throw new Error("corrupt_attempt");
      if (activeStore.eventHlcs(eids).size !== eids.length) throw new Error("incomplete_history");
    }
    // Authenticated local recovery may have merged wraps into the ring. Persist before exposure.
    await crypto.saveKeyring(source.keyStore, activeCandidate.ring);
    attempts.pruneReceipts();
    return {
      id: entry.vaultId,
      store: activeStore,
      engine: activeEngine,
      attempts,
      queue,
      device: entry.deviceId,
      epoch,
      isCurrent,
      isSyncing: () => syncing,
      onSyncSettled(listener) {
        syncListeners.add(listener);
        return () => syncListeners.delete(listener);
      },
      sync: () =>
        queue.run(async () => {
          if (!isCurrent()) throw new Error("native_session_unavailable");
          syncing = true;
          try {
            const result = await activeEngine.sync();
            const recovery = await activeEngine.recoverLocal();
            const rows = activeStore.read<{ gid: string }>("SELECT gid FROM profiles");
            assertReplayedDeviceAuthority(
              activeCandidate,
              recovery,
              rows.length === 1 ? rows[0]?.gid : undefined,
            );
            if (result.rolledBack || activeCandidate.devices.rotationNeeded() !== undefined)
              throw new Error("native_authority_changed");
            // The gate may have accepted a new wrapped generation during this sync.
            await crypto.saveKeyring(source.keyStore, activeCandidate.ring);
            syncing = false;
            if (!isCurrent()) throw new Error("native_authority_changed");
            notifySyncSettled();
            return result;
          } catch {
            current = false;
            syncing = false;
            notifySyncSettled();
            throw new Error("native_sync_unavailable");
          }
        }),
      invalidate() {
        current = false;
        queue.close();
        notifySyncSettled();
      },
      async close() {
        current = false;
        queue.close();
        await queue.idle();
        await activeEngine.close();
        activeStore.close();
        activeCandidate.close();
        activeMeta.close();
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
