// A Node stand-in for the Mac's side of a pairing over the relay (the host's pairing service is built
// separately): a vault created with its recovery key and authority, an engine over a memory log, and the
// inviter run over `FirestorePairingLink` on the fake Firebase, with the member write under the test's
// control (the commit point). Synthetic vault, devices and names only; test code only.
import {
  betterSqlite3Driver,
  builtinModules,
  createProfile,
  prepareCommand,
  Store,
  toUnstampedEvent,
  vaultSalt,
} from "@cashu/store";
import {
  initializeMetaClockGuard,
  loadDeviceAuthority,
  metaClockGuardStore,
  metaClockStore,
  metaGateStateStore,
  mintUlid,
  SqlProvenanceStore,
} from "@cashu/store/sync";
import {
  AnonymousAuth,
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  devices,
  FirestorePairingLink,
  FirestoreRelayAdmin,
  FirestoreRest,
  pairingSessionId,
  type SyncEngine,
} from "@cashu/sync";
import { type FakeFirebase, MemoryAuthStore, MemoryTransport } from "@cashu/sync/testing/firestore";
import Database from "better-sqlite3";
import { memoryKeyStore } from "../../../selftest/testing/runtime";

export interface TestMac {
  readonly vault: string;
  readonly device: string;
  readonly uid: string;
  readonly rest: FirestoreRest;
  readonly engine: SyncEngine;
  readonly candidate: Awaited<ReturnType<typeof loadDeviceAuthority>>;
}

/** A relay user on the fake (its own anonymous identity). */
export async function relayUser(fake: FakeFirebase) {
  const auth = new AnonymousAuth({
    endpoint: fake.identity,
    store: new MemoryAuthStore(),
    fetch: fake.fetch,
  });
  const uid = await auth.uid();
  const rest = new FirestoreRest({
    endpoint: fake.endpoint,
    auth,
    fetch: fake.fetch,
    retries: 0,
    sleep: async () => {},
  });
  return { uid, rest, auth };
}

/** A Mac holding a fresh vault (profile "Ala"), registered at the fake relay as its admin. */
export async function createTestMac(fake: FakeFirebase, sodium: crypto.Sodium): Promise<TestMac> {
  const now = () => Date.now();
  const eid = () => mintUlid(now(), (n) => sodium.randomBytes(n));
  const recovery = crypto.recoveryIdentity(sodium, crypto.createRecoveryKey(sodium).phrase);
  const identity = crypto.createDeviceIdentity(sodium);
  const created = crypto.createVaultWithRecovery(sodium, recovery, identity);
  const vault = created.ring.vaultId;
  const device = identity.deviceId;
  const keyStore = memoryKeyStore(sodium);
  await crypto.saveDeviceIdentity(keyStore, identity);
  await crypto.saveKeyring(keyStore, created.ring);
  const provenance = SqlProvenanceStore.open(
    betterSqlite3Driver(new Database(":memory:")),
    created.ring,
    "new",
  );
  provenance.put({
    kid: created.ring.active.kid,
    generation: created.ring.active.generation,
    epoch: created.ring.active.epoch,
    sender: device,
    recipients: null,
    source: "own",
    receivedAt: now(),
  });
  const salt = created.ring.gidSalt();
  const store = Store.open({
    driver: betterSqlite3Driver(new Database(":memory:")),
    vault,
    salt: vaultSalt(salt.expose().slice()),
    modules: builtinModules(),
  });
  salt.wipe();
  initializeMetaClockGuard(store.driver, device);
  const candidate = await loadDeviceAuthority({
    vaultId: vault,
    deviceId: device,
    keyStore,
    sodium,
    provenance,
    clock: now,
    bootstrapCertificates: [created.creatorCertificate],
  });
  const engine = await createSyncEngine({
    vault,
    device,
    local: new MemoryTransport(),
    remotes: [],
    codec: createOwnLogCodec({ sodium, ring: candidate.ring, signer: candidate.identity }),
    gate: candidate.gate,
    sink: store.sink(),
    clockStore: metaClockStore(store.driver, device),
    clockGuard: metaClockGuardStore(store.driver, device),
    gateState: metaGateStateStore(store.driver, device),
    gossipEid: eid,
  });
  await engine.write([
    devices.buildDeviceAdded(
      candidate.identity,
      vault,
      eid(),
      {
        deviceId: device,
        signPublicKey: identity.signPublicKey,
        boxPublicKey: identity.box.publicKey,
      },
      "Mac",
      created.creatorCertificate,
    ),
    devices.creatorPin(candidate.identity, recovery, vault, eid(), now()),
  ]);
  const prepared = prepareCommand(
    store,
    createProfile,
    { slug: "ala", name: "Ala", baseCurrency: "PLN", modules: ["budget"] },
    { device, clock: { now }, lease: { isHolder: () => false } },
  );
  if (!prepared.ok) throw new Error(prepared.reason);
  await engine.write(prepared.events.map(toUnstampedEvent));
  const user = await relayUser(fake);
  await new FirestoreRelayAdmin({ rest: user.rest }).createVault(vault, { uid: user.uid, device });
  return { vault, device, uid: user.uid, rest: user.rest, engine, candidate };
}

