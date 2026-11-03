import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { NativeCreationPrepareParams } from "@cashu/host-protocol";
import { type HostLock, NodeFolderFs } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { builtinModules, metaClockStore, metaGateStateStore, Store, vaultSalt } from "@cashu/store";
import {
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  FolderTransport,
  type Transport,
} from "@cashu/sync";
import { readNativeRecoveryWrap } from "./nativeCreationArtifacts.js";
import type { CompletedCreation } from "./nativeCreationJournal.js";
import { ProductionVaultSourceFactory } from "./productionVaultSource.js";
import { assertReplayedDeviceAuthority, loadDeviceAuthority } from "./sync/keys/deviceAuthority.js";
import { SqlProvenanceStore } from "./sync/keys/sqlProvenance.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function creationInputHash(
  operationId: string,
  input: Pick<NativeCreationPrepareParams, "name" | "slug" | "baseCurrency" | "mcpPrivacy">,
  enabledModules: readonly string[],
): string {
  return sha(
    `${operationId}:${JSON.stringify({
      name: input.name,
      slug: input.slug,
      baseCurrency: input.baseCurrency,
      mcpPrivacy: input.mcpPrivacy,
      modules: [...enabledModules].sort(),
    })}`,
  );
}

export function creationEffectHash(
  initial: readonly Readonly<Record<string, unknown>>[],
  pinEid: string,
  deviceId: string,
): string {
  return sha(JSON.stringify({ initial, pinEid, deviceId }));
}

