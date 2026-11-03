import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliExecParams, HostFrame } from "@cashu/host-protocol";
import { acquireHostLock, connectHost, NodeFolderFs } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  createProfile,
  executeDurableCommand,
  metaClockStore,
  metaGateStateStore,
  prepareCommand,
  renameProfile,
  Store,
  toUnstampedEvent,
  vaultSalt,
} from "@cashu/store";
import {
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  devices,
  FolderTransport,
  MemoryClockStore,
  MemoryTransport,
} from "@cashu/sync";
import { InMemoryKeyStore, ManualClock, MemorySink } from "@cashu/sync/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SqlAttemptJournal } from "./attemptJournal.js";
import { startLocalHost } from "./host.js";
import { takeWriterLease } from "./lease.js";
import { openNativeVault } from "./nativeVault.js";
import { loadDeviceAuthority } from "./sync/keys/deviceAuthority.js";
import { SqlProvenanceStore } from "./sync/keys/sqlProvenance.js";
import { storeClient } from "./testing/harness.js";

const sodium = await crypto.loadNodeSodium();
const NOW = Date.UTC(2026, 10, 3, 12);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native vault session", () => {
  it("refuses a symlinked metadata file without opening or changing its target", async () => {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "cashu-native-path-test-")));
    roots.push(dataDir);
    const root = join(dataDir, "vaults", "a".repeat(32));
    mkdirSync(join(root, "log"), { recursive: true });
    const target = join(dataDir, "untouched.db");
    writeFileSync(target, "sentinel", { mode: 0o600 });
    symlinkSync(target, join(root, "private.db"));
    writeFileSync(join(root, "view.db"), "", { mode: 0o600 });
    const lock = acquireHostLock(join(dataDir, "host.lock.db"));
    if (!lock) throw new Error("synthetic lock busy");
    const entry = {
      vaultId: "a".repeat(32),
      deviceId: "b".repeat(32),
      vaultRoot: root,
      state: "ready" as const,
      enrollment: "creator" as const,
    };
    await expect(
      openNativeVault(
        entry,
        dataDir,
        {
          inventory: [entry],
          keyStore: new InMemoryKeyStore(),
          sodium,
          bootstrapCertificates: async () => [],
        },
        takeWriterLease(lock),
        () => NOW,
      ),
    ).rejects.toThrow("native_path_invalid");
    expect(readFileSync(target, "utf8")).toBe("sentinel");
    lock.release();
  });

  it("refuses a symlinked SQLite sidecar before a database open", async () => {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "cashu-native-sidecar-test-")));
    roots.push(dataDir);
    const root = join(dataDir, "vaults", "a".repeat(32));
    mkdirSync(join(root, "log"), { recursive: true });
    const target = join(dataDir, "untouched-wal");
    writeFileSync(target, "sentinel", { mode: 0o600 });
    writeFileSync(join(root, "private.db"), "", { mode: 0o600 });
    writeFileSync(join(root, "view.db"), "", { mode: 0o600 });
    symlinkSync(target, join(root, "view.db-wal"));
    const lock = acquireHostLock(join(dataDir, "host.lock.db"));
    if (!lock) throw new Error("synthetic lock busy");
    const entry = {
      vaultId: "a".repeat(32),
      deviceId: "b".repeat(32),
      vaultRoot: root,
      state: "ready" as const,
      enrollment: "creator" as const,
    };
    await expect(
      openNativeVault(
        entry,
        dataDir,
        {
          inventory: [entry],
          keyStore: new InMemoryKeyStore(),
          sodium,
          bootstrapCertificates: async () => [],
        },
        takeWriterLease(lock),
        () => NOW,
      ),
    ).rejects.toThrow("native_path_invalid");
    expect(readFileSync(target, "utf8")).toBe("sentinel");
    lock.release();
  });

  it("reopens one encrypted creator log and keeps the native profile stable", async () => {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "cashu-native-vault-test-")));
    roots.push(dataDir);
    const identity = crypto.createDeviceIdentity(sodium);
    const recovery = crypto.recoveryIdentity(sodium, crypto.createRecoveryKey(sodium).phrase);
    const created = crypto.createVaultWithRecovery(sodium, recovery, identity);
    const root = join(dataDir, "vaults", created.ring.vaultId);
    const log = join(root, "log");
    mkdirSync(log, { recursive: true });
    const entry = {
      vaultId: created.ring.vaultId,
      deviceId: identity.deviceId,
      vaultRoot: root,
      state: "ready" as const,
      enrollment: "creator" as const,
    };
    const keyStore = new InMemoryKeyStore();
    await crypto.saveKeyring(keyStore, created.ring);
    await crypto.saveDeviceIdentity(keyStore, identity);
    const meta = openNodeSqlite(join(root, "private.db"));
    const provenance = SqlProvenanceStore.open(meta, created.ring, "new");
    provenance.put({
      kid: created.ring.active.kid,
      generation: created.ring.active.generation,
      epoch: created.ring.active.epoch,
      sender: identity.deviceId,
      recipients: null,
      source: "own",
      receivedAt: NOW,
    });
    SqlAttemptJournal.open(meta, "new", () => NOW);
    const saltKey = created.ring.gidSalt();
    const salt = vaultSalt(saltKey.expose().slice());
    saltKey.wipe();
    const store = Store.open({
      driver: openNodeSqlite(join(root, "view.db")),
      vault: created.ring.vaultId,
      salt,
      modules: builtinModules(),
    });
    const candidate = await loadDeviceAuthority({
      entry,
      dataDir,
      keyStore,
      sodium,
      provenance,
      clock: () => NOW,
      bootstrapCertificates: [created.creatorCertificate],
    });
    const engine = await createSyncEngine({
      vault: entry.vaultId,
      device: entry.deviceId,
      local: new FolderTransport({ fs: new NodeFolderFs(log) }),
      remotes: [],
      codec: createOwnLogCodec({ sodium, ring: candidate.ring, signer: candidate.identity }),
      gate: candidate.gate,
      sink: store.sink(),
      clockStore: metaClockStore(store.driver, entry.deviceId),
      gateState: metaGateStateStore(store.driver, entry.deviceId),
    });
    const eid = () => "01K9B2W0000000000000000000";
    const subject = {
      deviceId: identity.deviceId,
      signPublicKey: identity.signPublicKey,
      boxPublicKey: identity.box.publicKey,
    };
    await engine.write([
      devices.buildDeviceAdded(
        identity,
        entry.vaultId,
        eid(),
        subject,
        "creator",
        created.creatorCertificate,
      ),
      devices.creatorPin(identity, recovery, entry.vaultId, "01K9B2W0000000000000000001", NOW),
    ]);
    const prepared = prepareCommand(
      store,
      createProfile,
      { slug: "synthetic", name: "Synthetic", modules: ["budget"] },
      {
        device: entry.deviceId,
        clock: { now: () => NOW },
        lease: { isHolder: () => true },
      },
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    await engine.write(prepared.events.map(toUnstampedEvent));
    expect(store.read<{ gid: string }>("SELECT gid FROM profiles")).toEqual([
      { gid: entry.vaultId },
    ]);
    const peerIdentity = crypto.createDeviceIdentity(sodium);
    const peerSubject = {
      deviceId: peerIdentity.deviceId,
      signPublicKey: peerIdentity.signPublicKey,
      boxPublicKey: peerIdentity.box.publicKey,
    };
    const peerCertificate = crypto.certifyDevice(sodium, identity, peerSubject, entry.vaultId);
    await engine.write([
      devices.buildDeviceAdded(
        identity,
        entry.vaultId,
        "01K9B2W0000000000000000002",
        peerSubject,
        "paired",
        peerCertificate,
      ),
    ]);
    const peerRename = prepareCommand(
      store,
      renameProfile,
      { name: "From peer" },
      {
        device: peerIdentity.deviceId,
        clock: { now: () => NOW + 1000 },
        lease: { isHolder: () => true },
      },
    );
    if (!peerRename.ok) throw new Error(peerRename.reason);
    await engine.close();
    store.close();
    candidate.close();
    meta.close();
    const peerRing = created.ring.clone(sodium);
    const peerKeyStore = new InMemoryKeyStore();
    await crypto.saveKeyring(peerKeyStore, peerRing);
    await crypto.saveDeviceIdentity(peerKeyStore, peerIdentity);
    const peerRoot = join(dataDir, "peer");
    mkdirSync(peerRoot);
    const peerMeta = openNodeSqlite(join(peerRoot, "private.db"));
    const peerProvenance = SqlProvenanceStore.open(peerMeta, peerRing, "new");
    devices.recordPairingProvenance(peerProvenance, peerRing, entry.deviceId, NOW);
    const peerEntry = {
      ...entry,
      deviceId: peerIdentity.deviceId,
      vaultRoot: peerRoot,
      enrollment: "pairing" as const,
    };
    const peerAuthority = await loadDeviceAuthority({
      entry: peerEntry,
      dataDir,
      keyStore: peerKeyStore,
      sodium,
      provenance: peerProvenance,
      clock: () => NOW,
      bootstrapCertificates: [created.creatorCertificate, peerCertificate],
    });
    const peerLocal = new MemoryTransport();
    const peerEngine = await createSyncEngine({
      vault: entry.vaultId,
      device: peerIdentity.deviceId,
      local: peerLocal,
      remotes: [new FolderTransport({ fs: new NodeFolderFs(log) })],
      codec: createOwnLogCodec({
        sodium,
        ring: peerAuthority.ring,
        signer: peerAuthority.identity,
      }),
      gate: peerAuthority.gate,
      sink: new MemorySink(),
      clockStore: new MemoryClockStore(),
      physicalClock: new ManualClock(Date.now() + 1000),
    });
    expect((await peerEngine.sync()).rolledBack).toBe(false);
    await peerEngine.write(peerRename.events.map(toUnstampedEvent));
    const rotation = peerAuthority.devices.prepareRotation("01K9B2W0000000000000000003");
    if (!rotation.ok) throw new Error(rotation.reason);
    await peerEngine.write(rotation.change.events);
    rotation.change.commit();
    const rotatedKid = rotation.change.key?.kid;
    if (!rotatedKid) throw new Error("missing synthetic rotation key");
    await peerEngine.close();
    peerAuthority.close();
    peerMeta.close();
    peerRing.wipe();
    const home = join(dataDir, "test-home");
    mkdirSync(home);
    const host = await startLocalHost({
      dataDir,
      home,
      build: "test",
      launcher: false,
      python: null,
      vaultSource: {
        kind: "native",
        provider: {
          inventory: [entry],
          keyStore,
          sodium,
          bootstrapCertificates: async () => [created.creatorCertificate, peerCertificate],
          remoteTransports: () => [peerLocal],
        },
      },
    });
    const cliExec = async (argv: string[]) => {
      const connection = await connectHost({ dataDir, role: "cli", build: "test" });
      try {
        const answer = new Promise<unknown>((resolve, reject) => {
          connection.onFrame((frame: HostFrame) => {
            if (frame.t !== "res" || frame.id !== 1) return;
            if (frame.outcome.ok) resolve(frame.outcome.result);
            else reject(new Error(frame.outcome.error.code));
          });
        });
        const params: CliExecParams = {
          argv,
          cwd: dataDir,
          env: { CASHU_LANG: "en" },
          tty: { stdin: false, stdout: false, stderr: false },
        };
        connection.send({ t: "req", id: 1, method: "cli.exec", params });
        return await answer;
      } finally {
        connection.close();
      }
    };
    const client = await storeClient(dataDir);
    expect(client.vaults).toEqual([entry.vaultId]);
    const profileSub = await client.subscribe("core.profile", entry.vaultId);
    expect(profileSub.first).toMatchObject({ name: "Synthetic" });
    const originalPeerRead = peerLocal.read.bind(peerLocal);
    let releasePeerRead = () => {};
    const peerReadHeld = new Promise<void>((resolve) => {
      releasePeerRead = resolve;
    });
    peerLocal.read = async (...args) => {
      await peerReadHeld;
      return originalPeerRead(...args);
    };
    const pendingSync = host.syncVault(entry.vaultId);
    await expect.poll(() => host.stores.vaults.get(entry.vaultId)?.native?.isSyncing()).toBe(true);
    expect(() =>
      host.stores.vaults.get(entry.vaultId)?.store.read("SELECT name FROM profiles"),
    ).toThrow("native_session_unavailable");
    releasePeerRead();
    const inbound = await pendingSync;
    expect(inbound.rolledBack).toBe(false);
    expect(inbound.applied).toBeGreaterThan(0);
    const heldAfterSync = await crypto.loadKeyring(keyStore, sodium, entry.vaultId);
    expect(heldAfterSync?.active.kid).toBe(rotatedKid);
    heldAfterSync?.wipe();
    await expect.poll(() => profileSub.values.length).toBe(2);
    expect(profileSub.values).toEqual([
      expect.objectContaining({ name: "Synthetic" }),
      expect.objectContaining({ name: "From peer" }),
    ]);
    expect(
      host.stores.vaults
        .get(entry.vaultId)
        ?.store.read<{ name: string }>("SELECT name FROM profiles"),
    ).toEqual([{ name: "From peer" }]);
    expect(
      await cliExec([
        "-p",
        "synthetic",
        "cash-add",
        "1",
        "Synthetic cash",
        "dining",
        "--date",
        "2026-10-31",
      ]),
    ).toEqual({ kind: "exit", code: 0 });
    const hostKey = "01K9B2W0000000000000000009";
    expect(
      await client.run(
        renameProfile.id,
        { name: "Through host" },
        {
          vault: entry.vaultId,
          key: hostKey,
        },
      ),
    ).toEqual({ ok: true, value: null });
    expect(
      host.stores.vaults
        .get(entry.vaultId)
        ?.native?.attempts.status(entry.vaultId, hostKey, renameProfile.id),
    ).toMatchObject({ phase: "completed" });
    client.close();
    await host.stop();
    const privateRead = openNodeSqlite(join(root, "private.db"), { readOnly: true });
    const cliKey = privateRead
      .prepare("SELECT key FROM host_attempts WHERE command_id = ?")
      .get<{ key: string }>("budget.addCashExpenseCli")?.key;
    privateRead.close();
    if (!cliKey) throw new Error("missing synthetic CLI key");
    const privateExpiry = openNodeSqlite(join(root, "private.db"));
    SqlAttemptJournal.open(
      privateExpiry,
      "existing",
      () => Date.now() + 25 * 60 * 60 * 1000,
    ).pruneReceipts();
    privateExpiry.close();
    const statusHost = await startLocalHost({
      dataDir,
      home,
      build: "test",
      launcher: false,
      python: null,
      vaultSource: {
        kind: "native",
        provider: {
          inventory: [entry],
          keyStore,
          sodium,
          bootstrapCertificates: async () => [created.creatorCertificate, peerCertificate],
          remoteTransports: () => [peerLocal],
        },
      },
    });
    const heldAfterReopen = await crypto.loadKeyring(keyStore, sodium, entry.vaultId);
    expect(heldAfterReopen?.active.kid).toBe(rotatedKid);
    heldAfterReopen?.wipe();
    expect(
      await cliExec(["-p", "synthetic", "command-status", "budget.addCashExpenseCli", cliKey]),
    ).toEqual({ kind: "exit", code: 0 });
    expect(
      statusHost.stores.vaults
        .get(entry.vaultId)
        ?.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM transactions"),
    ).toEqual([{ n: 1 }]);
    await statusHost.stop();
    const lock = acquireHostLock(join(dataDir, "host.lock.db"));
    if (!lock) throw new Error("synthetic lock busy");
    const opened = await openNativeVault(
      entry,
      dataDir,
      {
        inventory: [entry],
        keyStore,
        sodium,
        bootstrapCertificates: async () => [created.creatorCertificate, peerCertificate],
      },
      takeWriterLease(lock),
      () => NOW,
    );
    expect(opened.store.read<{ gid: string }>("SELECT gid FROM profiles")).toEqual([
      { gid: entry.vaultId },
    ]);
    expect((await opened.sync()).rolledBack).toBe(false);
    const key = "01K9B2W0000000000000000010";
    const commandSession = {
      vault: entry.vaultId,
      device: entry.deviceId,
      store: opened.store,
      engine: opened.engine,
      clock: { now: () => NOW },
      lease: { isHolder: () => true },
      attempts: opened.attempts,
      queue: { run: (_id, task) => opened.queue.run(task) },
      isCurrent: () => opened.isCurrent(),
      newAttemptId: () => "attempt-synthetic-1",
    } satisfies Parameters<typeof executeDurableCommand>[0];
    const result = await executeDurableCommand(
      commandSession,
      renameProfile,
      { name: "After" },
      key,
    );
    expect(result.kind).toBe("completed");
    const replay = await executeDurableCommand(
      commandSession,
      renameProfile,
      { name: "After" },
      key,
    );
    expect(replay).toEqual(result);
    expect(
      await executeDurableCommand(commandSession, renameProfile, { name: "Different" }, key),
    ).toEqual({ kind: "refused", reason: "request_key_conflict" });
    await opened.close();
    const restarted = await openNativeVault(
      entry,
      dataDir,
      {
        inventory: [entry],
        keyStore,
        sodium,
        bootstrapCertificates: async () => [created.creatorCertificate, peerCertificate],
      },
      takeWriterLease(lock),
      () => NOW,
    );
    expect(restarted.store.read<{ name: string }>("SELECT name FROM profiles")).toEqual([
      { name: "After" },
    ]);
    expect(restarted.attempts.status(entry.vaultId, key, renameProfile.id)).toMatchObject({
      phase: "completed",
    });
    await restarted.close();
    lock.release();
    identity.wipe();
    peerIdentity.wipe();
    created.ring.wipe();
    recovery.wipe();
  });
});