/** How the test Mac behaves after the six digits. */
export interface InviteControl {
  /** The QR's relay hint (default `fb1:demo-cashu`, the fake's project). */
  readonly rendezvous?: string;
  /** Invite lifetime (default 5 minutes). */
  readonly ttlMs?: number;
  /**
   * Runs after the welcome left and before the member document is written; the member is written only
   * when it resolves true (the commit point under the test's control).
   */
  readonly beforeAdmit?: () => Promise<boolean>;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Open an invitation on the test Mac: the QR, and `run()`, the inviter over the relay (types the code the
 * phone shows, as soon as it shows it), then the member document of the claimant.
 */
export async function openInvite(mac: TestMac, sodium: crypto.Sodium, control: InviteControl = {}) {
  const now = () => Date.now();
  const created = devices.PairingInviter.create({
    sodium,
    identity: mac.candidate.identity,
    ring: mac.candidate.ring,
    registry: mac.candidate.devices.registry,
    now: now(),
    rendezvous: control.rendezvous ?? "fb1:demo-cashu",
    ...(control.ttlMs === undefined ? {} : { ttlMs: control.ttlMs }),
  });
  if (!created.ok) throw new Error(created.reason);
  const link = new FirestorePairingLink({
    rest: mac.rest,
    uid: async () => mac.uid,
    vault: mac.vault,
    sessionId: pairingSessionId(created.value.inviter.invite),
    side: "inviter",
    pollMs: 5,
    ...(control.sleep === undefined ? {} : { sleep: control.sleep }),
  });
  // A session that outlives a short-lived test invite, so an expired QR is the phone's check alone.
  await link.open(Math.max(created.value.inviter.invite.expiresAt, now() + 60_000));
  let shown: ((code: string) => void) | undefined;
  const code = new Promise<string>((resolve) => {
    shown = resolve;
  });
  return {
    qr: created.value.qr,
    link,
    /** The phone shows its code: hand it to the Mac's owner. */
    typeCode: (sas: string) => shown?.(sas),
    async run(): Promise<{ ok: boolean; admitted: boolean }> {
      const result = await devices.runInviter(created.value.inviter, link, {
        now,
        enterCode: () => code,
        eid: () => mintUlid(now(), (n) => sodium.randomBytes(n)),
      });
      if (!result.ok) return { ok: false, admitted: false };
      await mac.engine.write([result.value.deviceAdded]);
      if (control.beforeAdmit !== undefined && !(await control.beforeAdmit())) {
        return { ok: true, admitted: false };
      }
      const joiner = await link.joinerUid();
      if (joiner === undefined) return { ok: true, admitted: false };
      await new FirestoreRelayAdmin({ rest: mac.rest }).addMember(mac.vault, {
        uid: joiner,
        device: result.value.device.deviceId,
      });
      return { ok: true, admitted: true };
    },
  };
}
