// End to end under the real security rules: a native host (temp data dir, in-memory keys, never an OS
// keychain) switches sync on for a synthetic vault at the Firestore + Auth emulators (project
// `demo-cashu`, a fresh named database, `/firestore.rules` loaded by `firebase emulators:exec`), invites a
// device, and a Node joiner pairs with the six digits and then syncs as the phone does. The joiner is built
// from the packages the phone's own modules compose (apps never import another app):
// `devices.PairingJoiner` + `devices.runJoiner` over a joiner-side `FirestorePairingLink`, then the welcome
// kept like `apps/mobile/src/services/vaultBootstrap.ts` keeps it (own log in `SqlLogTransport` over a
// SQLite file, pairing provenance, the welcome's certificate chain and registry events) and the engine
// composed like `vaultEngine.ts` composes it (store sink, meta clock / guard / gate stores, the relay as
// its one remote). Then: writes cross both ways, the host reaches `completed`, the relay documents hold only
// the fields the rules allow and no plaintext, a stranger reads nothing, and after a purge the joiner's
// next pass is refused (403: `forbidden`, which the phone shows as removed / sync off).
// Skipped unless the emulators run (`pnpm test:emulator` at the repo root). Synthetic data only.
import { join } from "node:path";
import type { HostConnection } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  addCashExpense,
  builtinModules,
  type Command,
  metaClockStore,
  metaGateStateStore,
  prepareCommand,
  renameProfile,
  Store,
  toUnstampedEvent,
  vaultSalt,
} from "@cashu/store";
import {
  initializeMetaClockGuard,
  loadDeviceAuthority,
  metaClockGuardStore,
  mintUlid,
  SqlLogTransport,
  SqlProvenanceStore,
} from "@cashu/store/sync";
import {
  AnonymousAuth,
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  devices,
  FirestorePairingLink,
  FirestoreRest,
  FirestoreRestError,
  FirestoreTransport,
  pairingSessionId,
  type SyncEngine,
} from "@cashu/sync";
import { InMemoryKeyStore, MemoryAuthStore } from "@cashu/sync/testing";
import { afterAll, describe, expect, it } from "vitest";
import { runHostVaultCommand } from "../commands.js";
import { type LocalHost, startLocalHost } from "../host.js";
import { memoryLog } from "../log.js";
import {
  RELAY_MIN_PULL_GAP_MS,
  RELAY_PULL_INTERVAL_MS,
  RELAY_PUSH_DEBOUNCE_MS,
} from "../relay/policy.js";
import type { HostRelayOptions } from "../relay/service.js";
import {
  type EmulatorHosts,
  emulatorDatabase,
  emulatorFirestore,
  emulatorHosts,
  emulatorIdentityEndpoint,
  emulatorRelayEndpoints,
  type RawDocument,
  rawVaultDocuments,
} from "./emulatorRelay.js";
import { HANDOVER_EXIT_CODE, relayHarness } from "./relayFixture.js";

const hosts = emulatorHosts();
const TIMEOUT = 180_000;

// Synthetic values the oracles search the raw relay documents for (none may appear in plaintext).
const MAC_MERCHANT = "Zielony Kramik Syntetyczny";
const MAC_AMOUNT = "4321.87";
const PHONE_MERCHANT = "Piekarnia Testowa Qwx";
const PHONE_AMOUNT = "77.13";
const PHONE_PROFILE_NAME = "Profil z telefonu syntetyczny";
const PHONE_DEVICE_NAME = "Synthetic e2e phone";

/** The fields `firestore.rules` lets each document kind hold (`hasOnly`), by relative path shape. */
const ALLOWED_FIELDS: readonly { readonly path: RegExp; readonly fields: readonly string[] }[] = [
  { path: /^vaults\/[0-9a-f]{32}$/, fields: ["createdAt", "admins", "recoveryHash"] },
  { path: /^vaults\/[0-9a-f]{32}\/members\/[^/]+$/, fields: ["device", "role", "addedAt"] },
  { path: /^vaults\/[0-9a-f]{32}\/recoveries\/[^/]+$/, fields: ["proof"] },
  {
    path: /^vaults\/[0-9a-f]{32}\/segments\/[0-9a-f]{32}_[0-9]{10}$/,
    fields: ["device", "seg", "size", "updatedAt", "writer", "rev"],
  },
  {
    path: /^vaults\/[0-9a-f]{32}\/segments\/[0-9a-f]{32}_[0-9]{10}\/chunks\/[0-9]{12}$/,
    fields: ["start", "end", "bytes"],
  },
  {
    path: /^vaults\/[0-9a-f]{32}\/pairings\/[^/]+$/,
    fields: ["inviter", "joiner", "expiresAt", "createdAt"],
  },
  {
    path: /^vaults\/[0-9a-f]{32}\/pairings\/[^/]+\/messages\/[0-9]{4}$/,
    fields: ["from", "n", "box", "part", "parts", "createdAt"],
  },
];

