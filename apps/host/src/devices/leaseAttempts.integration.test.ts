import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connectHost, NodeFolderFs } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { builtinModules, metaClockStore, metaGateStateStore, Store, vaultSalt } from "@cashu/store";
import { createOwnLogCodec, createSyncEngine, crypto, devices, FolderTransport } from "@cashu/sync";
import { InMemoryKeyStore, MemoryTransport } from "@cashu/sync/testing";
import { expect, it, vi } from "vitest";
import { startLocalHost } from "../host.js";
import { initializeNativeClockGuard, nativeClockGuard } from "../market/clockGuard.js";
import { loadDeviceAuthority } from "../sync/keys/deviceAuthority.js";
import { SqlProvenanceStore } from "../sync/keys/sqlProvenance.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";

it("records a checked native fetch as an authenticated durable lease event", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"] });
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
  });
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (vault?.mode !== "native") throw new Error("synthetic native vault unavailable");
    expect(await vault.native.recordFetch()).toBe("not_started");
    await vault.native.sync();
    expect(vault.native.canFetchPublicMarket()).toBe(true);
    expect(await vault.native.recordFetch()).toBe("completed");
    const list = await vault.native.deviceList();
    expect(list.kind).toBe("ready");
    if (list.kind !== "ready") return;
    expect(list.leader.device).toBe(vault.native.device);
    expect(list.leader.lastActivityAt).not.toBeNull();
    const cursors = vi.spyOn(vault.store, "cursors").mockReturnValue(new Map());
    try {
      expect(vault.native.canFetchPublicMarket()).toBe(false);
    } finally {
      cursors.mockRestore();
    }
  } finally {
    await host.stop();
    fixture.cleanup();
  }
});

it("routes a typed owner re-pin through the native UI socket and inspects its durable result", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"], pairPeer: true });
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
  });
  const ui = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "test" });
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (vault?.mode !== "native" || !fixture.peerDevice)
      throw new Error("paired vault unavailable");
    await vault.native.sync();
    expect(
      await ui.call("native.devices.leaderPreview", {
        vault: fixture.vaultId,
        leader: vault.native.device,
        force: false,
      }),
    ).toMatchObject({ kind: "refused", code: "unsafe_target" });
    const preview = (await ui.call("native.devices.leaderPreview", {
      vault: fixture.vaultId,
      leader: fixture.peerDevice,
      force: false,
    })) as { kind: string; token?: string; operationId?: string; confirmationText?: string };
    expect(preview.kind).toBe("prepared");
    if (!preview.token || !preview.operationId || !preview.confirmationText)
      throw new Error("preview missing");
    expect(
      await ui.call("native.devices.leaderCommit", {
        vault: fixture.vaultId,
        token: preview.token,
        confirmationText: "PIN WRONG",
      }),
    ).toMatchObject({ kind: "refused", code: "confirmation_required" });
    const next = (await ui.call("native.devices.leaderPreview", {
      vault: fixture.vaultId,
      leader: fixture.peerDevice,
      force: false,
    })) as { kind: string; token?: string; operationId?: string; confirmationText?: string };
    if (!next.token || !next.operationId || !next.confirmationText)
      throw new Error("second preview missing");
    expect(
      await ui.call("native.devices.leaderCommit", {
        vault: fixture.vaultId,
        token: next.token,
        confirmationText: next.confirmationText,
      }),
    ).toMatchObject({ kind: "completed", operationId: next.operationId });
    expect(
      await ui.call("native.devices.leaderInspect", {
        vault: fixture.vaultId,
        operationId: next.operationId,
      }),
    ).toMatchObject({ kind: "completed", operationId: next.operationId });
  } finally {
    ui.close();
    await host.stop();
    fixture.cleanup();
  }
});

