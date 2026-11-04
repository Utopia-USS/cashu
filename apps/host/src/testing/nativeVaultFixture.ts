// Synthetic encrypted vault with genuine creator authority for native host socket tests.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFolderFs } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  createProfile,
  metaClockStore,
  metaGateStateStore,
  prepareCommand,
  Store,
  toUnstampedEvent,
  vaultSalt,
} from "@cashu/store";
import { createOwnLogCodec, createSyncEngine, crypto, devices, FolderTransport } from "@cashu/sync";
import { InMemoryKeyStore } from "@cashu/sync/testing";
import { SqlAttemptJournal } from "../attemptJournal.js";
import { initializeNativeClockGuard, nativeClockGuard } from "../market/clockGuard.js";
import {
  loadDeviceAuthority,
  type NativeVaultInventoryEntry,
} from "../sync/keys/deviceAuthority.js";
import { SqlProvenanceStore } from "../sync/keys/sqlProvenance.js";

export interface NativeVaultFixture {
  readonly dataDir: string;
  readonly home: string;
  readonly vaultId: string;
  readonly profileSlug: string;
  readonly recoveryWords: string;
  readonly peerDevice?: string;
  /** Synthetic test key only; never exposed by production sources. */
  readonly peerIdentity?: crypto.DeviceIdentity;
  readonly peerCertificate?: Uint8Array;
  readonly vaultSource: {
    readonly kind: "native";
    readonly provider: {
      readonly inventory: readonly NativeVaultInventoryEntry[];
      readonly keyStore: InMemoryKeyStore;
      readonly sodium: crypto.Sodium;
      bootstrapCertificates(): Promise<readonly Uint8Array[]>;
    };
  };
  cleanup(): void;
}

