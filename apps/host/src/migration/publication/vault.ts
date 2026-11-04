import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type HostLock, NodeFolderFs } from "@cashu/node-host";
import { createProductionKeyStore } from "@cashu/node-host/keyring";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  metaClockStore,
  metaGateStateStore,
  mintUlid,
  Store,
  viewHash,
} from "@cashu/store";
import type * as genesis from "@cashu/store/genesis";
import {
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_FRAME_EVENTS,
  devices,
  FolderTransport,
  FRAME_FORMAT,
  MAX_SEALED_FRAME_BYTES,
} from "@cashu/sync";
import { SqlAttemptJournal } from "../../attemptJournal.js";
import { takeWriterLease } from "../../lease.js";
import { initializeNativeClockGuard, nativeClockGuard } from "../../market/clockGuard.js";
import { type NativeVaultSource, openNativeVault } from "../../nativeVault.js";
import {
  assertReplayedDeviceAuthority,
  loadDeviceAuthority,
} from "../../sync/keys/deviceAuthority.js";
import { SqlProvenanceStore } from "../../sync/keys/sqlProvenance.js";
import { MigrationError } from "../contract.js";
import type { SemanticReplayProof } from "../verify.js";
import type { MigrationVaultIdentity } from "./identity.js";
import { latestStrategyTexts, writeMigratedStrategy } from "./strategy.js";

const MAX_ARTIFACT = 32 * 1024;

