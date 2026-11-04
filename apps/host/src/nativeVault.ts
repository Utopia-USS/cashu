import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type {
  DeviceListResult,
  RevokeCommitResult,
  RevokeInspectResult,
} from "@cashu/host-protocol";
import {
  decodeLanDescriptor,
  LAN_CARRIER_PATH,
  type LanCarrierReply,
  type LanCarrierRequest,
  lanAuthBody,
  lanBytesDigest,
} from "@cashu/host-protocol/pairing-lan";
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
  devices,
  FolderTransport,
  ownBatchDigest,
  type SyncEngine,
  type SyncResult,
  type Transport,
  type UnstampedEvent,
} from "@cashu/sync";
import { SqlAttemptJournal } from "./attemptJournal.js";
import type { WriterLease } from "./lease.js";
import { NativeBlobPublication } from "./nativeBlobs.js";
import { HostLanCarrier } from "./pairing/carrier.js";
import { type PairingAttempt, PairingJournal } from "./pairing/journal.js";
import type { StrategyDirectoryAuthority } from "./proposals/strategyFiles.js";
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

export interface NativeDeviceRevokeDraft {
  readonly vault: string;
  readonly targets: readonly string[];
  readonly recertify: readonly string[];
  readonly operationId: string;
  readonly eids: { readonly revoke: string; readonly rotate: string };
  readonly fingerprint?: string;
}

type NativeDevicePreviewResult =
  | {
      readonly kind: "prepared";
      readonly fingerprint: string;
      readonly targets: readonly {
        readonly device: string;
        readonly cut: { readonly seg: number; readonly offset: number };
        readonly head: "trusted" | "local_start";
      }[];
      readonly affected: readonly {
        readonly device: string;
        readonly name: string;
        readonly selected: boolean;
      }[];
      readonly localStartConfirmationRequired: boolean;
    }
  | {
      readonly kind: "refused";
      readonly code:
        | "unsafe_target"
        | "retirement_unavailable"
        | "integrity_failure"
        | "outcome_unknown"
        | "unavailable";
    };

interface RevokeIntentProof {
  readonly preview: string;
  readonly digest: string;
  readonly key: { readonly kid: string; readonly generation: number; readonly epoch: number };
}