it("refuses a self-authored non-force handover while an old-leader fetch is in flight", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"], pairPeer: true });
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
  });
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (vault?.mode !== "native" || !fixture.peerDevice)
      throw new Error("synthetic paired native vault unavailable");
    await vault.native.sync();
    const endFetch = vault.native.beginFetch();
    expect(endFetch).not.toBeNull();
    expect(await vault.native.leaderPrepare(fixture.peerDevice, false)).toMatchObject({
      kind: "refused",
    });
    endFetch?.();
    await vault.native.sync();
    const prepared = await vault.native.leaderPrepare(fixture.peerDevice, false);
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;
    expect(
      await vault.native.leaderCommit(
        fixture.peerDevice,
        false,
        prepared.confirmationText,
        prepared.head,
        "01K9B2W0000000000000000091",
      ),
    ).toBe("completed");
    expect(vault.native.beginFetch()).toBeNull();
    const released = await vault.native.deviceList();
    expect(released.kind).toBe("ready");
    if (released.kind !== "ready") return;
    expect(released.leader.pendingFrom).toBeNull();
    expect(released.leader.device).toBe(fixture.peerDevice);
  } finally {
    await host.stop();
    fixture.cleanup();
  }
});

it("keeps a remote non-force pin pending until the old leader's fetch drains and it signs release", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"], pairPeer: true });
  if (!fixture.peerIdentity || !fixture.peerCertificate)
    throw new Error("synthetic peer unavailable");
  const sodium = fixture.vaultSource.provider.sodium;
  const ring = await crypto.loadKeyring(
    fixture.vaultSource.provider.keyStore,
    sodium,
    fixture.vaultId,
  );
  if (!ring) throw new Error("synthetic ring unavailable");
  const peerKeys = new InMemoryKeyStore();
  await crypto.saveKeyring(peerKeys, ring);
  await crypto.saveDeviceIdentity(peerKeys, fixture.peerIdentity);
  const peerRoot = join(fixture.dataDir, "peer");
  mkdirSync(peerRoot);
  const peerMeta = openNodeSqlite(join(peerRoot, "private.db"));
  const provenance = SqlProvenanceStore.open(peerMeta, ring, "new");
  const saltKey = ring.gidSalt();
  const salt = vaultSalt(saltKey.expose().slice());
  saltKey.wipe();
  const peerStore = Store.open({
    driver: openNodeSqlite(join(peerRoot, "view.db")),
    vault: fixture.vaultId,
    salt,
    modules: builtinModules(),
  });
  initializeNativeClockGuard(peerStore.driver, fixture.peerIdentity.deviceId);
  const creator = fixture.vaultSource.provider.inventory[0];
  if (!creator) throw new Error("creator unavailable");
  const creatorCertificate = (await fixture.vaultSource.provider.bootstrapCertificates())[0];
  if (!creatorCertificate) throw new Error("creator certificate unavailable");
  devices.recordPairingProvenance(provenance, ring, creator.deviceId, Date.now());
  const peerAuthority = await loadDeviceAuthority({
    entry: {
      ...creator,
      deviceId: fixture.peerIdentity.deviceId,
      vaultRoot: peerRoot,
      enrollment: "pairing",
    },
    dataDir: fixture.dataDir,
    keyStore: peerKeys,
    sodium,
    provenance,
    clock: Date.now,
    bootstrapCertificates: [creatorCertificate, fixture.peerCertificate],
  });
  const peerLocal = new MemoryTransport();
  const peerEngine = await createSyncEngine({
    vault: fixture.vaultId,
    device: fixture.peerIdentity.deviceId,
    local: peerLocal,
    remotes: [new FolderTransport({ fs: new NodeFolderFs(join(creator.vaultRoot, "log")) })],
    codec: createOwnLogCodec({ sodium, ring: peerAuthority.ring, signer: peerAuthority.identity }),
    gate: peerAuthority.gate,
    sink: peerStore.sink(),
    clockStore: metaClockStore(peerStore.driver, fixture.peerIdentity.deviceId),
    clockGuard: nativeClockGuard(peerStore.driver, fixture.peerIdentity.deviceId),
    gateState: metaGateStateStore(peerStore.driver, fixture.peerIdentity.deviceId),
  });
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: {
      kind: "native",
      provider: { ...fixture.vaultSource.provider, remoteTransports: () => [peerLocal] },
    },
  });
  try {
    expect((await peerEngine.sync()).rolledBack).toBe(false);
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (vault?.mode !== "native") throw new Error("native vault unavailable");
    await vault.native.sync();
    const endFetch = vault.native.beginFetch();
    expect(endFetch).not.toBeNull();
    const confirmation = devices.pinConfirmationText(
      "pinned",
      fixture.peerIdentity.deviceId,
      false,
    );
    const pin = devices.pinEventFor(
      peerAuthority.devices.lease,
      {
        identity: peerAuthority.identity,
        vaultId: fixture.vaultId,
        eid: "01K9B2W0000000000000000092",
        now: Date.now(),
        applied: peerStore.cursors(),
      },
      {
        mode: "pinned",
        leader: fixture.peerIdentity.deviceId,
        force: false,
        confirmation: { kind: "typed", text: confirmation },
      },
      { transport: peerEngine.leaseTransport() },
    );
    await peerEngine.write([pin]);
    expect((await peerEngine.sync()).rolledBack).toBe(false);
    await vault.native.sync();
    const pending = await vault.native.deviceList();
    expect(pending.kind).toBe("ready");
    if (pending.kind !== "ready") return;
    expect(pending.leader.pendingFrom).toBe(vault.native.device);
    expect(vault.native.beginFetch()).toBeNull();
    endFetch?.();
    await vault.native.sync();
    const released = await vault.native.deviceList();
    expect(released.kind).toBe("ready");
    if (released.kind !== "ready") return;
    expect(released.leader.pendingFrom).toBeNull();
    expect(released.leader.device).toBe(fixture.peerIdentity.deviceId);
    // Release is appended after the pull phase; the next ordinary pass publishes its own tail.
    await vault.native.sync();
    expect((await peerEngine.sync()).rolledBack).toBe(false);
    const inherited = peerAuthority.devices.lease;
    const local = {
      me: fixture.peerIdentity.deviceId,
      now: Date.now(),
      lastPullAt: Date.now(),
      transport: peerEngine.leaseTransport(),
      own: () => undefined,
      firstSeen: () => undefined,
      clockOk: true,
    };
    expect(devices.catchUpMissing(inherited, new Map()).length).toBeGreaterThan(0);
    expect(devices.mayRunNewestDayImports(inherited, local, new Map())).toBe(false);
    expect(devices.catchUpMissing(inherited, new Map(Object.entries(inherited.catchUp)))).toEqual(
      [],
    );
    expect(
      devices.mayRunNewestDayImports(inherited, local, new Map(Object.entries(inherited.catchUp))),
    ).toBe(true);
  } finally {
    await host.stop();
    await peerEngine.close();
    peerStore.close();
    peerAuthority.close();
    peerMeta.close();
    ring.wipe();
    fixture.cleanup();
  }
});

