import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { mintUlid } from "@cashu/store";
import {
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  devices,
  formatHlc,
  MemoryClockStore,
  MemoryTransport,
  type UnstampedEvent,
} from "@cashu/sync";
import { InMemoryKeyStore, ManualClock, MemorySink } from "@cashu/sync/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertReplayedDeviceAuthority,
  loadDeviceAuthority,
  type NativeVaultInventoryEntry,
} from "./deviceAuthority.js";
import { ProvenanceRefusal, SqlProvenanceStore } from "./sqlProvenance.js";

const sodium = await crypto.loadNodeSodium();
const NOW = Date.UTC(2026, 10, 3, 12);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cashu-authority-test-")));
  roots.push(dir);
  return dir;
}

function eid() {
  return mintUlid(NOW, (length) => sodium.randomBytes(length));
}

function signedLog(event: UnstampedEvent, writer: string, offset: number): devices.LogEvent {
  return {
    eid: event.i,
    hlc: formatHlc({ wall: NOW, counter: offset, device: writer }),
    writer,
    position: { seg: 1, offset },
    type: event.t,
    v: event.v,
    data: event.d,
  };
}

async function creator() {
  const dataDir = root();
  const store = new InMemoryKeyStore();
  const identity = crypto.createDeviceIdentity(sodium);
  const recovery = crypto.recoveryIdentity(sodium, crypto.createRecoveryKey(sodium).phrase);
  const created = crypto.createVaultWithRecovery(sodium, recovery, identity);
  const entry: NativeVaultInventoryEntry = {
    vaultId: created.ring.vaultId,
    deviceId: identity.deviceId,
    vaultRoot: join(dataDir, created.ring.vaultId),
    state: "ready",
    enrollment: "creator",
  };
  mkdirSync(entry.vaultRoot);
  await crypto.saveKeyring(store, created.ring);
  await crypto.saveDeviceIdentity(store, identity);
  const dbPath = join(entry.vaultRoot, "authority.db");
  const driver = openNodeSqlite(dbPath);
  const provenance = SqlProvenanceStore.open(driver, created.ring, "new");
  const first = created.ring.active;
  provenance.put({
    kid: first.kid,
    generation: first.generation,
    epoch: first.epoch,
    sender: identity.deviceId,
    recipients: null,
    source: "own",
    receivedAt: NOW,
  });
  const input = {
    entry,
    dataDir,
    keyStore: store,
    sodium,
    provenance,
    clock: () => NOW,
    bootstrapCertificates: [created.creatorCertificate],
  };
  return { created, recovery, identity, store, driver, dbPath, input };
}

