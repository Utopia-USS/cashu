import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { builtinRegistry, cleanModules } from "@cashu/domain/core";
import type {
  NativeCreationCommitParams,
  NativeCreationCommitResult,
  NativeCreationCurrentParams,
  NativeCreationCurrentResult,
  NativeCreationInspectParams,
  NativeCreationInspectResult,
  NativeCreationPrepareParams,
  NativeCreationPrepareResult,
  NativeCreationReady,
} from "@cashu/host-protocol";
import { nativeCreationPrepareParamsSchema } from "@cashu/host-protocol";
import { type HostLock, NodeFolderFs } from "@cashu/node-host";
import { legacyDataAdmission } from "@cashu/node-host/admission";
import { createProductionKeyStore } from "@cashu/node-host/keyring";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  createProfile,
  metaClockStore,
  metaGateStateStore,
  mintUlid,
  prepareCommand,
  Store,
  toUnstampedEvent,
  vaultSalt,
} from "@cashu/store";
import { createOwnLogCodec, createSyncEngine, crypto, devices, FolderTransport } from "@cashu/sync";
import { SqlAttemptJournal } from "./attemptJournal.js";
import { takeWriterLease } from "./lease.js";
import { initializeNativeClockGuard, nativeClockGuard } from "./market/clockGuard.js";
import { readNativeRecoveryWrap } from "./nativeCreationArtifacts.js";
import {
  type CreationStage,
  classifyNativeCreationStartup,
  NativeCreationJournal,
  type PendingCreation,
} from "./nativeCreationJournal.js";
import {
  creationEffectHash,
  creationInputHash,
  verifyCompletedNativeCreation,
} from "./nativeCreationProof.js";
import {
  NATIVE_CERTIFICATES,
  NATIVE_INVENTORY,
  readExistingNativeInventory,
} from "./nativeInventory.js";
import { type NativeVaultSource, openNativeVault } from "./nativeVault.js";
import { ProductionVaultSourceFactory } from "./productionVaultSource.js";
import { assertReplayedDeviceAuthority, loadDeviceAuthority } from "./sync/keys/deviceAuthority.js";
import { SqlProvenanceStore } from "./sync/keys/sqlProvenance.js";

const PREPARE_TTL_MS = 10 * 60 * 1000;
const MAX_ARTIFACT = 32 * 1024;
const REFUSED = (
  code:
    | "invalid_input"
    | "setup_unavailable"
    | "pending_exists"
    | "prepare_expired"
    | "prepare_missing"
    | "operation_conflict"
    | "unsafe_target",
) => ({ kind: "refused" as const, code });

type Prepared = {
  readonly operationId: string;
  readonly phraseSession: string;
  readonly expiresAt: number;
  readonly input: NativeCreationPrepareParams;
  readonly enabledModules: readonly string[];
  readonly inputHash: string;
  readonly identity: crypto.DeviceIdentity;
  readonly recovery: crypto.RecoveryIdentity;
  readonly created: crypto.NewVault;
};

