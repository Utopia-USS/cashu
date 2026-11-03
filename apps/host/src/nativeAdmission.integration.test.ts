import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireHostLock, NodeFolderFs } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  executeDurableCommand,
  metaClockStore,
  metaGateStateStore,
  renameProfile,
  Store,
  vaultSalt,
} from "@cashu/store";
import { createOwnLogCodec, createSyncEngine, crypto, devices, FolderTransport } from "@cashu/sync";
import { InMemoryKeyStore } from "@cashu/sync/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SqlAttemptJournal } from "./attemptJournal.js";
import { takeWriterLease } from "./lease.js";
import { openNativeVault } from "./nativeVault.js";
import { loadDeviceAuthority } from "./sync/keys/deviceAuthority.js";
import { SqlProvenanceStore } from "./sync/keys/sqlProvenance.js";
import { type NativeVaultFixture, nativeVaultFixture } from "./testing/nativeVaultFixture.js";

const fixtures: NativeVaultFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function fixture(): Promise<NativeVaultFixture> {
  const value = await nativeVaultFixture();
  fixtures.push(value);
  return value;
}

function openWithLock(value: NativeVaultFixture) {
  const lock = acquireHostLock(join(value.dataDir, "host.lock.db"));
  if (!lock) throw new Error("synthetic lock busy");
  return { lock, lease: takeWriterLease(lock) };
}