/** Every byte string a document holds: its raw JSON and each `bytesValue` decoded. */
function documentBytes(doc: RawDocument): Buffer[] {
  const out = [Buffer.from(doc.json, "utf8")];
  for (const value of Object.values(doc.fields)) {
    const bytes = value.bytesValue;
    if (typeof bytes === "string") out.push(Buffer.from(bytes, "base64"));
  }
  return out;
}

/** The host's and the relay's clock: real time plus an offset the test moves forward. */
function testClock() {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advance(ms: number) {
      offset += ms;
    },
  };
}

/** Polls the async `check` until true; fails after `ms`. */
async function eventually(check: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** "ok" or the REST error code of the call. */
async function outcome(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "ok";
  } catch (error) {
    if (error instanceof FirestoreRestError) return error.code;
    throw error;
  }
}

/** An anonymous identity of its own at the emulator and a REST client as it. */
async function anonymous(h: EmulatorHosts, database: string) {
  const auth = new AnonymousAuth({
    endpoint: emulatorIdentityEndpoint(h),
    store: new MemoryAuthStore(),
  });
  const uid = await auth.uid();
  const rest = new FirestoreRest({
    endpoint: emulatorFirestore(h, database),
    auth,
    retries: 0,
    sleep: async () => {},
  });
  return { auth, uid, rest };
}

interface Joiner {
  readonly uid: string;
  readonly device: string;
  readonly store: Store;
  readonly local: SqlLogTransport;
  readonly relay: FirestoreTransport;
  readonly engine: SyncEngine;
  write(command: Command<unknown, unknown>, input: unknown): Promise<void>;
  close(): Promise<void>;
}

const harness = relayHarness();
const started: LocalHost[] = [];
const clients: HostConnection[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const client of clients.splice(0)) client.close();
  for (const host of started.splice(0)) await host.stop().catch(() => {});
  await harness.cleanup();
});