function existingFile(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    realpathSync(path) !== path ||
    (stat.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new Error("native_creation_proof_unavailable");
}

/** A replay-only carrier. Even an accidental engine write cannot touch the original log. */
function readOnlyTransport(log: string): Transport {
  const source = new FolderTransport({ fs: new NodeFolderFs(log) });
  return {
    consistency: source.consistency,
    list: (vault) => source.list(vault),
    read: (vault, device, seg, fromOffset) => source.read(vault, device, seg, fromOffset),
    append: async () => {
      throw new Error("native_creation_read_only");
    },
  };
}

/** Replays signed local bytes into memory. It never opens original SQLite views for writing. */
export async function verifyCompletedNativeCreation(
  dataDir: string,
  lock: HostLock,
  anchor: CompletedCreation,
  makeKeyStore: typeof import("@cashu/node-host/keyring").createProductionKeyStore,
  now: () => number,
): Promise<boolean> {
  let meta: ReturnType<typeof openNodeSqlite> | undefined;
  let view: ReturnType<typeof openNodeSqlite> | undefined;
  let memoryMeta: ReturnType<typeof openNodeSqlite> | undefined;
  let scratch: Store | undefined;
  let candidate: Awaited<ReturnType<typeof loadDeviceAuthority>> | undefined;
  let engine: Awaited<ReturnType<typeof createSyncEngine>> | undefined;
  let ring: crypto.Keyring | null = null;
  const fail = (_code: string) => false;
  try {
    if (!lock.held) return fail("lock");
    const factory = new ProductionVaultSourceFactory(dataDir, makeKeyStore);
    factory.preflight();
    const source = await factory.open(lock);
    const entry = source.inventory.find((item) => item.vaultId === anchor.vaultId);
    if (!entry || entry.deviceId !== anchor.deviceId || entry.enrollment !== "creator")
      return fail("entry");
    const root = entry.vaultRoot;
    const privatePath = join(root, "private.db");
    const viewPath = join(root, "view.db");
    const logPath = join(root, "log");
    existingFile(privatePath);
    existingFile(viewPath);
    const logStat = lstatSync(logPath);
    if (!logStat.isDirectory() || logStat.isSymbolicLink() || realpathSync(logPath) !== logPath)
      return fail("log_path");
    ring = await crypto.loadKeyring(source.keyStore, source.sodium, anchor.vaultId);
    if (!ring) return fail("ring");
    const wrap = readNativeRecoveryWrap(dataDir, anchor.vaultId);
    if (
      !crypto.verifyWrapSignature(
        wrap,
        anchor.vaultId,
        crypto.recoveryRecipient(ring),
        crypto.RECOVERY_SIGNER_ID,
        ring.recovery.signPublicKey,
      )
    )
      return fail("wrap");
    meta = openNodeSqlite(privatePath, { readOnly: true });
    const diskProvenance = SqlProvenanceStore.open(meta, ring, "existing");
    memoryMeta = openNodeSqlite(":memory:");
    const provenance = SqlProvenanceStore.open(memoryMeta, ring, "new");
    for (const record of diskProvenance.list()) provenance.put(record);
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
    scratch = Store.open({
      driver: openNodeSqlite(":memory:"),
      vault: anchor.vaultId,
      salt,
      modules: builtinModules(),
    });
    view = openNodeSqlite(viewPath, { readOnly: true });
    const recordedClock = metaClockStore(view, anchor.deviceId).load();
    if (!recordedClock) return fail("clock_missing");
    metaClockStore(scratch.driver, anchor.deviceId).save(recordedClock);
    const recordedGate = metaGateStateStore(view, anchor.deviceId);
    const memoryGate = metaGateStateStore(scratch.driver, anchor.deviceId);
    const gateState = recordedGate.load();
    if (gateState !== undefined) memoryGate.save(gateState);
    const evidence = recordedGate.loadEvidence();
    if (evidence.length > 0) memoryGate.appendEvidence(evidence);
    view.close();
    view = undefined;
    engine = await createSyncEngine({
      vault: anchor.vaultId,
      device: anchor.deviceId,
      local: readOnlyTransport(logPath),
      remotes: [],
      codec: createOwnLogCodec({
        sodium: source.sodium,
        ring: candidate.ring,
        signer: candidate.identity,
      }),
      gate: candidate.gate,
      sink: scratch.sink(),
      clockStore: metaClockStore(scratch.driver, anchor.deviceId),
      gateState: metaGateStateStore(scratch.driver, anchor.deviceId),
    });
    const recovered = await engine.recoverLocal();
    if (!recovered.complete || recovered.requiresViewRebuild || recovered.rolledBack) {
      return fail(
        `replay_${recovered.complete ? "complete" : "incomplete"}_${recovered.requiresViewRebuild ? "rebuild" : "norebuild"}_${recovered.rolledBack ? "rollback" : "norollback"}_${recovered.streams.map((stream) => stream.disposition).join("_")}`,
      );
    }
    const rows = scratch.read<{ gid: string }>("SELECT gid FROM profiles");
    assertReplayedDeviceAuthority(
      candidate,
      recovered,
      rows.length === 1 ? rows[0]?.gid : undefined,
    );
    const lease = candidate.devices.lease;
    // The creator's recovery-signed pin remains on the accepted chain after a later legitimate re-pin.
    if (!lease.recoveryPins.includes(anchor.pinEid)) return fail("pin");
    const initial = scratch.foreignEvents(0, new Set(), anchor.eventCount).events;
    if (initial.length !== anchor.eventCount || initial[0]?.type !== "profile.created")
      return fail("events");
    if (creationEffectHash(initial, anchor.pinEid, anchor.deviceId) !== anchor.effectHash)
      return fail("effect_hash");
    const profile = initial[0]?.data;
    if (typeof profile !== "object" || profile === null || Array.isArray(profile))
      return fail("profile_payload");
    const data = profile as Record<string, unknown>;
    const modules = initial.slice(1).map((event) => {
      if (event.type !== "module.enabled" || typeof event.data !== "object" || event.data === null)
        throw new Error("native_creation_proof_unavailable");
      return (event.data as Record<string, unknown>).moduleId;
    });
    if (!modules.every((module): module is string => typeof module === "string"))
      return fail("modules");
    if (
      typeof data.name !== "string" ||
      typeof data.slug !== "string" ||
      typeof data.baseCurrency !== "string" ||
      typeof data.mcpPrivacy !== "string" ||
      data.slug !== anchor.profileSlug ||
      initial[0]?.gid !== anchor.vaultId
    )
      return fail("profile_fields");
    return (
      creationInputHash(
        anchor.operationId,
        {
          name: data.name,
          slug: data.slug,
          baseCurrency: data.baseCurrency as NativeCreationPrepareParams["baseCurrency"],
          mcpPrivacy: data.mcpPrivacy as NativeCreationPrepareParams["mcpPrivacy"],
        },
        modules,
      ) === anchor.inputHash || fail("input_hash")
    );
  } catch {
    return false;
  } finally {
    await engine?.close();
    scratch?.close();
    candidate?.close();
    meta?.close();
    view?.close();
    memoryMeta?.close();
    ring?.wipe();
  }
}