export async function nativeVaultFixture(
  options: {
    readonly modules?: readonly string[];
    readonly profileSlug?: string;
    readonly pairPeer?: boolean;
    /** Clock for the creator log; a host started with a fixed `now` must stamp from the same one. */
    readonly now?: () => number;
  } = {},
): Promise<NativeVaultFixture> {
  const now = options.now ?? Date.now;
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "cashu-native-fixture-")));
  const home = join(dataDir, "test-home");
  mkdirSync(home);
  const sodium = await crypto.loadNodeSodium();
  const identity = crypto.createDeviceIdentity(sodium);
  const recoveryPhrase = crypto.createRecoveryKey(sodium).phrase;
  const recoveryWords = recoveryPhrase.reveal();
  const recovery = crypto.recoveryIdentity(sodium, recoveryPhrase);
  const peer = options.pairPeer ? crypto.createDeviceIdentity(sodium) : undefined;
  const created = crypto.createVaultWithRecovery(sodium, recovery, identity);
  const vaultId = created.ring.vaultId;
  const profileSlug = options.profileSlug ?? "synthetic";
  const vaultRoot = join(dataDir, "vaults", vaultId);
  const log = join(vaultRoot, "log");
  mkdirSync(log, { recursive: true, mode: 0o700 });
  chmodSync(join(dataDir, "vaults"), 0o700);
  chmodSync(vaultRoot, 0o700);
  chmodSync(log, 0o700);
  mkdirSync(join(vaultRoot, "strategy"), { mode: 0o700 });
  writeFileSync(
    join(vaultRoot, "certificates.v1.json"),
    JSON.stringify({
      format: 1,
      vaultId,
      deviceId: identity.deviceId,
      certificates: [Buffer.from(created.creatorCertificate).toString("base64url")],
    }),
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(
    join(vaultRoot, "recovery-wrap.v1"),
    JSON.stringify({
      format: 1,
      vaultId,
      wrap: Buffer.from(created.recoveryWrap).toString("base64url"),
    }),
    { flag: "wx", mode: 0o600 },
  );
  const entry: NativeVaultInventoryEntry = {
    vaultId,
    deviceId: identity.deviceId,
    vaultRoot,
    state: "ready",
    enrollment: "creator",
  };
  const keyStore = new InMemoryKeyStore();
  const certificate = created.creatorCertificate.slice();
  let meta: ReturnType<typeof openNodeSqlite> | undefined;
  let store: Store | undefined;
  let candidate: Awaited<ReturnType<typeof loadDeviceAuthority>> | undefined;
  let engine: Awaited<ReturnType<typeof createSyncEngine>> | undefined;
  try {
    await crypto.saveKeyring(keyStore, created.ring);
    await crypto.saveDeviceIdentity(keyStore, identity);
    meta = openNodeSqlite(join(vaultRoot, "private.db"));
    const provenance = SqlProvenanceStore.open(meta, created.ring, "new");
    provenance.put({
      kid: created.ring.active.kid,
      generation: created.ring.active.generation,
      epoch: created.ring.active.epoch,
      sender: identity.deviceId,
      recipients: null,
      source: "own",
      receivedAt: now(),
    });
    SqlAttemptJournal.open(meta, "new", now);
    const saltKey = created.ring.gidSalt();
    const salt = vaultSalt(saltKey.expose().slice());
    saltKey.wipe();
    store = Store.open({
      driver: openNodeSqlite(join(vaultRoot, "view.db")),
      vault: vaultId,
      salt,
      modules: builtinModules(),
    });
    initializeNativeClockGuard(store.driver, identity.deviceId);
    candidate = await loadDeviceAuthority({
      entry,
      dataDir,
      keyStore,
      sodium,
      provenance,
      clock: now,
      bootstrapCertificates: [certificate],
    });
    engine = await createSyncEngine({
      vault: vaultId,
      device: entry.deviceId,
      local: new FolderTransport({ fs: new NodeFolderFs(log) }),
      remotes: [],
      codec: createOwnLogCodec({
        sodium,
        ring: candidate.ring,
        signer: candidate.identity,
      }),
      gate: candidate.gate,
      sink: store.sink(),
      clockStore: metaClockStore(store.driver, entry.deviceId),
      clockGuard: nativeClockGuard(store.driver, entry.deviceId),
      gateState: metaGateStateStore(store.driver, entry.deviceId),
      physicalClock: { now },
    });
    const subject = {
      deviceId: identity.deviceId,
      signPublicKey: identity.signPublicKey,
      boxPublicKey: identity.box.publicKey,
    };
    await engine.write([
      devices.buildDeviceAdded(
        identity,
        vaultId,
        "01K9B2W0000000000000000000",
        subject,
        "creator",
        certificate,
      ),
      devices.creatorPin(identity, recovery, vaultId, "01K9B2W0000000000000000001", now()),
    ]);
    const prepared = prepareCommand(
      store,
      createProfile,
      {
        slug: profileSlug,
        name: "Synthetic",
        modules: options.modules ?? ["budget", "investments"],
      },
      { device: entry.deviceId, clock: { now }, lease: { isHolder: () => true } },
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    await engine.write(prepared.events.map(toUnstampedEvent));
    let peerCertificate: Uint8Array | undefined;
    if (peer) {
      const peerSubject = {
        deviceId: peer.deviceId,
        signPublicKey: peer.signPublicKey,
        boxPublicKey: peer.box.publicKey,
      };
      peerCertificate = crypto.certifyDevice(sodium, identity, peerSubject, vaultId);
      await engine.write([
        devices.buildDeviceAdded(
          identity,
          vaultId,
          "01K9B2W0000000000000000003",
          peerSubject,
          "synthetic peer",
          peerCertificate,
        ),
      ]);
    }
    await engine.close();
    engine = undefined;
    store.close();
    store = undefined;
    candidate.close();
    candidate = undefined;
    meta.close();
    meta = undefined;
    return {
      dataDir,
      home,
      vaultId,
      profileSlug,
      recoveryWords,
      ...(peer ? { peerDevice: peer.deviceId } : {}),
      ...(peer ? { peerIdentity: peer } : {}),
      ...(peerCertificate ? { peerCertificate } : {}),
      vaultSource: {
        kind: "native",
        provider: {
          inventory: [entry],
          keyStore,
          sodium,
          bootstrapCertificates: async () => [certificate],
        },
      },
      cleanup() {
        peer?.wipe();
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await engine?.close();
    store?.close();
    candidate?.close();
    meta?.close();
    peer?.wipe();
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  } finally {
    identity.wipe();
    recovery.wipe();
    created.ring.wipe();
  }
}