export interface NativeCreationOptions {
  readonly dataDir: string;
  readonly lock: HostLock;
  readonly now?: () => number;
  /** Fake OS port only in a strict test namespace. Ordinary host omits this. */
  readonly createKeyStore?: typeof createProductionKeyStore;
  /** The host's additional source roots, checked again before each Create effect. */
  readonly assertSourceAdmission?: () => void;
  readonly sodium?: crypto.Sodium;
  /** Synthetic fault injection after a durable phase record; never bound by the ordinary host. */
  readonly faultAfterPhase?: (stage: CreationStage) => void;
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (stat.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new Error("native_creation_path_invalid");
}

function syncDir(path: string): void {
  privateDirectory(path);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error("native_creation_path_invalid");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureChild(parent: string, name: string): string {
  privateDirectory(parent);
  const path = join(parent, name);
  if (!existsSync(path)) {
    mkdirSync(path, { mode: 0o700 });
    syncDir(parent);
  }
  privateDirectory(path);
  return path;
}

function newChild(parent: string, name: string): string {
  privateDirectory(parent);
  const path = join(parent, name);
  mkdirSync(path, { mode: 0o700 });
  syncDir(parent);
  privateDirectory(path);
  return path;
}

function privateNewFile(path: string, bytes: Uint8Array, max = MAX_ARTIFACT): void {
  if (bytes.length > max) throw new Error("native_creation_artifact_invalid");
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDir(dirname(path));
}

function privateAtomicFile(path: string, bytes: Uint8Array): void {
  if (bytes.length > MAX_ARTIFACT * 2) throw new Error("native_creation_artifact_invalid");
  const temp = join(dirname(path), `.inventory-${randomBytes(16).toString("hex")}.tmp`);
  privateNewFile(temp, bytes, MAX_ARTIFACT * 2);
  renameSync(temp, path);
  syncDir(dirname(path));
}

function canonicalArtifact(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function existingInventory(dataDir: string): {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly state: "ready";
  readonly enrollment: "creator" | "pairing" | "recovery";
}[] {
  const path = join(dataDir, NATIVE_INVENTORY);
  if (!existsSync(path)) return [];
  const found = readExistingNativeInventory(dataDir);
  return found.entries.map(({ vaultId, deviceId, enrollment }) => ({
    vaultId,
    deviceId,
    state: "ready" as const,
    enrollment,
  }));
}

function verifyProfile(
  store: Store,
  input: NativeCreationPrepareParams,
  vaultId: string,
  enabled: readonly string[],
): void {
  const profiles = store.read<{
    gid: string;
    slug: string;
    name: string;
    base_currency: string;
    mcp_privacy: string;
  }>("SELECT gid, slug, name, base_currency, mcp_privacy FROM profiles");
  if (
    profiles.length !== 1 ||
    profiles[0]?.gid !== vaultId ||
    profiles[0]?.slug !== input.slug ||
    profiles[0]?.name !== input.name ||
    profiles[0]?.base_currency !== input.baseCurrency ||
    profiles[0]?.mcp_privacy !== input.mcpPrivacy
  )
    throw new Error("native_creation_profile_mismatch");
  const modules = store
    .read<{ module_id: string }>("SELECT module_id FROM profile_modules WHERE enabled=1")
    .map((row) => row.module_id)
    .sort();
  if (modules.join("\0") !== [...enabled].sort().join("\0"))
    throw new Error("native_creation_profile_mismatch");
}

function readyOf(operationId: string, vaultId: string, profileSlug: string): NativeCreationReady {
  return { kind: "ready", operationId, vaultId, profileSlug, reconnectRequired: true };
}

/** Host-owned Create. The inventory is a locator; this class never trusts it as enrollment proof. */
export function createNativeCreationService(options: NativeCreationOptions) {
  const dataDir = options.dataDir;
  if (resolve(dataDir) !== dataDir || realpathSync(dataDir) !== dataDir)
    throw new Error("native_creation_path_invalid");
  const lock = options.lock;
  const journal = new NativeCreationJournal(dataDir, lock);
  const now = options.now ?? Date.now;
  const makeKeyStore = options.createKeyStore ?? createProductionKeyStore;
  let prepared: Prepared | null = null;
  let active: Promise<NativeCreationCommitResult> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  const verified = new Map<string, { anchor: string; inventory: string }>();

  const assertLock = () => {
    if (!lock.held) {
      verified.clear();
      throw new Error("native_host_lock_required");
    }
  };
  const assertSourceAdmission = () => {
    // A missing legacy sentinel is only an absence check, never native inventory authority.
    if (legacyDataAdmission(dataDir) !== "no_legacy_sentinel")
      throw new Error("native_creation_source_unavailable");
    options.assertSourceAdmission?.();
  };
  const wipe = (value: Prepared | null) => {
    value?.identity.wipe();
    value?.recovery.wipe();
    value?.created.ring.wipe();
  };
  const clearExpired = () => {
    if (prepared && now() >= prepared.expiresAt) {
      wipe(prepared);
      prepared = null;
    }
  };

  const clearTimer = () => {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
  };

  const primeVerifiedCompleted = async (): Promise<void> => {
    assertLock();
    verified.clear();
    const state = journal.snapshot();
    if (state.completed.length === 0) return;
    const fingerprint = readExistingNativeInventory(dataDir).fingerprint;
    for (const anchor of state.completed) {
      if (!lock.held) throw new Error("native_host_lock_required");
      if (await verifyCompletedNativeCreation(dataDir, lock, anchor, makeKeyStore, now)) {
        verified.set(anchor.operationId, {
          anchor: JSON.stringify(anchor),
          inventory: fingerprint,
        });
      }
    }
  };

  const inspect = async ({
    operationId,
  }: NativeCreationInspectParams): Promise<NativeCreationInspectResult> => {
    assertLock();
    const state = journal.snapshot();
    if (state.pending?.operationId === operationId)
      return {
        kind: active ? "pending" : "outcome_unknown",
        operationId,
        stage: state.pending.stage,
      };
    const completed = state.completed.find((item) => item.operationId === operationId);
    if (completed) {
      const proof = verified.get(operationId);
      let fingerprint: string;
      try {
        fingerprint = readExistingNativeInventory(dataDir).fingerprint;
      } catch {
        return { kind: "outcome_unknown", operationId, stage: "publishing" };
      }
      if (!proof || proof.anchor !== JSON.stringify(completed) || proof.inventory !== fingerprint)
        return { kind: "outcome_unknown", operationId, stage: "publishing" };
      return readyOf(operationId, completed.vaultId, completed.profileSlug);
    }
    return { kind: "not_found", operationId };
  };
  const current = async (
    _params: NativeCreationCurrentParams,
  ): Promise<NativeCreationCurrentResult> => {
    assertLock();
    const state = journal.snapshot();
    if (state.pending)
      return {
        kind: active ? "pending" : "outcome_unknown",
        operationId: state.pending.operationId,
        stage: state.pending.stage,
      };
    const last = state.completed.at(-1);
    if (!last) return { kind: "none" };
    return (await inspect({ operationId: last.operationId })) as NativeCreationCurrentResult;
  };

  const prepare = async (
    raw: NativeCreationPrepareParams,
  ): Promise<NativeCreationPrepareResult> => {
    assertLock();
    clearExpired();
    if (active || journal.snapshot().pending) return REFUSED("pending_exists");
    try {
      assertSourceAdmission();
    } catch {
      wipe(prepared);
      prepared = null;
      clearTimer();
      return REFUSED("setup_unavailable");
    }
    const parsed = nativeCreationPrepareParamsSchema.safeParse(raw);
    if (!parsed.success) return REFUSED("invalid_input");
    try {
      classifyNativeCreationStartup(dataDir);
    } catch {
      return REFUSED("setup_unavailable");
    }
    const modules = cleanModules(builtinRegistry(), parsed.data.modules);
    if (!modules.ok) return REFUSED("invalid_input");
    const input = parsed.data;
    const sodium = options.sodium ?? (await crypto.loadNodeSodium());
    assertLock();
    try {
      assertSourceAdmission();
    } catch {
      wipe(prepared);
      prepared = null;
      clearTimer();
      return REFUSED("setup_unavailable");
    }
    if (journal.snapshot().pending) return REFUSED("pending_exists");
    let inventory: ReturnType<typeof existingInventory>;
    try {
      inventory = existingInventory(dataDir);
    } catch {
      return REFUSED("setup_unavailable");
    }
    if (inventory.length >= 64) return REFUSED("setup_unavailable");
    // An explicit new prepare may discard an earlier memory-only phrase. No durable effect exists.
    wipe(prepared);
    prepared = null;
    clearTimer();
    const operationId = randomBytes(16).toString("hex");
    const phraseSession = randomBytes(16).toString("hex");
    const recoveryKey = crypto.createRecoveryKey(sodium);
    const recovery = crypto.recoveryIdentity(sodium, recoveryKey.phrase);
    const identity = crypto.createDeviceIdentity(sodium);
    const created = crypto.createVaultWithRecovery(sodium, recovery, identity);
    if (
      inventory.some(
        (entry) => entry.vaultId === created.ring.vaultId || entry.deviceId === identity.deviceId,
      )
    ) {
      identity.wipe();
      recovery.wipe();
      created.ring.wipe();
      return REFUSED("operation_conflict");
    }
    const expiresAt = now() + PREPARE_TTL_MS;
    prepared = {
      operationId,
      phraseSession,
      expiresAt,
      input,
      enabledModules: [...modules.value],
      inputHash: creationInputHash(operationId, input, modules.value),
      identity,
      recovery,
      created,
    };
    expiryTimer = setTimeout(() => {
      // The timer is monotonic elapsed time. A wall-clock rollback must not extend secret lifetime.
      if (prepared?.operationId === operationId) {
        wipe(prepared);
        prepared = null;
      }
      expiryTimer = null;
    }, PREPARE_TTL_MS);
    expiryTimer.unref?.();
    return {
      kind: "prepared",
      operationId,
      phraseSession,
      words: recoveryKey.phrase.reveal(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  };

  const commitEffects = async (item: Prepared): Promise<NativeCreationCommitResult> => {
    try {
      assertSourceAdmission();
    } catch {
      return REFUSED("setup_unavailable");
    }
    const { operationId, input, identity, recovery, created } = item;
    const vaultId = created.ring.vaultId;
    const deviceId = identity.deviceId;
    const vaultRoot = join(dataDir, "vaults", vaultId);
    const checkTarget = () => {
      assertSourceAdmission();
      journal.assertPending(operationId, vaultId, deviceId);
      if (existsSync(vaultRoot)) throw new Error("native_creation_target_not_empty");
      if (
        existingInventory(dataDir).some(
          (entry) => entry.vaultId === vaultId || entry.deviceId === deviceId,
        )
      )
        throw new Error("native_creation_target_not_empty");
    };
    if (existsSync(vaultRoot)) return REFUSED("unsafe_target");
    if (journal.snapshot().pending) return REFUSED("pending_exists");
    const initialInventory = existingInventory(dataDir);
    if (initialInventory.some((entry) => entry.vaultId === vaultId || entry.deviceId === deviceId))
      return REFUSED("unsafe_target");
    const pending: Omit<PendingCreation, "stage"> = {
      operationId,
      vaultId,
      deviceId,
      inputHash: item.inputHash,
    };
    journal.begin(pending);
    try {
      options.faultAfterPhase?.("recorded");
      const sodium = options.sodium ?? (await crypto.loadNodeSodium());
      const advance = (stage: CreationStage) => {
        assertSourceAdmission();
        journal.advance(operationId, stage);
        options.faultAfterPhase?.(stage);
      };
      let pinEid = "";
      let effectHash = "";
      let eventCount = 0;
      const provision = makeKeyStore({
        dataDir,
        purpose: "provision",
        sodium,
        authorizedNames: new Set([
          crypto.keyringName(vaultId),
          crypto.deviceIdentityName(deviceId),
        ]),
        provision: { lock, assertPending: checkTarget },
      });
      await crypto.saveKeyring(provision, created.ring);
      assertSourceAdmission();
      await crypto.saveDeviceIdentity(provision, identity);
      advance("keys");
      const vaults = ensureChild(dataDir, "vaults");
      const root = newChild(vaults, vaultId);
      const log = newChild(root, "log");
      newChild(root, "strategy");
      privateNewFile(
        join(root, NATIVE_CERTIFICATES),
        canonicalArtifact({
          format: 1,
          vaultId,
          deviceId,
          certificates: [Buffer.from(created.creatorCertificate).toString("base64url")],
        }),
      );
      privateNewFile(
        join(root, "recovery-wrap.v1"),
        canonicalArtifact({
          format: 1,
          vaultId,
          wrap: Buffer.from(created.recoveryWrap).toString("base64url"),
        }),
      );
      const persistedWrap = readNativeRecoveryWrap(dataDir, vaultId);
      if (
        !crypto.verifyWrapSignature(
          persistedWrap,
          vaultId,
          crypto.recoveryRecipient(created.ring),
          crypto.RECOVERY_SIGNER_ID,
          created.ring.recovery.signPublicKey,
        )
      )
        throw new Error("native_creation_wrap_invalid");
      advance("artifacts");
      privateNewFile(join(root, "private.db"), new Uint8Array());
      privateNewFile(join(root, "view.db"), new Uint8Array());
      const meta = openNodeSqlite(join(root, "private.db"), { exclusive: lock });
      let store: Store | undefined;
      let candidate: Awaited<ReturnType<typeof loadDeviceAuthority>> | undefined;
      let engine: Awaited<ReturnType<typeof createSyncEngine>> | undefined;
      try {
        meta.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
        const provenance = SqlProvenanceStore.open(meta, created.ring, "new");
        provenance.put({
          kid: created.ring.active.kid,
          generation: created.ring.active.generation,
          epoch: created.ring.active.epoch,
          sender: deviceId,
          recipients: null,
          source: "own",
          receivedAt: now(),
        });
        SqlAttemptJournal.open(meta, "new", now);
        const saltKey = created.ring.gidSalt();
        const salt = vaultSalt(saltKey.expose().slice());
        saltKey.wipe();
        store = Store.open({
          driver: openNodeSqlite(join(root, "view.db"), { exclusive: lock }),
          vault: vaultId,
          salt,
          modules: builtinModules(),
        });
        initializeNativeClockGuard(store.driver, deviceId);
        const openKeyStore = makeKeyStore({
          dataDir,
          purpose: "open",
          sodium,
          authorizedNames: new Set([
            crypto.keyringName(vaultId),
            crypto.deviceIdentityName(deviceId),
          ]),
        });
        const entry = {
          vaultId,
          deviceId,
          vaultRoot: root,
          state: "ready" as const,
          enrollment: "creator" as const,
        };
        candidate = await loadDeviceAuthority({
          entry,
          dataDir,
          keyStore: openKeyStore,
          sodium,
          provenance,
          clock: now,
          bootstrapCertificates: [created.creatorCertificate],
        });
        assertSourceAdmission();
        engine = await createSyncEngine({
          vault: vaultId,
          device: deviceId,
          local: new FolderTransport({ fs: new NodeFolderFs(log) }),
          remotes: [],
          codec: createOwnLogCodec({ sodium, ring: candidate.ring, signer: candidate.identity }),
          gate: candidate.gate,
          sink: store.sink(),
          clockStore: metaClockStore(store.driver, deviceId),
          clockGuard: nativeClockGuard(store.driver, deviceId),
          gateState: metaGateStateStore(store.driver, deviceId),
          gossipEid: () => mintUlid(now(), (n) => sodium.randomBytes(n)),
        });
        assertSourceAdmission();
        const eid = () => mintUlid(now(), (n) => sodium.randomBytes(n));
        const addedEid = eid();
        pinEid = eid();
        await engine.write([
          devices.buildDeviceAdded(
            identity,
            vaultId,
            addedEid,
            {
              deviceId,
              signPublicKey: identity.signPublicKey,
              boxPublicKey: identity.box.publicKey,
            },
            input.deviceAlias ?? "creator",
            created.creatorCertificate,
          ),
          devices.creatorPin(identity, recovery, vaultId, pinEid, now()),
        ]);
        assertSourceAdmission();
        const preparedProfile = prepareCommand(store, createProfile, input, {
          device: deviceId,
          clock: { now },
          // Create profile is not a fetch-leader command. Never claim a leader lease here.
          lease: { isHolder: () => false },
        });
        if (!preparedProfile.ok) throw new Error("native_creation_profile_refused");
        await engine.write(preparedProfile.events.map(toUnstampedEvent));
        assertSourceAdmission();
        const recoveryResult = await engine.recoverLocal();
        assertSourceAdmission();
        verifyProfile(store, input, vaultId, preparedProfile.value.modules);
        assertReplayedDeviceAuthority(candidate, recoveryResult, vaultId);
        const lease = candidate.devices.lease;
        if (
          lease.mode !== "pinned" ||
          lease.pinned !== deviceId ||
          lease.holder !== deviceId ||
          !lease.pin ||
          lease.head !== lease.pin.eid
        )
          throw new Error("native_creation_pin_mismatch");
        if (lease.pin.eid !== pinEid) throw new Error("native_creation_pin_mismatch");
        eventCount = 1 + item.enabledModules.length;
        const initial = store.foreignEvents(0, new Set(), eventCount).events;
        if (initial.length !== eventCount || initial[0]?.type !== "profile.created")
          throw new Error("native_creation_profile_mismatch");
        effectHash = creationEffectHash(initial, pinEid, deviceId);
        advance("history");
      } finally {
        await engine?.close();
        store?.close();
        candidate?.close();
        meta.close();
      }
      advance("admission");
      const openStore = makeKeyStore({
        dataDir,
        purpose: "open",
        sodium,
        authorizedNames: new Set([
          crypto.keyringName(vaultId),
          crypto.deviceIdentityName(deviceId),
        ]),
      });
      const entry = {
        vaultId,
        deviceId,
        vaultRoot: root,
        state: "ready" as const,
        enrollment: "creator" as const,
      };
      const source: NativeVaultSource = {
        inventory: [entry],
        keyStore: openStore,
        sodium,
        bootstrapCertificates: async () => [created.creatorCertificate.slice()],
      };
      const session = await openNativeVault(entry, dataDir, source, takeWriterLease(lock), now);
      try {
        assertSourceAdmission();
        verifyProfile(session.store, input, vaultId, item.enabledModules);
      } finally {
        await session.close();
      }
      advance("publishing");
      const version = join(dataDir, "native", "v1");
      privateDirectory(version);
      const inventoryPath = join(dataDir, NATIVE_INVENTORY);
      const currentEntries = existingInventory(dataDir);
      if (
        currentEntries.length !== initialInventory.length ||
        currentEntries.some((entry, index) => entry.vaultId !== initialInventory[index]?.vaultId)
      )
        throw new Error("native_creation_inventory_changed");
      assertSourceAdmission();
      privateAtomicFile(
        inventoryPath,
        canonicalArtifact({
          format: 1,
          vaults: [...currentEntries, entry].map(({ vaultId, deviceId, state, enrollment }) => ({
            vaultId,
            deviceId,
            state,
            enrollment,
          })),
        }),
      );
      const factory = new ProductionVaultSourceFactory(dataDir, makeKeyStore);
      factory.preflight();
      const production = await factory.open(lock);
      assertSourceAdmission();
      const published = production.inventory.find((candidate) => candidate.vaultId === vaultId);
      if (!published) throw new Error("native_creation_inventory_changed");
      const reopened = await openNativeVault(
        published,
        dataDir,
        production,
        takeWriterLease(lock),
        now,
      );
      try {
        verifyProfile(reopened.store, input, vaultId, item.enabledModules);
      } finally {
        await reopened.close();
      }
      assertSourceAdmission();
      const anchor = journal.complete(operationId, input.slug, eventCount, pinEid, effectHash);
      verified.set(operationId, {
        anchor: JSON.stringify(anchor),
        inventory: readExistingNativeInventory(dataDir).fingerprint,
      });
      return readyOf(operationId, vaultId, input.slug);
    } catch {
      const stage = journal.snapshot().pending?.stage ?? "recorded";
      return { kind: "outcome_unknown", operationId, stage };
    }
  };

  const commit = async (
    params: NativeCreationCommitParams,
  ): Promise<NativeCreationCommitResult> => {
    assertLock();
    if (active) return REFUSED("pending_exists");
    if (prepared && now() >= prepared.expiresAt) {
      wipe(prepared);
      prepared = null;
      clearTimer();
      return REFUSED("prepare_expired");
    }
    if (!prepared) {
      return journal.snapshot().pending?.operationId === params.operationId
        ? {
            kind: "outcome_unknown",
            operationId: params.operationId,
            stage: journal.snapshot().pending?.stage ?? "recorded",
          }
        : REFUSED("prepare_missing");
    }
    if (
      prepared.operationId !== params.operationId ||
      prepared.phraseSession !== params.phraseSession
    )
      return REFUSED("operation_conflict");
    if (now() >= prepared.expiresAt) {
      wipe(prepared);
      prepared = null;
      return REFUSED("prepare_expired");
    }
    try {
      assertSourceAdmission();
    } catch {
      wipe(prepared);
      prepared = null;
      clearTimer();
      return REFUSED("setup_unavailable");
    }
    const item = prepared;
    prepared = null;
    clearTimer();
    active = commitEffects(item);
    try {
      return await active;
    } finally {
      active = null;
      wipe(item);
    }
  };

  return {
    prepare,
    commit,
    inspect,
    current,
    primeVerifiedCompleted,
    pending: () => (active ? 1 : 0),
    drain: async () => {
      try {
        await active;
      } finally {
        clearTimer();
        wipe(prepared);
        prepared = null;
        verified.clear();
      }
    },
  };
}