function parseRevokeIntentProof(value: string): RevokeIntentProof {
  const raw: unknown = JSON.parse(value);
  if (!raw || typeof raw !== "object") throw new Error("corrupt_revoke_intent");
  const proof = raw as Record<string, unknown>;
  const key = proof.key;
  if (!key || typeof key !== "object") throw new Error("corrupt_revoke_intent");
  const fields = key as Record<string, unknown>;
  if (
    typeof proof.preview !== "string" ||
    !/^[0-9a-f]{64}$/.test(proof.preview) ||
    typeof proof.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(proof.digest) ||
    typeof fields.kid !== "string" ||
    !Number.isSafeInteger(fields.generation) ||
    !Number.isSafeInteger(fields.epoch)
  )
    throw new Error("corrupt_revoke_intent");
  return {
    preview: proof.preview,
    digest: proof.digest,
    key: {
      kid: fields.kid,
      generation: fields.generation as number,
      epoch: fields.epoch as number,
    },
  };
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
  /** Authenticated exact-session authority for workspace files; invalid after reopen/recovery. */
  workspaceAuthority(): {
    readonly vault: string;
    readonly generation: string;
    isCurrent(): boolean;
  } | null;
  /** Read/pull may continue while this denies new writes and external effects. */
  canRunSideEffects(): boolean;
  strategyDirectoryAuthority(): StrategyDirectoryAuthority | null;
  canFetchPublicMarket(): boolean;
  /** Exact-vault encrypted import archive, invalidated with this native session. */
  blobPublication(): NativeBlobPublication | null;
  isSyncing(): boolean;
  onSyncSettled(listener: () => void): () => void;
  /** Serialize inbound fold and push with UI commands on this vault. */
  sync(): Promise<SyncResult>;
  deviceList(): Promise<DeviceListResult>;
  devicePreview(draft: NativeDeviceRevokeDraft): Promise<NativeDevicePreviewResult>;
  deviceCommit(
    draft: NativeDeviceRevokeDraft,
    input: {
      readonly warningAcknowledgement: "revoke_risk_acknowledged";
      readonly localStartAcknowledgement?: "local_target_stream_never_seen";
      readonly recoveryPhrase: string;
    },
  ): Promise<RevokeCommitResult>;
  deviceInspect(operationId: string): Promise<RevokeInspectResult>;
  pairingStart(
    rendezvous: string,
  ): Promise<
    | devices.PairingStep<{ inviter: devices.PairingInviter; qr: string; authority: string }>
    | { ok: false; reason: "unavailable" }
  >;
  pairingRegisterInvite(
    session: string,
    operationId: string,
    qr: string,
    expiresAt: number,
  ): Promise<boolean>;
  pairingBindJoiner(
    session: string,
    joiner: {
      readonly deviceId: string;
      readonly signPublicKey: Uint8Array;
      readonly boxPublicKey: Uint8Array;
    },
  ): Promise<boolean>;
  pairingAppend(input: {
    readonly session: string;
    readonly operationId: string;
    readonly welcome: devices.InviterWelcome;
    readonly authority: string;
    readonly qr: string;
    readonly rendezvous: string;
  }): Promise<"completed" | "outcome_unknown" | "refused">;
  pairingAttempt(session: string): Promise<PairingAttempt | undefined>;
  pairingOperation(operationId: string): Promise<PairingAttempt | undefined>;
  pairingHasActive(): Promise<boolean>;
  pairingKnown(device: string, purpose: "carrier" | "resume", session?: string): Promise<boolean>;
  pairingTrust(
    device: string,
    signKey: Uint8Array,
    boxKey: Uint8Array,
    certificate: Uint8Array,
  ): Promise<boolean>;
  carrierRequest(
    request: LanCarrierRequest,
    expiresAt: number,
    onAuthorized?: () => void,
  ): Promise<LanCarrierReply>;
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
    const pairingJournal = new PairingJournal(meta);
    const lanCarrierRoot = join(dataDir, "lan-carrier");
    mkdirSync(lanCarrierRoot, { recursive: true, mode: 0o700 });
    const lanRootStat = lstatSync(lanCarrierRoot);
    if (
      !lanRootStat.isDirectory() ||
      lanRootStat.isSymbolicLink() ||
      (lanRootStat.mode & 0o077) !== 0
    )
      throw new Error("native_lan_carrier_invalid");
    const lanCarrier = new HostLanCarrier(lanCarrierRoot);
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
    const localTransport = new FolderTransport({ fs: new NodeFolderFs(logPath) });
    const lanRemote = new FolderTransport({
      fs: new NodeFolderFs(lanCarrierRoot),
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
      gateState: metaGateStateStore(store.driver, entry.deviceId),
      gossipEid: () => mintUlid(now()),
    });
    const recovered = await engine.recoverLocal();
    for (const pending of pairingJournal.pending(entry.vaultId)) {
      const proof = await engine.inspectOwnBatch({ eids: [pending.eid], digest: pending.digest });
      if (proof === "committed") {
        await engine.sync();
        const local = (await localTransport.list(entry.vaultId)).filter(
          (part) => part.device === entry.deviceId,
        );
        const remote = new Map(
          (await lanCarrier.list(entry.vaultId))
            .filter((part) => part.device === entry.deviceId)
            .map((part) => [part.seg, part.size]),
        );
        let mirrored = local.every((part) => remote.get(part.seg) === part.size);
        for (const part of local) {
          if (!mirrored) break;
          const expected = await localTransport.read(entry.vaultId, entry.deviceId, part.seg, 0);
          const actual = await lanCarrier.read(entry.vaultId, entry.deviceId, part.seg, 0);
          mirrored = Buffer.from(expected).equals(Buffer.from(actual));
        }
        if (mirrored) pairingJournal.mark(entry.vaultId, pending.session, "completed", now());
      } else if (proof === "absent")
        pairingJournal.mark(entry.vaultId, pending.session, "not_started", now());
    }
    const profile = store.read<{ gid: string }>("SELECT gid FROM profiles");
    assertReplayedDeviceAuthority(
      candidate,
      recovered,
      profile.length === 1 ? profile[0]?.gid : undefined,
    );
    if (candidate.devices.rotationNeeded() !== undefined)
      throw new Error("device_rotation_required");
    const queue = new WriteQueue(() => lease.assertHeld());
    let lastPairingPruneAt = now();
    const prunePairing = () => {
      const at = now();
      if (at - lastPairingPruneAt < 60_000) return;
      pairingJournal.pruneReceipts(entry.vaultId, at);
      pairingJournal.pruneInvites(entry.vaultId, at);
      lastPairingPruneAt = at;
    };
    const epoch = {};
    const workspaceGeneration = randomUUID();
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
    let blobPublication: NativeBlobPublication | null = null;
    const pairingAuthority = (): string => {
      const recovery = activeCandidate.devices.registry.recovery;
      const active = activeCandidate.ring.active;
      return createHash("sha256")
        .update(
          JSON.stringify({
            session: entry.deviceId,
            signer: Buffer.from(activeCandidate.identity.signPublicKey).toString("hex"),
            ring: [active.kid, active.epoch, active.generation, activeCandidate.ring.size],
            recovery: [
              Buffer.from(recovery.signPublicKey).toString("hex"),
              Buffer.from(recovery.boxPublicKey).toString("hex"),
            ],
            registryEvents: activeCandidate.devices.registry.events,
          }),
        )
        .digest("hex");
    };
    const ensureOwnLanMirror = async (): Promise<boolean> => {
      await activeEngine.sync();
      const local = (await localTransport.list(entry.vaultId)).filter(
        (part) => part.device === entry.deviceId,
      );
      const mirror = new Map(
        (await lanCarrier.list(entry.vaultId))
          .filter((part) => part.device === entry.deviceId)
          .map((part) => [part.seg, part.size]),
      );
      for (const part of local) {
        if (mirror.get(part.seg) !== part.size) return false;
        const expected = await localTransport.read(entry.vaultId, entry.deviceId, part.seg, 0);
        const actual = await lanCarrier.read(entry.vaultId, entry.deviceId, part.seg, 0);
        if (!Buffer.from(expected).equals(Buffer.from(actual))) return false;
      }
      return true;
    };
    const revokeCommand = "native.devices.revokeCommit";
    const revokeRequest = (draft: NativeDeviceRevokeDraft): devices.RevocationPreviewRequest => {
      const view = activeStore.cursors();
      const guarded = new Map(activeCandidate.devices.guard.entries());
      return {
        targets: draft.targets.map((device) => {
          const applied = guarded.get(device) ?? { seg: 1, offset: 0 };
          const durable = view.get(device) ?? { seg: 1, offset: 0 };
          if (applied.seg !== durable.seg || applied.offset !== durable.offset)
            throw new Error("revoke_cursor_mismatch");
          return { device, applied };
        }),
        revokeEid: draft.eids.revoke,
        attemptId: draft.operationId,
        authority: { kind: "recovery" },
        selection: { recertify: draft.recertify },
      };
    };
    const reconcileRevoke = async (
      operationId: string,
      eids: readonly string[],
      fingerprint: string,
    ): Promise<"completed" | "not_started" | "outcome_unknown"> => {
      try {
        const proof = parseRevokeIntentProof(fingerprint);
        const verified = await activeEngine.inspectOwnBatch({ eids, digest: proof.digest });
        const held = activeCandidate.ring.get(proof.key.kid);
        if (
          verified === "committed" &&
          held &&
          held.generation === proof.key.generation &&
          held.epoch === proof.key.epoch
        ) {
          await crypto.saveKeyring(source.keyStore, activeCandidate.ring);
          await attempts.markCompleted(operationId, { kind: "completed", operationId });
          return "completed";
        }
        if (verified === "absent") {
          await attempts.markNotStarted(operationId);
          return "not_started";
        }
      } catch {
        /* Keep the original keyed attempt pending until the same proof can be inspected. */
      }
      return "outcome_unknown";
    };
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
    for (const record of await attempts.unresolved(entry.vaultId)) {
      if (record.commandId === revokeCommand)
        await reconcileRevoke(record.attemptId, record.eids, record.fingerprint);
    }
    const completed = meta
      .prepare("SELECT command_id, fingerprint, eids FROM host_attempts WHERE phase='completed'")
      .all<{ command_id: string; fingerprint: string; eids: string }>();
    for (const row of completed) {
      const eids: unknown = JSON.parse(row.eids);
      if (!Array.isArray(eids) || !eids.every((eid) => typeof eid === "string"))
        throw new Error("corrupt_attempt");
      if (row.command_id === revokeCommand) {
        const proof = parseRevokeIntentProof(row.fingerprint);
        const result = await activeEngine.inspectOwnBatch({ eids, digest: proof.digest });
        const held = activeCandidate.ring.get(proof.key.kid);
        if (
          result !== "committed" ||
          !held ||
          held.generation !== proof.key.generation ||
          held.epoch !== proof.key.epoch
        )
          throw new Error("incomplete_history");
      } else if (activeStore.eventHlcs(eids).size !== eids.length) {
        throw new Error("incomplete_history");
      }
    }
    // Authenticated local recovery may have merged wraps into the ring. Persist before exposure.
    await crypto.saveKeyring(source.keyStore, activeCandidate.ring);
    attempts.pruneReceipts();
    pairingJournal.pruneReceipts(entry.vaultId, now());
    pairingJournal.pruneInvites(entry.vaultId, now());
    const canRunSideEffects = () => {
      try {
        return (
          isCurrent() &&
          !attempts.hasPending(entry.vaultId, revokeCommand) &&
          pairingJournal.pending(entry.vaultId).length === 0 &&
          activeEngine.writeAdmission() === "ready"
        );
      } catch {
        return false;
      }
    };
    return {
      id: entry.vaultId,
      store: activeStore,
      engine: activeEngine,
      attempts,
      queue,
      device: entry.deviceId,
      epoch,
      isCurrent,
      workspaceAuthority: () => {
        if (!canRunSideEffects()) return null;
        const fingerprint = pairingAuthority();
        return {
          vault: entry.vaultId,
          generation: `${workspaceGeneration}:${fingerprint}`,
          isCurrent: () => canRunSideEffects() && pairingAuthority() === fingerprint,
        };
      },
      canRunSideEffects,
      strategyDirectoryAuthority: () => {
        if (!isCurrent()) return null;
        try {
          const rootInfo = lstatSync(root);
          const directory = existing(join(root, "strategy"), "directory");
          const strategyInfo = lstatSync(directory);
          if (
            !rootInfo.isDirectory() ||
            rootInfo.isSymbolicLink() ||
            (rootInfo.mode & 0o077) !== 0 ||
            (strategyInfo.mode & 0o077) !== 0
          )
            return null;
          return { vault: entry.vaultId, privateRoot: root, directory, isCurrent };
        } catch {
          return null;
        }
      },
      canFetchPublicMarket: () => {
        if (!isCurrent() || activeEngine.writeAdmission() !== "ready") return false;
        try {
          const transport = activeEngine.leaseTransport();
          return devices.holdsLease(activeCandidate.devices.lease, {
            me: entry.deviceId,
            now: now(),
            lastPullAt: transport.kind === "bounded" ? transport.lastPullAt : undefined,
            transport,
            own: () => undefined,
            firstSeen: (eid) => activeCandidate.devices.firstSeen(eid),
            // The host has no persisted clock-warning authority yet. A recent pull and write
            // admission do not prove the HLC clock is healthy, so fetch stays unavailable.
            clockOk: false,
          });
        } catch {
          return false;
        }
      },
      blobPublication: () => {
        if (!isCurrent()) return null;
        if (blobPublication === null)
          blobPublication = new NativeBlobPublication({
            dataDir,
            vault: entry.vaultId,
            lock: lease.lock(),
            sodium: source.sodium,
            ring: activeCandidate.ring,
          });
        return blobPublication.isCurrent() ? blobPublication : null;
      },
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
      deviceList: () =>
        queue.run(() => {
          if (!isCurrent()) return { kind: "refused", code: "unavailable" } as const;
          const behind = new Set(activeCandidate.gate.behind().map((x) => x.device));
          const forked = new Set(activeCandidate.gate.forks().map((x) => x.device));
          const records = [...activeCandidate.devices.registry.devices.values()].sort((a, b) =>
            a.deviceId.localeCompare(b.deviceId),
          );
          return {
            kind: "ready",
            vault: entry.vaultId,
            ownDevice: entry.deviceId,
            operations: [...attempts.recentOperations(entry.vaultId, revokeCommand)],
            evidence: {
              historyPending: activeCandidate.gate.gossipStatus().historyPending,
              overflow: activeCandidate.gate.gossipStatus().overflow,
              authorityUncertain: activeCandidate.gate.gossipStatus().authorityUncertain,
              writeAdmission: activeEngine.writeAdmission(),
            },
            devices: records.map((record) => ({
              id: record.deviceId,
              name: record.name,
              trusted: activeCandidate.devices.registry.isTrusted(record.deviceId),
              revoked: activeCandidate.devices.registry.revoked.has(record.deviceId),
              behind: behind.has(record.deviceId),
              forked: forked.has(record.deviceId),
            })),
          } as const;
        }),
      devicePreview: (draft) =>
        queue.run(async () => {
          if (!isCurrent() || draft.vault !== entry.vaultId)
            return { kind: "refused", code: "unavailable" } as const;
          if (attempts.hasPending(entry.vaultId, revokeCommand))
            return { kind: "refused", code: "outcome_unknown" } as const;
          if (draft.targets.includes(entry.deviceId))
            return { kind: "refused", code: "retirement_unavailable" } as const;
          try {
            const synced = await activeEngine.sync();
            const recovered = await activeEngine.recoverLocal();
            if (synced.rolledBack || !recovered.complete || recovered.rolledBack)
              throw new Error("sync_incomplete");
            const rows = activeStore.read<{ gid: string }>("SELECT gid FROM profiles");
            assertReplayedDeviceAuthority(
              activeCandidate,
              recovered,
              rows.length === 1 ? rows[0]?.gid : undefined,
            );
          } catch {
            current = false;
            queue.close();
            return { kind: "refused", code: "unavailable" } as const;
          }
          let request: devices.RevocationPreviewRequest;
          try {
            request = revokeRequest(draft);
          } catch {
            return { kind: "refused", code: "integrity_failure" } as const;
          }
          const observed = devices.previewRevocation(
            activeCandidate.devices,
            activeCandidate.gate,
            request,
          );
          if (!observed.ok)
            return {
              kind: "refused",
              code: observed.reason === "integrity_error" ? "integrity_failure" : "unsafe_target",
            } as const;
          const preview = observed.preview;
          const after = activeCandidate.devices.registry.previewRevocation(draft.targets);
          const affected = [...activeCandidate.devices.registry.trusted.keys()]
            .filter((id) => !draft.targets.includes(id) && !after.trusted.has(id))
            .sort()
            .map((device) => ({
              device,
              name: activeCandidate.devices.registry.devices.get(device)?.name ?? "device",
              selected: draft.recertify.includes(device),
            }));
          return {
            kind: "prepared",
            fingerprint: preview.fingerprint,
            targets: preview.targets.map((target) => ({
              device: target.entry.device,
              cut: target.entry.cut,
              head: target.status === "trusted_head" ? "trusted" : "local_start",
            })),
            affected,
            localStartConfirmationRequired: preview.requiresLocalStartConfirmation,
          } as const;
        }),
      deviceCommit: (draft, input) =>
        queue.run(async () => {
          if (!isCurrent() || draft.vault !== entry.vaultId || !draft.fingerprint)
            return { kind: "refused", code: "unavailable" } as const;
          if (attempts.hasPending(entry.vaultId, revokeCommand))
            return { kind: "refused", code: "outcome_unknown" } as const;
          const existing = activeCandidate.devices.registry.isTrusted(entry.deviceId);
          if (draft.targets.includes(entry.deviceId))
            return { kind: "refused", code: "retirement_unavailable" } as const;
          if (!existing) return { kind: "refused", code: "unsafe_target" } as const;
          // Reconcile inbound history before the final local cut. The queue holds every local writer.
          try {
            const synced = await activeEngine.sync();
            const recovered = await activeEngine.recoverLocal();
            if (synced.rolledBack || !recovered.complete || recovered.rolledBack)
              throw new Error("sync_incomplete");
            const rows = activeStore.read<{ gid: string }>("SELECT gid FROM profiles");
            assertReplayedDeviceAuthority(
              activeCandidate,
              recovered,
              rows.length === 1 ? rows[0]?.gid : undefined,
            );
          } catch {
            current = false;
            queue.close();
            return { kind: "refused", code: "unavailable" } as const;
          }
          let request: devices.RevocationPreviewRequest;
          try {
            request = revokeRequest(draft);
          } catch {
            return { kind: "refused", code: "integrity_failure" } as const;
          }
          const observed = devices.previewRevocation(
            activeCandidate.devices,
            activeCandidate.gate,
            request,
          );
          if (!observed.ok)
            return {
              kind: "refused",
              code: observed.reason === "integrity_error" ? "integrity_failure" : "preview_stale",
            } as const;
          if (observed.preview.fingerprint !== draft.fingerprint)
            return { kind: "refused", code: "preview_stale" } as const;
          const permit = devices.acknowledgeRevocationPreview(observed.preview, {
            warning: "acknowledged",
            ...(input.localStartAcknowledgement === "local_target_stream_never_seen"
              ? { localStart: "local_never_seen" as const }
              : {}),
          });
          if (!permit) return { kind: "refused", code: "confirmation_required" } as const;
          let recovery: crypto.RecoveryIdentity;
          try {
            recovery = crypto.recoveryIdentity(source.sodium, input.recoveryPhrase);
          } catch {
            return { kind: "refused", code: "recovery_invalid" } as const;
          }
          let prepared: devices.PrepareResult | undefined;
          let intentStarted = false;
          try {
            const recertifyEids = draft.recertify.map(() => mintUlid(now()));
            let next = 0;
            prepared = activeCandidate.devices.prepareRevocation(
              activeCandidate.gate,
              request,
              permit,
              { ...draft.eids, recertify: () => recertifyEids[next++] ?? mintUlid(now()) },
              recovery,
              { recertify: draft.recertify },
            );
            if (!prepared.ok)
              return {
                kind: "refused",
                code:
                  prepared.reason === "authority_required" ? "authority_required" : "unsafe_target",
              } as const;
            if (
              draft.recertify.some(
                (device) =>
                  !prepared?.ok ||
                  !prepared.change.affected.some(
                    (affected) => affected.device === device && affected.recertified,
                  ),
              )
            ) {
              prepared.change.discard();
              return { kind: "refused", code: "recertify_capacity" } as const;
            }
            const change = prepared.change;
            const rotated = change.key;
            if (!rotated) {
              change.discard();
              return { kind: "refused", code: "unsafe_target" } as const;
            }
            const eids = change.events.map((event) => event.i);
            const digest = ownBatchDigest(change.events);
            const fingerprint = JSON.stringify({
              preview: observed.preview.fingerprint,
              digest,
              key: change.key,
            });
            intentStarted = true;
            const saved = await attempts.saveMayAppend({
              vault: entry.vaultId,
              key: draft.operationId,
              attemptId: draft.operationId,
              commandId: revokeCommand,
              fingerprint,
              eids,
              digest,
            });
            if (
              saved.phase !== "may_append" ||
              saved.attemptId !== draft.operationId ||
              saved.fingerprint !== fingerprint ||
              saved.eids.join("|") !== eids.join("|")
            ) {
              change.discard();
              current = false;
              queue.close();
              return { kind: "outcome_unknown", operationId: draft.operationId } as const;
            }
            try {
              await activeEngine.write(change.events);
              const verified = await activeEngine.inspectOwnBatch({ eids, digest });
              if (verified !== "committed") throw new Error("revoke_history_unverified");
              const replayed = activeCandidate.ring.get(rotated.kid);
              if (
                !replayed ||
                replayed.generation !== rotated.generation ||
                replayed.epoch !== rotated.epoch
              )
                throw new Error("revoke_self_wrap_unavailable");
              change.commit();
              await crypto.saveKeyring(source.keyStore, activeCandidate.ring);
              await attempts.markCompleted(draft.operationId, {
                kind: "completed",
                operationId: draft.operationId,
              });
              return { kind: "completed", operationId: draft.operationId } as const;
            } catch {
              current = false;
              queue.close();
              return { kind: "outcome_unknown", operationId: draft.operationId } as const;
            }
          } catch {
            if (intentStarted) {
              current = false;
              queue.close();
              return { kind: "outcome_unknown", operationId: draft.operationId } as const;
            }
            return { kind: "refused", code: "unsafe_target" } as const;
          } finally {
            recovery.wipe();
            if (prepared?.ok) prepared.change.discard();
          }
        }),
      deviceInspect: (operationId) =>
        queue.run(async () => {
          const status = attempts.status(entry.vaultId, operationId, revokeCommand);
          if (status.phase === "absent") return { kind: "not_found", operationId } as const;
          if (status.phase === "completed") return { kind: "completed", operationId } as const;
          if (status.phase === "terminal" && status.result.kind === "not_started")
            return { kind: "not_started", operationId } as const;
          if (status.phase !== "may_append")
            return { kind: "refused", code: "operation_conflict" } as const;
          // Inspection only reconciles the original keyed operation. It never creates a new batch.
          const result = await reconcileRevoke(operationId, status.eids, status.fingerprint);
          return { kind: result, operationId } as const;
        }),
      pairingStart: (rendezvous) =>
        queue.run(() => {
          prunePairing();
          if (
            !isCurrent() ||
            attempts.hasPending(entry.vaultId, revokeCommand) ||
            pairingJournal.pending(entry.vaultId).length > 0 ||
            activeEngine.writeAdmission() !== "ready"
          )
            return { ok: false, reason: "unavailable" } as const;
          const authority = pairingAuthority();
          const created = devices.PairingInviter.create({
            sodium: source.sodium,
            identity: activeCandidate.identity,
            ring: activeCandidate.ring,
            registry: activeCandidate.devices.registry,
            now: now(),
            rendezvous,
          });
          return created.ok ? { ok: true, value: { ...created.value, authority } } : created;
        }),
      pairingRegisterInvite: (session, operationId, qr, expiresAt) =>
        queue.run(() => {
          if (!isCurrent() || !Number.isSafeInteger(expiresAt) || expiresAt <= now()) return false;
          pairingJournal.registerInvite({
            session,
            operationId,
            vault: entry.vaultId,
            qrDigest: createHash("sha256").update(qr).digest("hex"),
            expiresAt,
          });
          return true;
        }),
      pairingBindJoiner: (session, joiner) =>
        queue.run(() => {
          if (!isCurrent()) return false;
          const invite = pairingJournal.invite(entry.vaultId, session);
          if (!invite || now() > invite.expiresAt) return false;
          pairingJournal.bindJoiner(entry.vaultId, session, {
            device: joiner.deviceId,
            signKey: Buffer.from(joiner.signPublicKey).toString("hex"),
            boxKey: Buffer.from(joiner.boxPublicKey).toString("hex"),
          });
          return true;
        }),
      pairingAppend: (input) =>
        queue.run(async () => {
          if (
            !isCurrent() ||
            attempts.hasPending(entry.vaultId, revokeCommand) ||
            pairingJournal.pending(entry.vaultId).length > 0 ||
            activeEngine.writeAdmission() !== "ready"
          )
            return "refused" as const;
          if (input.authority !== pairingAuthority()) return "refused" as const;
          const registeredInvite = pairingJournal.invite(entry.vaultId, input.session);
          if (
            !registeredInvite ||
            registeredInvite.operationId !== input.operationId ||
            registeredInvite.qrDigest !== createHash("sha256").update(input.qr).digest("hex") ||
            registeredInvite.device !== input.welcome.device.deviceId
          )
            return "refused" as const;
          const descriptor = decodeLanDescriptor(input.rendezvous, true);
          if (!descriptor || input.qr.length > 2_048) return "refused" as const;
          const event: UnstampedEvent = input.welcome.deviceAdded;
          const payload = event.d;
          if (
            event.t !== "device.added" ||
            typeof payload.device !== "string" ||
            payload.device !== input.welcome.device.deviceId ||
            typeof payload.signPublicKey !== "string" ||
            typeof payload.boxPublicKey !== "string" ||
            typeof payload.certificate !== "string" ||
            payload.signPublicKey !== registeredInvite.signKey ||
            payload.boxPublicKey !== registeredInvite.boxKey ||
            activeCandidate.devices.registry.isRegistered(payload.device)
          )
            return "refused" as const;
          const candidateBytes = Buffer.byteLength(
            JSON.stringify({
              v: 1,
              vaultId: entry.vaultId,
              deviceId: payload.device,
              session: input.session,
              invite: input.qr,
              certificate: Buffer.from(input.welcome.certificate).toString("hex"),
              registryEvents: activeCandidate.devices.registry.events.slice(
                0,
                devices.MAX_REGISTRY_EVENTS,
              ),
              ip: descriptor.ip,
              port: descriptor.port,
              spki: descriptor.spki,
            }),
            "utf8",
          );
          if (candidateBytes > 72 * 1024 * 1024) return "refused" as const;
          const digest = ownBatchDigest([event]);
          const attempt = pairingJournal.prepare({
            session: input.session,
            operationId: input.operationId,
            vault: entry.vaultId,
            device: payload.device,
            signKey: payload.signPublicKey,
            boxKey: payload.boxPublicKey,
            certificate: payload.certificate,
            event,
            eid: event.i,
            digest,
            welcome: input.welcome.reply,
            pages: input.welcome.pages,
            phase: "may_append",
          });
          if (attempt.phase !== "may_append") return "refused" as const;
          try {
            await activeEngine.write([event]);
            if ((await activeEngine.inspectOwnBatch({ eids: [event.i], digest })) !== "committed")
              throw new Error("pairing_batch_unverified");
            if (!(await ensureOwnLanMirror())) throw new Error("pairing_mirror_unavailable");
            pairingJournal.mark(entry.vaultId, input.session, "completed", now());
            return "completed" as const;
          } catch {
            // The exact authenticated batch is reconciled from the durable journal on reopen.
            current = false;
            queue.close();
            return "outcome_unknown" as const;
          }
        }),
      pairingAttempt: (session) =>
        queue.run(async () => {
          prunePairing();
          if (!isCurrent()) return undefined;
          const attempt = pairingJournal.get(entry.vaultId, session);
          if (!attempt || attempt.vault !== entry.vaultId) return undefined;
          if (attempt.phase !== "may_append") return attempt;
          const proof = await activeEngine.inspectOwnBatch({
            eids: [attempt.eid],
            digest: attempt.digest,
          });
          if (proof === "committed" && (await ensureOwnLanMirror()))
            pairingJournal.mark(entry.vaultId, session, "completed", now());
          else if (proof === "absent")
            pairingJournal.mark(entry.vaultId, session, "not_started", now());
          return pairingJournal.get(entry.vaultId, session);
        }),
      pairingOperation: (operationId) =>
        queue.run(async () => {
          prunePairing();
          if (!isCurrent()) return undefined;
          const attempt = pairingJournal.forOperation(entry.vaultId, operationId);
          if (!attempt) return undefined;
          if (attempt.phase === "may_append") {
            const proof = await activeEngine.inspectOwnBatch({
              eids: [attempt.eid],
              digest: attempt.digest,
            });
            if (proof === "committed" && (await ensureOwnLanMirror()))
              pairingJournal.mark(entry.vaultId, attempt.session, "completed", now());
            else if (proof === "absent")
              pairingJournal.mark(entry.vaultId, attempt.session, "not_started", now());
          }
          return pairingJournal.forOperation(entry.vaultId, operationId);
        }),
      pairingHasActive: () =>
        queue.run(() => {
          if (!isCurrent()) return false;
          if (pairingJournal.pending(entry.vaultId).length > 0) return true;
          for (const device of activeCandidate.devices.registry.trusted.keys())
            if (pairingJournal.forDevice(entry.vaultId, device) !== undefined) return true;
          return false;
        }),
      pairingKnown: (device, purpose, session) =>
        queue.run(() => {
          if (!isCurrent()) return false;
          if (purpose === "carrier") return activeCandidate.devices.registry.isTrusted(device);
          if (!session) return false;
          const attempt = pairingJournal.get(entry.vaultId, session);
          return (
            !!attempt &&
            attempt.device === device &&
            attempt.phase === "completed" &&
            activeCandidate.devices.registry.isTrusted(device)
          );
        }),
      pairingTrust: (device, signKey, boxKey, certificate) =>
        queue.run(() => {
          if (!isCurrent()) return false;
          const record = activeCandidate.devices.registry.trusted.get(device);
          const stored = pairingJournal.forDevice(entry.vaultId, device);
          return (
            !!record &&
            !!stored &&
            Buffer.from(record.signPublicKey).equals(Buffer.from(signKey)) &&
            Buffer.from(record.boxPublicKey).equals(Buffer.from(boxKey)) &&
            stored.signKey === Buffer.from(signKey).toString("hex") &&
            stored.boxKey === Buffer.from(boxKey).toString("hex") &&
            stored.certificate === Buffer.from(certificate).toString("hex")
          );
        }),
      carrierRequest: (request, expiresAt, onAuthorized) =>
        queue.run(async () => {
          const refused = (
            code:
              | "unavailable"
              | "invalid"
              | "unauthorized"
              | "offset_conflict"
              | "too_large"
              | "busy"
              | "unknown",
          ) => ({ v: 1 as const, kind: "refused" as const, code });
          if (
            !isCurrent() ||
            request.vault !== entry.vaultId ||
            request.auth.vault !== entry.vaultId ||
            request.auth.device !== request.device ||
            now() > expiresAt
          )
            return refused("unavailable");
          if (
            request.method === "append" &&
            (attempts.hasPending(entry.vaultId, revokeCommand) ||
              pairingJournal.pending(entry.vaultId).length > 0 ||
              activeEngine.writeAdmission() !== "ready")
          )
            return refused("unavailable");
          const registered = activeCandidate.devices.registry.trusted.get(request.device);
          if (!registered) return refused("unauthorized");
          const decodedBytes =
            request.bytes === undefined ? undefined : Buffer.from(request.bytes, "base64url");
          if (decodedBytes && decodedBytes.length > 72 * 1024 * 1024) return refused("too_large");
          const body = lanAuthBody({
            purpose: "carrier",
            path: LAN_CARRIER_PATH,
            method: request.method,
            vault: request.vault,
            device: request.device,
            ...(request.writer === undefined ? {} : { writer: request.writer }),
            ...(request.seg === undefined ? {} : { seg: request.seg }),
            ...(request.offset === undefined ? {} : { offset: request.offset }),
            ...(decodedBytes === undefined ? {} : { bytesDigest: lanBytesDigest(decodedBytes) }),
            nonce: request.auth.nonce,
            expiresAt,
          });
          if (
            !crypto.verifyContextSignature(
              "cashu/lan-auth/v1",
              body,
              Buffer.from(request.auth.signature, "hex"),
              registered.signPublicKey,
            )
          )
            return refused("unauthorized");
          onAuthorized?.();
          try {
            prunePairing();
            // Pull and validate any mobile stream before exposing new opaque state. The vault
            // queue serializes this with revocation and native commands.
            await activeEngine.sync();
            const recovered = await activeEngine.recoverLocal();
            const profiles = activeStore.read<{ gid: string }>("SELECT gid FROM profiles");
            assertReplayedDeviceAuthority(
              activeCandidate,
              recovered,
              profiles.length === 1 ? profiles[0]?.gid : undefined,
            );
            if (activeCandidate.devices.rotationNeeded() !== undefined)
              return refused("unavailable");
            await crypto.saveKeyring(source.keyStore, activeCandidate.ring);
            const refreshed = activeCandidate.devices.registry.trusted.get(request.device);
            if (
              !refreshed ||
              !Buffer.from(refreshed.signPublicKey).equals(Buffer.from(registered.signPublicKey)) ||
              !Buffer.from(refreshed.boxPublicKey).equals(Buffer.from(registered.boxPublicKey))
            )
              return refused("unauthorized");
            if (request.method === "list") {
              const segments = await lanCarrier.list(entry.vaultId);
              return {
                v: 1,
                kind: "list",
                segments: segments.map((part) => ({
                  writer: part.device,
                  seg: part.seg,
                  size: part.size,
                })),
              } as const;
            }
            if (
              request.writer === undefined ||
              request.seg === undefined ||
              request.offset === undefined
            )
              return refused("invalid");
            if (request.method === "read") {
              const bytes = await lanCarrier.read(
                entry.vaultId,
                request.writer,
                request.seg,
                request.offset,
              );
              return {
                v: 1,
                kind: "read",
                bytes: Buffer.from(bytes).toString("base64url"),
              } as const;
            }
            if (request.writer !== request.device || decodedBytes === undefined)
              return refused("unauthorized");
            const size = await lanCarrier.append(
              entry.vaultId,
              request.writer,
              request.seg,
              request.offset,
              decodedBytes,
            );
            // A successful remote append is promptly pulled through the authenticated engine.
            await activeEngine.sync();
            return { v: 1, kind: "append", size, digest: lanBytesDigest(decodedBytes) } as const;
          } catch (error) {
            const code = error instanceof Error ? error.message : "";
            if (code === "carrier_offset_conflict") return refused("offset_conflict");
            if (code === "carrier_too_large") return refused("too_large");
            return refused("unknown");
          }
        }),
      invalidate() {
        current = false;
        blobPublication?.close();
        queue.close();
        notifySyncSettled();
      },
      async close() {
        current = false;
        blobPublication?.close();
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