describe("native admission and durability", () => {
  it("keeps a post-append receipt failure unknown across native reopen", async () => {
    const value = await fixture();
    const { lock, lease } = openWithLock(value);
    const entry = value.vaultSource.provider.inventory[0];
    if (!entry) throw new Error("missing synthetic inventory");
    const opened = await openNativeVault(
      entry,
      value.dataDir,
      value.vaultSource.provider,
      lease,
      Date.now,
    );
    const key = "01K9B2W0000000000000000040";
    const session = {
      vault: entry.vaultId,
      device: entry.deviceId,
      store: opened.store,
      engine: opened.engine,
      clock: { now: Date.now },
      lease: { isHolder: () => true },
      attempts: {
        lookup: (vault: string, requestKey: string) => opened.attempts.lookup(vault, requestKey),
        saveMayAppend: opened.attempts.saveMayAppend.bind(opened.attempts),
        recordTerminal: opened.attempts.recordTerminal.bind(opened.attempts),
        markCompleted: async () => {
          throw new Error("synthetic receipt persistence fault");
        },
        unresolved: opened.attempts.unresolved.bind(opened.attempts),
      },
      queue: { run: (_vault, task) => opened.queue.run(task) },
      isCurrent: () => opened.isCurrent(),
      newAttemptId: () => "synthetic-receipt-fault-attempt",
    } satisfies Parameters<typeof executeDurableCommand>[0];
    const first = await executeDurableCommand(
      session,
      renameProfile,
      { name: "After append" },
      key,
    );
    expect(first.kind).toBe("outcome_unknown");
    expect(opened.store.read<{ name: string }>("SELECT name FROM profiles")).toEqual([
      { name: "After append" },
    ]);
    expect(opened.attempts.status(entry.vaultId, key, renameProfile.id).phase).toBe("may_append");
    await opened.close();

    const reopened = await openNativeVault(
      entry,
      value.dataDir,
      value.vaultSource.provider,
      lease,
      Date.now,
    );
    expect(reopened.attempts.status(entry.vaultId, key, renameProfile.id).phase).toBe("may_append");
    const eventCountBeforeRetry = reopened.store.read<{ n: number }>(
      "SELECT COUNT(*) AS n FROM event_log",
    );
    const retrySession = {
      ...session,
      store: reopened.store,
      engine: reopened.engine,
      attempts: reopened.attempts,
      queue: { run: (_vault, task) => reopened.queue.run(task) },
      isCurrent: () => reopened.isCurrent(),
    } satisfies Parameters<typeof executeDurableCommand>[0];
    expect(
      (await executeDurableCommand(retrySession, renameProfile, { name: "After append" }, key))
        .kind,
    ).toBe("outcome_unknown");
    expect(
      await executeDurableCommand(retrySession, renameProfile, { name: "Different" }, key),
    ).toEqual({ kind: "refused", reason: "request_key_conflict" });
    expect(reopened.store.read<{ name: string }>("SELECT name FROM profiles")).toEqual([
      { name: "After append" },
    ]);
    expect(reopened.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM event_log")).toEqual(
      eventCountBeforeRetry,
    );
    expect(
      reopened.store.eventHlcs(first.kind === "outcome_unknown" ? (first.eids ?? []) : []).size,
    ).toBe(1);
    await reopened.close();
    lock.release();
  });

  it("admits a paired native device only after SAS welcome and signed log membership", async () => {
    const value = await fixture();
    const { sodium, keyStore, inventory } = value.vaultSource.provider;
    const creatorEntry = inventory[0];
    if (!creatorEntry) throw new Error("missing synthetic creator");
    const creatorRing = await crypto.loadKeyring(keyStore, sodium, value.vaultId);
    const creatorIdentity = await crypto.loadDeviceIdentity(keyStore, creatorEntry.deviceId);
    if (!creatorRing || !creatorIdentity) throw new Error("missing synthetic creator authority");
    const creatorMeta = openNodeSqlite(join(creatorEntry.vaultRoot, "private.db"));
    const creatorProvenance = SqlProvenanceStore.open(creatorMeta, creatorRing, "existing");
    const creatorCandidate = await loadDeviceAuthority({
      entry: creatorEntry,
      dataDir: value.dataDir,
      keyStore,
      sodium,
      provenance: creatorProvenance,
      clock: Date.now,
      bootstrapCertificates: await value.vaultSource.provider.bootstrapCertificates(),
    });
    const creatorSalt = creatorRing.gidSalt();
    const creatorStore = Store.open({
      driver: openNodeSqlite(join(creatorEntry.vaultRoot, "view.db")),
      vault: value.vaultId,
      salt: vaultSalt(creatorSalt.expose().slice()),
      modules: builtinModules(),
    });
    creatorSalt.wipe();
    const creatorEngine = await createSyncEngine({
      vault: value.vaultId,
      device: creatorEntry.deviceId,
      local: new FolderTransport({ fs: new NodeFolderFs(join(creatorEntry.vaultRoot, "log")) }),
      remotes: [],
      codec: createOwnLogCodec({
        sodium,
        ring: creatorCandidate.ring,
        signer: creatorCandidate.identity,
      }),
      gate: creatorCandidate.gate,
      sink: creatorStore.sink(),
      clockStore: metaClockStore(creatorStore.driver, creatorEntry.deviceId),
      gateState: metaGateStateStore(creatorStore.driver, creatorEntry.deviceId),
    });
    expect((await creatorEngine.recoverLocal()).complete).toBe(true);
    expect(creatorCandidate.devices.registry.isTrusted(creatorEntry.deviceId)).toBe(true);

    const peerIdentity = crypto.createDeviceIdentity(sodium);
    const invited = devices.PairingInviter.create({
      sodium,
      identity: creatorIdentity,
      ring: creatorRing,
      registry: creatorCandidate.devices.registry,
      now: Date.now(),
    });
    if (!invited.ok) throw new Error(invited.reason);
    const scanned = devices.PairingJoiner.start(
      { sodium, identity: peerIdentity, name: "Synthetic peer" },
      invited.value.qr,
      Date.now(),
    );
    if (!scanned.ok) throw new Error(scanned.reason);
    const challenge = invited.value.inviter.receiveHello(scanned.value.hello, Date.now());
    if (!challenge.ok) throw new Error(challenge.reason);
    const reveal = scanned.value.joiner.receiveChallenge(challenge.value.reply, Date.now());
    if (!reveal.ok) throw new Error(reveal.reason);
    const ready = invited.value.inviter.receiveReveal(reveal.value.reply, Date.now());
    if (!ready.ok) throw new Error(ready.reason);
    const wrongSas = reveal.value.sas === "000000" ? "000001" : "000000";
    expect(
      invited.value.inviter.confirm(wrongSas, "01K9B2W0000000000000000041", Date.now()).ok,
    ).toBe(false);
    const confirmed = invited.value.inviter.confirm(
      reveal.value.sas,
      "01K9B2W0000000000000000042",
      Date.now(),
    );
    if (!confirmed.ok) throw new Error(confirmed.reason);
    let welcome = scanned.value.joiner.receiveWelcome(confirmed.value.reply);
    if (!welcome.ok) throw new Error(welcome.reason);
    for (const page of confirmed.value.pages) {
      if (welcome.value.done) break;
      welcome = scanned.value.joiner.receivePage(page);
      if (!welcome.ok) throw new Error(welcome.reason);
    }
    if (!welcome.value.done) throw new Error("incomplete synthetic welcome");
    const peerRing = welcome.value.welcome.ring;
    const peerCert = welcome.value.welcome.certificate;
    expect(peerRing.vaultId).toBe(value.vaultId);

    const peerRoot = join(value.dataDir, "vaults", `peer-${peerIdentity.deviceId}`);
    mkdirSync(peerRoot);
    const peerEntry = {
      vaultId: value.vaultId,
      deviceId: peerIdentity.deviceId,
      vaultRoot: peerRoot,
      state: "ready" as const,
      enrollment: "pairing" as const,
    };
    const peerKeyStore = new InMemoryKeyStore();
    await crypto.saveKeyring(peerKeyStore, peerRing);
    await crypto.saveDeviceIdentity(peerKeyStore, peerIdentity);
    const peerMeta = openNodeSqlite(join(peerRoot, "private.db"));
    const peerProvenance = SqlProvenanceStore.open(peerMeta, peerRing, "new");
    devices.recordPairingProvenance(peerProvenance, peerRing, creatorEntry.deviceId, Date.now());
    SqlAttemptJournal.open(peerMeta, "new", Date.now);
    peerMeta.close();
    const peerSalt = peerRing.gidSalt();
    const peerStore = Store.open({
      driver: openNodeSqlite(join(peerRoot, "view.db")),
      vault: value.vaultId,
      salt: vaultSalt(peerSalt.expose().slice()),
      modules: builtinModules(),
    });
    peerSalt.wipe();
    peerStore.close();
    cpSync(join(creatorEntry.vaultRoot, "log"), join(peerRoot, "log"), { recursive: true });

    const peerSource = {
      inventory: [peerEntry],
      keyStore: peerKeyStore,
      sodium,
      bootstrapCertificates: async () => [
        ...(await value.vaultSource.provider.bootstrapCertificates()),
        peerCert,
      ],
    };
    const { lock, lease } = openWithLock(value);
    await expect(
      openNativeVault(peerEntry, value.dataDir, peerSource, lease, Date.now),
    ).rejects.toThrow("untrusted_identity");
    await creatorEngine.write([confirmed.value.deviceAdded]);
    await creatorEngine.close();
    creatorStore.close();
    creatorCandidate.close();
    creatorMeta.close();
    cpSync(join(creatorEntry.vaultRoot, "log"), join(peerRoot, "log"), {
      recursive: true,
      force: true,
    });
    const opened = await openNativeVault(peerEntry, value.dataDir, peerSource, lease, Date.now);
    expect(opened.isCurrent()).toBe(true);
    expect(opened.store.read<{ gid: string }>("SELECT gid FROM profiles")).toEqual([
      { gid: value.vaultId },
    ]);
    await opened.close();
    lock.release();
    peerRing.wipe();
    peerIdentity.wipe();
    creatorRing.wipe();
    creatorIdentity.wipe();
  });
});