describe("device authority foundation", () => {
  it("requires durable provenance for every held key and refuses an absent or swapped store", async () => {
    const c = await creator();
    const loaded = SqlProvenanceStore.open(c.driver, c.created.ring, "existing");
    const firstRecord = loaded.get(c.created.ring.active.kid);
    expect(firstRecord?.source).toBe("own");
    if (!firstRecord) throw new Error("missing synthetic provenance");
    loaded.put({ ...firstRecord, receivedAt: NOW + 1 });
    expect(loaded.get(c.created.ring.active.kid)?.receivedAt).toBe(NOW);
    c.driver.close();
    const reopened = openNodeSqlite(c.dbPath);
    expect(SqlProvenanceStore.open(reopened, c.created.ring, "existing").list()).toHaveLength(1);
    reopened.exec("UPDATE vault_key_provenance SET recipients = '{\"bad\":1}'");
    expect(() => SqlProvenanceStore.open(reopened, c.created.ring, "existing")).toThrow(
      "corrupt_provenance",
    );
    reopened.exec("DELETE FROM vault_key_provenance");
    expect(() => SqlProvenanceStore.open(reopened, c.created.ring, "existing")).toThrow(
      ProvenanceRefusal,
    );
    reopened.close();
    const missing = openNodeSqlite(join(c.input.entry.vaultRoot, "missing.db"));
    expect(() => SqlProvenanceStore.open(missing, c.created.ring, "existing")).toThrow(
      ProvenanceRefusal,
    );
    missing.close();
  });

  it("loads only exact-name certified identity, then admits after genuine signed history replay", async () => {
    const c = await creator();
    const candidate = await loadDeviceAuthority(c.input);
    expect(() =>
      assertReplayedDeviceAuthority(
        candidate,
        {
          complete: false,
          requiresViewRebuild: false,
          rolledBack: false,
        },
        c.created.ring.vaultId,
      ),
    ).toThrow("incomplete_history");
    const local = new MemoryTransport();
    const clockStore = new MemoryClockStore();
    const engine = await createSyncEngine({
      vault: c.created.ring.vaultId,
      device: c.identity.deviceId,
      local,
      remotes: [],
      codec: createOwnLogCodec({ sodium, ring: candidate.ring, signer: candidate.identity }),
      gate: candidate.gate,
      sink: new MemorySink(),
      clockStore,
      physicalClock: new ManualClock(NOW),
    });
    const subject = {
      deviceId: c.identity.deviceId,
      signPublicKey: c.identity.signPublicKey,
      boxPublicKey: c.identity.box.publicKey,
    };
    await engine.write([
      devices.buildDeviceAdded(
        c.identity,
        c.created.ring.vaultId,
        eid(),
        subject,
        "creator",
        c.created.creatorCertificate,
      ),
      devices.creatorPin(c.identity, c.recovery, c.created.ring.vaultId, eid(), NOW),
    ]);
    await engine.close();
    candidate.close();
    const restart = await loadDeviceAuthority(c.input);
    const replay = await createSyncEngine({
      vault: c.created.ring.vaultId,
      device: c.identity.deviceId,
      local,
      remotes: [],
      codec: createOwnLogCodec({ sodium, ring: restart.ring, signer: restart.identity }),
      gate: restart.gate,
      sink: new MemorySink(),
      clockStore,
      physicalClock: new ManualClock(NOW),
    });
    const report = await replay.recoverLocal();
    expect(report.complete).toBe(true);
    expect(() =>
      assertReplayedDeviceAuthority(restart, report, c.created.ring.vaultId),
    ).not.toThrow();
    expect(() => assertReplayedDeviceAuthority(restart, report, "0".repeat(32))).toThrow(
      "profile_mismatch",
    );
    restart.close();
    c.driver.close();
  });

  it("requires the inviter's signed announcement for a paired certificate chain", async () => {
    const creatorVault = await creator();
    const creatorCandidate = await loadDeviceAuthority(creatorVault.input);
    const local = new MemoryTransport();
    const clockStore = new MemoryClockStore();
    const creatorEngine = await createSyncEngine({
      vault: creatorVault.created.ring.vaultId,
      device: creatorVault.identity.deviceId,
      local,
      remotes: [],
      codec: createOwnLogCodec({
        sodium,
        ring: creatorCandidate.ring,
        signer: creatorCandidate.identity,
      }),
      gate: creatorCandidate.gate,
      sink: new MemorySink(),
      clockStore,
      physicalClock: new ManualClock(NOW),
    });
    const creatorSubject = {
      deviceId: creatorVault.identity.deviceId,
      signPublicKey: creatorVault.identity.signPublicKey,
      boxPublicKey: creatorVault.identity.box.publicKey,
    };
    await creatorEngine.write([
      devices.buildDeviceAdded(
        creatorVault.identity,
        creatorVault.created.ring.vaultId,
        eid(),
        creatorSubject,
        "creator",
        creatorVault.created.creatorCertificate,
      ),
    ]);
    const joinedIdentity = crypto.createDeviceIdentity(sodium);
    const joinedRing = creatorVault.created.ring.clone(sodium);
    const joinedStore = new InMemoryKeyStore();
    await crypto.saveKeyring(joinedStore, joinedRing);
    await crypto.saveDeviceIdentity(joinedStore, joinedIdentity);
    const joinedRoot = root();
    const joinedEntry: NativeVaultInventoryEntry = {
      vaultId: joinedRing.vaultId,
      deviceId: joinedIdentity.deviceId,
      vaultRoot: join(joinedRoot, joinedRing.vaultId),
      state: "ready",
      enrollment: "pairing",
    };
    mkdirSync(joinedEntry.vaultRoot);
    const joinedDriver = openNodeSqlite(join(joinedEntry.vaultRoot, "authority.db"));
    const joinedProvenance = SqlProvenanceStore.open(joinedDriver, joinedRing, "new");
    devices.recordPairingProvenance(
      joinedProvenance,
      joinedRing,
      creatorVault.identity.deviceId,
      NOW,
    );
    const joinedSubject = {
      deviceId: joinedIdentity.deviceId,
      signPublicKey: joinedIdentity.signPublicKey,
      boxPublicKey: joinedIdentity.box.publicKey,
    };
    const joinedCert = crypto.certifyDevice(
      sodium,
      creatorVault.identity,
      joinedSubject,
      joinedRing.vaultId,
    );
    const joinedInput = {
      entry: joinedEntry,
      dataDir: joinedRoot,
      keyStore: joinedStore,
      sodium,
      provenance: joinedProvenance,
      clock: () => NOW,
      bootstrapCertificates: [creatorVault.created.creatorCertificate, joinedCert],
    };
    const before = await loadDeviceAuthority(joinedInput);
    const beforeEngine = await createSyncEngine({
      vault: joinedRing.vaultId,
      device: joinedIdentity.deviceId,
      local,
      remotes: [],
      codec: createOwnLogCodec({ sodium, ring: before.ring, signer: before.identity }),
      gate: before.gate,
      sink: new MemorySink(),
      clockStore: new MemoryClockStore(),
      physicalClock: new ManualClock(NOW),
    });
    const beforeReport = await beforeEngine.recoverLocal();
    expect(beforeReport.complete).toBe(true);
    expect(() => assertReplayedDeviceAuthority(before, beforeReport, joinedRing.vaultId)).toThrow(
      "untrusted_identity",
    );
    await beforeEngine.close();
    before.close();
    await creatorEngine.write([
      devices.buildDeviceAdded(
        creatorVault.identity,
        joinedRing.vaultId,
        eid(),
        joinedSubject,
        "paired",
        joinedCert,
      ),
    ]);
    await creatorEngine.close();
    creatorCandidate.close();
    const after = await loadDeviceAuthority(joinedInput);
    const afterEngine = await createSyncEngine({
      vault: joinedRing.vaultId,
      device: joinedIdentity.deviceId,
      local,
      remotes: [],
      codec: createOwnLogCodec({ sodium, ring: after.ring, signer: after.identity }),
      gate: after.gate,
      sink: new MemorySink(),
      clockStore: new MemoryClockStore(),
      physicalClock: new ManualClock(NOW),
    });
    const afterReport = await afterEngine.recoverLocal();
    expect(afterReport.complete).toBe(true);
    expect(() =>
      assertReplayedDeviceAuthority(after, afterReport, joinedRing.vaultId),
    ).not.toThrow();
    await afterEngine.close();
    after.close();
    joinedDriver.close();
    creatorVault.driver.close();
  });

  it("refuses missing identity and a wrong certificate before any log or view opens", async () => {
    const c = await creator();
    await c.store.delete(crypto.deviceIdentityName(c.identity.deviceId));
    await expect(loadDeviceAuthority(c.input)).rejects.toThrow("missing_authority");
    await crypto.saveDeviceIdentity(c.store, c.identity);
    const other = crypto.createDeviceIdentity(sodium);
    const wrong = crypto.certifyDevice(
      sodium,
      c.recovery,
      {
        deviceId: other.deviceId,
        signPublicKey: other.signPublicKey,
        boxPublicKey: other.box.publicKey,
      },
      c.created.ring.vaultId,
    );
    await expect(
      loadDeviceAuthority({ ...c.input, bootstrapCertificates: [wrong] }),
    ).rejects.toThrow("untrusted_identity");
    c.driver.close();
  });

  it("refuses a key payload swapped into the correct item name", async () => {
    const one = await creator();
    const two = await creator();
    const swapped = await two.store.get(crypto.keyringName(two.created.ring.vaultId));
    expect(swapped).not.toBeNull();
    await one.store.set(crypto.keyringName(one.created.ring.vaultId), swapped as Uint8Array);
    await expect(loadDeviceAuthority(one.input)).rejects.toThrow();
    one.driver.close();
    two.driver.close();
  });

  it("refuses signed revocation and conflicting local key after registry evolution", async () => {
    const c = await creator();
    const subject = {
      deviceId: c.identity.deviceId,
      signPublicKey: c.identity.signPublicKey,
      boxPublicKey: c.identity.box.publicKey,
    };
    const intro = devices.buildDeviceAdded(
      c.identity,
      c.created.ring.vaultId,
      eid(),
      subject,
      "creator",
      c.created.creatorCertificate,
    );
    const ready = { complete: true, requiresViewRebuild: false, rolledBack: false };
    const revoked = await loadDeviceAuthority(c.input);
    revoked.devices.ingest([signedLog(intro, c.identity.deviceId, 1)]);
    expect(() =>
      assertReplayedDeviceAuthority(revoked, ready, c.created.ring.vaultId),
    ).not.toThrow();
    const revocation = devices.buildDeviceRevoked(c.recovery, c.created.ring.vaultId, eid(), [
      { device: c.identity.deviceId, cut: { seg: 1, offset: 1 } },
    ]);
    revoked.devices.ingest([signedLog(revocation, c.identity.deviceId, 2)]);
    expect(() => assertReplayedDeviceAuthority(revoked, ready, c.created.ring.vaultId)).toThrow(
      "untrusted_identity",
    );
    revoked.close();
    const conflicted = await loadDeviceAuthority(c.input);
    conflicted.devices.ingest([signedLog(intro, c.identity.deviceId, 1)]);
    const other = crypto.createDeviceIdentity(sodium, c.identity.deviceId);
    const alternate = {
      deviceId: other.deviceId,
      signPublicKey: other.signPublicKey,
      boxPublicKey: other.box.publicKey,
    };
    const otherCert = crypto.certifyDevice(sodium, c.recovery, alternate, c.created.ring.vaultId);
    const clash = devices.buildDeviceAdded(
      c.recovery,
      c.created.ring.vaultId,
      eid(),
      alternate,
      "conflict",
      otherCert,
    );
    conflicted.devices.ingest([signedLog(clash, c.identity.deviceId, 2)]);
    expect(() => assertReplayedDeviceAuthority(conflicted, ready, c.created.ring.vaultId)).toThrow(
      "untrusted_identity",
    );
    conflicted.close();
    c.driver.close();
  });

  it("refuses noncanonical and symlinked inventory roots", async () => {
    const c = await creator();
    const alias = join(c.input.dataDir, "alias");
    symlinkSync(c.input.entry.vaultRoot, alias);
    await expect(
      loadDeviceAuthority({
        ...c.input,
        entry: { ...c.input.entry, vaultRoot: alias },
      }),
    ).rejects.toThrow("invalid_inventory");
    await expect(
      loadDeviceAuthority({
        ...c.input,
        entry: { ...c.input.entry, vaultRoot: `${c.input.entry.vaultRoot}/../alias` },
      }),
    ).rejects.toThrow("invalid_inventory");
    c.driver.close();
  });

  it("keeps inventory and certificate bytes fixed across asynchronous key reads", async () => {
    const c = await creator();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const delayed: crypto.KeyStore = {
      get: async (name) => {
        if (first) {
          first = false;
          await held;
        }
        return c.store.get(name);
      },
      set: (name, value) => c.store.set(name, value),
      delete: (name) => c.store.delete(name),
    };
    const mutable = { ...c.input.entry };
    const certificate = c.created.creatorCertificate.slice();
    const loaded = loadDeviceAuthority({
      ...c.input,
      entry: mutable,
      keyStore: delayed,
      bootstrapCertificates: [certificate],
    });
    mutable.deviceId = "f".repeat(32);
    certificate.fill(0);
    release();
    const candidate = await loaded;
    expect(candidate.entry.deviceId).toBe(c.identity.deviceId);
    candidate.close();
    c.driver.close();
  });
});