describe.skipIf(!hosts)("host <-> Node joiner over the emulator, real security rules", () => {
  it(
    "pairs, converges both ways, stores only ciphertext, shuts out a stranger and refuses the purged joiner",
    async () => {
      if (!hosts) return;
      const database = emulatorDatabase("e2e");
      const env = await harness.setup();
      const vault = env.vault;
      const macDevice = env.fixture.vaultSource.provider.inventory[0]?.deviceId as string;
      const sodium = env.fixture.vaultSource.provider.sodium;
      const clock = testClock();
      const macAuth = new MemoryAuthStore();
      const relay: HostRelayOptions = {
        endpoints: emulatorRelayEndpoints(hosts, database),
        authStore: () => macAuth,
        retries: 0,
        timers: env.timers,
        now: clock.now,
      };
      const start = async () => {
        const host = await startLocalHost({
          dataDir: env.fixture.dataDir,
          home: env.fixture.home,
          build: "test",
          launcher: false,
          log: memoryLog(),
          vaultSource: env.fixture.vaultSource,
          now: clock.now,
          relay,
        });
        started.push(host);
        return host;
      };
      const ui = async () => {
        const client = await env.ui();
        clients.push(client);
        return client;
      };
      const raw = () => rawVaultDocuments(hosts, database, vault);
      const segmentDocs = async () =>
        (await raw()).filter((doc) => /\/segments\/[^/]+$/.test(doc.path));

      // ---- The Mac switches sync on: the vault and its admin membership are created under the rules.
      const first = await start();
      const enabled = await (await ui()).call("native.relay.enable", { vault });
      expect(enabled).toEqual({ kind: "done" });
      expect(await first.exit).toBe(HANDOVER_EXIT_CODE);
      let host = await start();
      env.timers.advance(0);
      await eventually(async () => host.relay.pending() === 0 && (await segmentDocs()).length > 0);
      const macUid = macAuth.record?.uid as string;
      expect(macUid).toEqual(expect.any(String));
      const macView = () => host.stores.vaults.get(vault)?.native?.store as Store;
      let mac = await ui();

      // ---- The invitation, and the joiner pairing with the six digits.
      const invite = (await mac.call("native.pairing.invite", { vault })) as {
        kind: string;
        qr?: string;
        operationId?: string;
      };
      expect(invite.kind).toBe("ready");
      const qr = invite.qr as string;
      const operationId = invite.operationId as string;
      const invitation = devices.decodeInvite(qr);
      if (invitation === undefined) throw new Error("qr undecodable");
      expect(invitation.rendezvous).toBe("fb1:demo-cashu");
      expect(invitation.vaultId).toBe(vault);

      const phone = await anonymous(hosts, database);
      const identity = crypto.createDeviceIdentity(sodium);
      const link = new FirestorePairingLink({
        rest: phone.rest,
        uid: () => phone.auth.uid(),
        vault,
        sessionId: pairingSessionId(invitation),
        side: "joiner",
        pollMs: 100,
        now: clock.now,
        receiveTimeoutMs: 60_000,
      });
      const joining = devices.PairingJoiner.start(
        { sodium, identity, name: PHONE_DEVICE_NAME },
        qr,
        clock.now(),
      );
      if (!joining.ok) throw new Error(joining.reason);
      await link.claim();
      let confirmed: Promise<{ kind: string; device?: string }> | undefined;
      let memberBeforeCode: string | undefined = "unread";
      const welcome = await devices.runJoiner(joining.value.joiner, joining.value.hello, link, {
        now: clock.now,
        showSas: (sas) => {
          confirmed = (async () => {
            memberBeforeCode = (await raw()).find((doc) =>
              doc.path.endsWith(`/members/${phone.uid}`),
            )?.path;
            return (await mac.call("native.pairing.confirm", {
              vault,
              operationId,
              code: sas,
            })) as { kind: string; device?: string };
          })();
        },
      });
      if (!welcome.ok) throw new Error(`joiner ${String(welcome.reason)}`);
      if (confirmed === undefined) throw new Error("no code shown");
      // Nothing admits the joiner before the six digits; after them it is a member bound to its device.
      expect(memberBeforeCode).toBeUndefined();
      expect(await confirmed).toMatchObject({
        kind: "waiting_for_phone",
        device: identity.deviceId,
      });
      const phoneMember = (await raw()).find((doc) => doc.path.endsWith(`/members/${phone.uid}`));
      expect(phoneMember?.fields.device).toEqual({ stringValue: identity.deviceId });
      expect(phoneMember?.fields.role).toEqual({ stringValue: "member" });
      expect(
        ((await mac.call("native.pairing.inspect", { vault, operationId })) as { kind: string })
          .kind,
      ).toBe("waiting_for_phone");

      // ---- The joiner keeps the welcome as the phone does and opens its engine over its own log.
      const joiner = await keepWelcome(welcome.value);
      closers.push(() => joiner.close());
      const firstPass = await joiner.engine.sync();
      expect(firstPass.offlineRemotes).toBe(0);
      expect(joiner.relay.status().lastError).toBeUndefined();
      const fixtureName = profileName(macView());
      expect(fixtureName).toEqual(expect.any(String));
      expect(profileName(joiner.store)).toBe(fixtureName);

      // The Mac sees the joiner's first signed frame through the relay: `completed`.
      let state = "";
      for (let round = 0; round < 60 && state !== "completed"; round++) {
        state = (
          (await mac.call("native.pairing.inspect", { vault, operationId })) as { kind: string }
        ).kind;
        if (state === "completed") break;
        clock.advance(RELAY_MIN_PULL_GAP_MS);
        env.timers.advance(RELAY_MIN_PULL_GAP_MS);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(state).toBe("completed");

      // ---- A command on the Mac reaches the joiner.
      const opened = host.stores.vaults.get(vault);
      if (opened === undefined) throw new Error("vault not open");
      const macWrite = await runHostVaultCommand(
        opened,
        addCashExpense,
        { amount: MAC_AMOUNT, title: MAC_MERCHANT, category: "groceries", onDate: "2026-11-02" },
        "e2e-mac-expense",
      );
      expect(macWrite.kind).toBe("completed");
      clock.advance(RELAY_PUSH_DEBOUNCE_MS);
      env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
      await eventually(() => host.relay.pending() === 0);
      await eventually(async () => {
        await joiner.engine.sync();
        return cashRows(joiner.store).some((row) => row.description === MAC_MERCHANT);
      });
      expect(joiner.relay.status().lastError).toBeUndefined();

      // ---- Commands on the joiner reach the Mac (its pull timer).
      await joiner.write(renameProfile as Command<unknown, unknown>, { name: PHONE_PROFILE_NAME });
      await joiner.write(addCashExpense as Command<unknown, unknown>, {
        amount: PHONE_AMOUNT,
        title: PHONE_MERCHANT,
        category: "groceries",
        onDate: "2026-11-03",
      });
      const pushed = await joiner.engine.sync();
      expect(pushed.offlineRemotes).toBe(0);
      await eventually(async () => {
        clock.advance(RELAY_PULL_INTERVAL_MS);
        env.timers.advance(RELAY_PULL_INTERVAL_MS);
        await eventually(() => host.relay.pending() === 0);
        return (
          profileName(macView()) === PHONE_PROFILE_NAME &&
          cashRows(macView()).some((row) => row.description === PHONE_MERCHANT)
        );
      }, 60_000);

      // Both sides hold the same events: the same rows in their views, and the joiner's own log holds
      // every writer's stream to the byte the relay holds it.
      await joiner.engine.sync();
      expect(cashRows(joiner.store)).toEqual(cashRows(macView()));
      expect(cashRows(macView()).map((row) => [row.description, row.amount])).toEqual(
        expect.arrayContaining([
          [MAC_MERCHANT, `-${MAC_AMOUNT}`],
          [PHONE_MERCHANT, `-${PHONE_AMOUNT}`],
        ]),
      );
      expect(profileName(joiner.store)).toBe(PHONE_PROFILE_NAME);
      const relayStreams = (await segmentDocs())
        .map((doc) => {
          const f = doc.fields as Record<string, { stringValue?: string; integerValue?: string }>;
          return `${f.device?.stringValue}/${f.seg?.integerValue}:${f.size?.integerValue}`;
        })
        .sort();
      const localStreams = (await joiner.local.list(vault))
        .filter((s) => s.size > 0)
        .map((s) => `${s.device}/${s.seg}:${s.size}`)
        .sort();
      expect(localStreams).toEqual(relayStreams);
      expect(new Set(relayStreams.map((s) => s.split("/")[0]))).toEqual(
        new Set([macDevice, identity.deviceId]),
      );

      // ---- What the relay stores: only the fields the rules allow, opaque ids, no plaintext.
      const documents = await raw();
      expect(documents.length).toBeGreaterThan(5);
      for (const doc of documents) {
        const shape = ALLOWED_FIELDS.find((allowed) => allowed.path.test(doc.path));
        expect(shape, doc.path).toBeDefined();
        for (const field of Object.keys(doc.fields))
          expect(shape?.fields, `${doc.path} ${field}`).toContain(field);
      }
      const chunkBytes = documents
        .filter((doc) => doc.path.includes("/chunks/"))
        .reduce((sum, doc) => sum + (documentBytes(doc)[1]?.length ?? 0), 0);
      expect(chunkBytes).toBeGreaterThan(0);
      const needles = [
        MAC_MERCHANT,
        MAC_AMOUNT,
        PHONE_MERCHANT,
        PHONE_AMOUNT,
        PHONE_PROFILE_NAME,
        PHONE_DEVICE_NAME,
        fixtureName as string,
        "groceries",
        "cashExpenseAdded",
      ];
      for (const doc of documents)
        for (const bytes of documentBytes(doc))
          for (const needle of needles)
            expect(bytes.includes(Buffer.from(needle, "utf8")), `${needle} in ${doc.path}`).toBe(
              false,
            );

      // ---- A stranger (signed in, never admitted) reads nothing of the vault.
      const stranger = await anonymous(hosts, database);
      const someSegment = (await segmentDocs())[0]?.path as string;
      const someChunk = documents.find((doc) => doc.path.includes("/chunks/"))?.path as string;
      expect(await outcome(stranger.rest.get(`vaults/${vault}`))).toBe("permission-denied");
      expect(await outcome(stranger.rest.get(`vaults/${vault}/members/${macUid}`))).toBe(
        "permission-denied",
      );
      expect(await outcome(stranger.rest.get(someSegment))).toBe("permission-denied");
      expect(await outcome(stranger.rest.get(someChunk))).toBe("permission-denied");
      for (const collectionId of ["members", "segments", "pairings", "recoveries"])
        expect(
          await outcome(stranger.rest.runQuery(`vaults/${vault}`, { collectionId })),
          collectionId,
        ).toBe("permission-denied");
      const strangerTransport = new FirestoreTransport({
        rest: stranger.rest,
        uid: () => stranger.auth.uid(),
      });
      await expect(strangerTransport.list(vault)).rejects.toThrow();
      expect(strangerTransport.status().lastError).toBe("forbidden");

      // ---- The Mac purges the vault at the relay: the joiner's membership goes, its next pass is refused.
      const purged = await mac.call("native.relay.purge", { vault });
      expect(purged).toEqual({ kind: "done" });
      expect(await host.exit).toBe(HANDOVER_EXIT_CODE);
      host = await start();
      mac = await ui();
      const after = await raw();
      expect(after.find((doc) => doc.path.endsWith(`/members/${phone.uid}`))).toBeUndefined();
      expect(after.find((doc) => doc.path.endsWith(`/members/${macUid}`))).toBeDefined();
      expect(after.filter((doc) => doc.path.includes("/segments/"))).toEqual([]);
      const refused = await joiner.engine.sync();
      expect(refused.offlineRemotes).toBeGreaterThan(0);
      expect(joiner.relay.status().lastError).toBe("forbidden");
      // The joiner keeps what it had; nothing new reached the relay from it.
      expect(profileName(joiner.store)).toBe(PHONE_PROFILE_NAME);
      expect((await raw()).filter((doc) => doc.path.includes("/segments/"))).toEqual([]);

      /** The welcome kept like `storeJoinedVault`, the engine opened like `createVaultSession`. */
      async function keepWelcome(value: devices.JoinerWelcome): Promise<Joiner> {
        const now = clock.now;
        const device = identity.deviceId;
        const keyStore = new InMemoryKeyStore();
        await crypto.saveDeviceIdentity(keyStore, identity);
        await crypto.saveKeyring(keyStore, value.ring);
        const logDriver = openNodeSqlite(join(env.fixture.home, `joiner-log-${vault}.db`));
        const local = new SqlLogTransport({ driver: logDriver, vault });
        local.ensureSchema();
        const provenance = SqlProvenanceStore.open(logDriver, value.ring, "new");
        devices.recordPairingProvenance(provenance, value.ring, value.inviter, now());
        const chain = value.registryEvents.flatMap((event) =>
          event.type === devices.DEVICE_ADDED && typeof event.data.certificate === "string"
            ? [Buffer.from(event.data.certificate, "hex")]
            : [],
        );
        const candidate = await loadDeviceAuthority({
          vaultId: vault,
          deviceId: device,
          keyStore,
          sodium,
          provenance,
          clock: now,
          bootstrapCertificates: [...chain, value.certificate],
        });
        candidate.devices.ingest(value.registryEvents);
        const salt = candidate.ring.gidSalt();
        const store = Store.open({
          driver: openNodeSqlite(join(env.fixture.home, `joiner-view-${vault}.db`)),
          vault,
          salt: vaultSalt(salt.expose().slice()),
          modules: builtinModules(),
        });
        salt.wipe();
        initializeMetaClockGuard(store.driver, device);
        const relayTransport = new FirestoreTransport({
          rest: phone.rest,
          uid: () => phone.auth.uid(),
          now,
        });
        const engine = await createSyncEngine({
          vault,
          device,
          local,
          remotes: [relayTransport],
          codec: createOwnLogCodec({ sodium, ring: candidate.ring, signer: candidate.identity }),
          gate: candidate.gate,
          sink: store.sink(),
          clockStore: metaClockStore(store.driver, device),
          clockGuard: metaClockGuardStore(store.driver, device),
          gateState: metaGateStateStore(store.driver, device),
          physicalClock: { now },
          gossipEid: () => mintUlid(now(), (n) => sodium.randomBytes(n)),
        });
        await engine.recoverLocal();
        const commandEnv = { device, clock: { now }, lease: { isHolder: () => false } };
        return {
          uid: phone.uid,
          device,
          store,
          local,
          relay: relayTransport,
          engine,
          async write(command, input) {
            const prepared = prepareCommand(store, command, input, commandEnv);
            if (!prepared.ok) throw new Error(prepared.reason);
            await engine.write(prepared.events.map(toUnstampedEvent));
          },
          async close() {
            await engine.close();
            store.close();
            logDriver.close();
          },
        };
      }
    },
    TIMEOUT,
  );
});

function profileName(store: Store): string | undefined {
  return store.read<{ name: string }>("SELECT name FROM profiles")[0]?.name;
}

/** The cash pool rows of a view, in a stable order (the same events give the same rows). */
function cashRows(store: Store) {
  return store.read<{
    gid: string;
    description: string;
    amount: string;
    currency: string;
    booking_date: string;
  }>(
    "SELECT dedup_hash AS gid, description, amount, currency, booking_date FROM transactions ORDER BY dedup_hash",
  );
}