it("keeps a force pin's unknown outcome inspectable across native reopen", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"], pairPeer: true });
  const start = () =>
    startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      vaultSource: fixture.vaultSource,
    });
  let host = await start();
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (vault?.mode !== "native" || !fixture.peerDevice)
      throw new Error("paired vault unavailable");
    await vault.native.sync();
    const preview = await vault.native.leaderPrepare(fixture.peerDevice, true);
    expect(preview.kind).toBe("prepared");
    if (preview.kind !== "prepared") return;
    const original = vault.native.engine.write.bind(vault.native.engine);
    const injected = vi.spyOn(vault.native.engine, "write").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("synthetic response loss after append");
    });
    const operationId = "01K9B2W0000000000000000093";
    expect(
      await vault.native.leaderCommit(
        fixture.peerDevice,
        true,
        preview.confirmationText,
        preview.head,
        operationId,
      ),
    ).toBe("outcome_unknown");
    injected.mockRestore();
    await host.stop();
    host = await start();
    const reopened = host.stores.vaults.get(fixture.vaultId);
    if (reopened?.mode !== "native") throw new Error("reopened vault unavailable");
    expect(await reopened.native.leaderInspect(operationId)).toBe("completed");
    const list = await reopened.native.deviceList();
    expect(list.kind).toBe("ready");
    if (list.kind !== "ready") return;
    expect(list.leader.device).toBe(fixture.peerDevice);
    expect(list.leader.pendingFrom).toBeNull();
  } finally {
    await host.stop();
    fixture.cleanup();
  }
});