function privateDir(path: string, existing = false): void {
  if (!existing) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new MigrationError("identity_invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function privateFile(path: string, bytes: Uint8Array): void {
  if (bytes.length > MAX_ARTIFACT) throw new MigrationError("identity_invalid");
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    for (let offset = 0; offset < bytes.length; ) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new MigrationError("identity_invalid");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

const FRAME_WRAPPER_BYTES = Buffer.byteLength(JSON.stringify({ f: FRAME_FORMAT, e: [] }));

/** Preserve one fixed-W genesis chunk per engine frame, including UTF-8 and envelope overhead. */
export function chunkGenesisEvents(events: readonly genesis.GenesisVault["events"][number][]) {
  const out: (typeof events)[number][][] = [];
  let chunk: (typeof events)[number][] = [];
  let utf8Bytes = FRAME_WRAPPER_BYTES;
  let engineBytes = 0;
  for (const event of events) {
    const json = JSON.stringify(event);
    const utf8 = Buffer.byteLength(json);
    const plain = utf8Bytes + utf8 + (chunk.length ? 1 : 0);
    const engine = engineBytes + json.length;
    if (
      chunk.length &&
      (chunk.length >= DEFAULT_MAX_FRAME_EVENTS ||
        plain > DEFAULT_MAX_FRAME_BYTES ||
        engine > DEFAULT_MAX_FRAME_BYTES)
    ) {
      out.push(chunk);
      chunk = [];
      utf8Bytes = FRAME_WRAPPER_BYTES;
      engineBytes = 0;
    }
    const nextPlain = utf8Bytes + utf8 + (chunk.length ? 1 : 0);
    if (
      nextPlain > DEFAULT_MAX_FRAME_BYTES ||
      nextPlain > crypto.MAX_FRAME_PLAINTEXT ||
      crypto.frameSize(nextPlain) > MAX_SEALED_FRAME_BYTES ||
      json.length > DEFAULT_MAX_FRAME_BYTES
    )
      throw new MigrationError("replay_mismatch");
    chunk.push(event);
    utf8Bytes = nextPlain;
    engineBytes += json.length;
  }
  if (chunk.length) out.push(chunk);
  return out;
}

/**
 * Writes the existing genesis pseudo-device protocol into the final physical vault namespace.
 * The caller owns a fresh target and holds its HostLock through this call.
 */
export async function writeEncryptedMigrationVault(input: {
  readonly dataDir: string;
  readonly lock: HostLock;
  readonly sodium: crypto.Sodium;
  readonly identity: MigrationVaultIdentity;
  readonly genesis: genesis.GenesisVault;
  readonly proof: SemanticReplayProof;
  readonly recovery: crypto.RecoveryIdentity;
  readonly now: () => number;
  /** Strict synthetic OS KeyStore only in tests. */
  readonly makeKeyStore?: typeof createProductionKeyStore;
}): Promise<{
  readonly vaultId: string;
  readonly viewHash: string;
}> {
  const { dataDir, lock, sodium, identity, genesis: exported, proof, recovery, now } = input;
  const eventChunks = chunkGenesisEvents(exported.events);
  if (
    !lock.held ||
    exported.vault !== identity.created.ring.vaultId ||
    exported.device !== identity.genesis.identity.deviceId ||
    exported.ordinal !== identity.ordinal
  )
    throw new MigrationError("identity_invalid");
  const expected = proof.vaults.find((vault) => vault.ordinal === identity.ordinal);
  if (!expected) throw new MigrationError("replay_mismatch");
  const vaultId = identity.created.ring.vaultId;
  const deviceId = identity.creator.deviceId;
  const vaultsRoot = join(dataDir, "vaults");
  const root = join(vaultsRoot, vaultId);
  const logRoot = join(root, "log");
  if (!lock.held) throw new MigrationError("identity_invalid");
  try {
    privateDir(vaultsRoot, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    privateDir(vaultsRoot);
  }
  privateDir(root);
  privateDir(logRoot);
  privateDir(join(root, "strategy"));
  const certificates = [identity.created.creatorCertificate, identity.genesis.certificate];
  privateFile(
    join(root, "certificates.v1.json"),
    Buffer.from(
      JSON.stringify({
        format: 1,
        vaultId,
        deviceId,
        certificates: certificates.map((cert) => Buffer.from(cert).toString("base64url")),
      }),
    ),
  );
  privateFile(join(root, "private.db"), new Uint8Array());
  privateFile(join(root, "view.db"), new Uint8Array());
  const make = input.makeKeyStore ?? createProductionKeyStore;
  const names = new Set([crypto.keyringName(vaultId), crypto.deviceIdentityName(deviceId)]);
  const keyStore = make({ dataDir, purpose: "open", authorizedNames: names, sodium });
  const meta = openNodeSqlite(join(root, "private.db"), { exclusive: lock });
  let store: Store | undefined;
  let candidate: Awaited<ReturnType<typeof loadDeviceAuthority>> | undefined;
  try {
    meta.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    const provenance = SqlProvenanceStore.open(meta, identity.created.ring, "new");
    provenance.put({
      kid: identity.created.ring.active.kid,
      generation: identity.created.ring.active.generation,
      epoch: identity.created.ring.active.epoch,
      sender: deviceId,
      recipients: null,
      source: "own",
      receivedAt: now(),
    });
    SqlAttemptJournal.open(meta, "new", now);
    store = Store.open({
      driver: openNodeSqlite(join(root, "view.db"), { exclusive: lock }),
      vault: vaultId,
      salt: identity.salt,
      modules: builtinModules(),
    });
    initializeNativeClockGuard(store.driver, deviceId);
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
      keyStore,
      sodium,
      provenance,
      clock: now,
      bootstrapCertificates: certificates,
    });
    if (!lock.held) throw new MigrationError("identity_invalid");
    const activeCandidate = candidate;
    const activeStore = store;
    const local = new FolderTransport({ fs: new NodeFolderFs(logRoot) });
    const eid = (ms: number) => mintUlid(ms, (n) => sodium.randomBytes(n));
    const genesisEngine = (wall: number) =>
      createSyncEngine({
        vault: vaultId,
        device: identity.genesis.identity.deviceId,
        local,
        remotes: [],
        codec: createOwnLogCodec({
          sodium,
          ring: activeCandidate.ring,
          signer: identity.genesis.identity,
        }),
        gate: activeCandidate.gate,
        sink: activeStore.sink(),
        clockStore: metaClockStore(activeStore.driver, identity.genesis.identity.deviceId),
        physicalClock: { now: () => wall },
      });
    const intro = await genesisEngine(exported.wall - 1);
    try {
      if (!lock.held) throw new MigrationError("identity_invalid");
      await intro.write([
        devices.genesisAnnouncement(identity.genesis, vaultId, eid(exported.wall - 1)),
      ]);
    } finally {
      await intro.close();
    }
    const writer = await genesisEngine(exported.wall);
    try {
      for (const chunk of eventChunks) {
        if (!lock.held) throw new MigrationError("identity_invalid");
        const unstamped = chunk.map(({ h: _h, ...rest }) => rest);
        const result = await writer.write(unstamped);
        if (result.first !== chunk[0]?.h || result.last !== chunk.at(-1)?.h || result.frames !== 1)
          throw new MigrationError("replay_mismatch");
      }
      if (!lock.held) throw new MigrationError("identity_invalid");
      await writer.write([
        devices.retireGenesis(identity.genesis, vaultId, eid(exported.wall)).event,
      ]);
    } finally {
      await writer.close();
      identity.genesis.identity.wipe();
    }
    if (
      !candidate.devices.registry.revoked.has(identity.genesis.identity.deviceId) ||
      candidate.devices.registry.revocationCount !== 1
    )
      throw new MigrationError("replay_mismatch");
    const rotated = crypto.rotateKeyring(sodium, candidate.ring, { epoch: 1 });
    provenance.put({
      kid: rotated.kid,
      generation: rotated.generation,
      epoch: rotated.epoch,
      sender: deviceId,
      recipients: null,
      source: "own",
      receivedAt: now(),
    });
    await crypto.saveKeyring(keyStore, candidate.ring);
    if (!lock.held) throw new MigrationError("identity_invalid");
    const wrap = crypto.wrapKeys(
      sodium,
      candidate.ring,
      recovery,
      crypto.recoveryRecipient(candidate.ring),
    );
    privateFile(
      join(root, "recovery-wrap.v1"),
      Buffer.from(
        JSON.stringify({
          format: 1,
          vaultId,
          wrap: Buffer.from(wrap).toString("base64url"),
        }),
      ),
    );
    const creator = await createSyncEngine({
      vault: vaultId,
      device: deviceId,
      local,
      remotes: [],
      codec: createOwnLogCodec({ sodium, ring: candidate.ring, signer: candidate.identity }),
      gate: candidate.gate,
      sink: store.sink(),
      clockStore: metaClockStore(store.driver, deviceId),
      clockGuard: nativeClockGuard(store.driver, deviceId),
      gateState: metaGateStateStore(store.driver, deviceId),
      gossipEid: () => mintUlid(now(), (n) => sodium.randomBytes(n)),
    });
    try {
      if (!lock.held) throw new MigrationError("identity_invalid");
      await creator.write([
        devices.buildDeviceAdded(
          identity.creator,
          vaultId,
          eid(now()),
          {
            deviceId,
            signPublicKey: identity.creator.signPublicKey,
            boxPublicKey: identity.creator.box.publicKey,
          },
          "creator",
          identity.created.creatorCertificate,
        ),
        devices.creatorPin(identity.creator, recovery, vaultId, eid(now()), now()),
      ]);
      const replay = await creator.recoverLocal();
      assertReplayedDeviceAuthority(candidate, replay, vaultId);
    } finally {
      await creator.close();
    }
    const digest = viewHash(store).hash;
    if (digest !== expected.viewHash) throw new MigrationError("replay_mismatch");
  } finally {
    store?.close();
    candidate?.close();
    meta.close();
  }
  if (!lock.held) throw new MigrationError("identity_invalid");
  const entry = {
    vaultId,
    deviceId,
    vaultRoot: root,
    state: "ready" as const,
    enrollment: "creator" as const,
  };
  const source: NativeVaultSource = {
    inventory: [entry],
    keyStore,
    sodium,
    bootstrapCertificates: async () => certificates.map((cert) => cert.slice()),
  };
  const reopened = await openNativeVault(entry, dataDir, source, takeWriterLease(lock), now);
  let reopenedHash: string;
  try {
    reopenedHash = viewHash(reopened.store).hash;
    if (reopenedHash !== expected.viewHash) throw new MigrationError("replay_mismatch");
    // The native app reads the strategy only from these files: the newest version, byte for byte.
    if (!lock.held) throw new MigrationError("identity_invalid");
    writeMigratedStrategy({
      vaultId,
      vaultRoot: root,
      texts: latestStrategyTexts(exported),
      isCurrent: () => lock.held,
    });
  } finally {
    await reopened.close();
  }
  if (!lock.held) throw new MigrationError("identity_invalid");
  return { vaultId, viewHash: reopenedHash };
}
