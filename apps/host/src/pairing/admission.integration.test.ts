// Beside host.integration.test.ts (which covers the commit point's failure cases): an authority change
// requested right after the member document waits for the admission, and the device kinds and pull
// history the fetch lease keeps after a purge, a re-pair, with a legacy binding and with sync off. Real
// native host composition, one in-memory Firebase fake (`demo-cashu`). The oracles are the relay's
// documents, the vault's device registry, the relay setting and the lease's own answer.
// Synthetic vault, devices and names only.
import type { HostConnection } from "@cashu/node-host";
import {
  type RelaySetting,
  relayDeviceRole,
  relayMemberUid,
  relaySetting,
  setRelaySetting,
} from "@cashu/store/device";
import { runQuery } from "@cashu/store/query";
import {
  AnonymousAuth,
  crypto,
  devices,
  FirestorePairingLink,
  FirestoreRest,
  pairingSessionId,
} from "@cashu/sync";
import { MemoryAuthStore } from "@cashu/sync/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type LocalHost, startLocalHost } from "../host.js";
import { memoryLog } from "../log.js";
import { RELAY_PULL_INTERVAL_MS } from "../relay/policy.js";
import type { HostRelayOptions } from "../relay/service.js";
import {
  HANDOVER_EXIT_CODE,
  type RelayHostEnv,
  relayBytes,
  relayHarness,
  until,
} from "../testing/relayFixture.js";

const harness = relayHarness();
/** Hosts this file starts itself (restarts included): stopped before the harness removes the dirs. */
const started: LocalHost[] = [];
afterEach(async () => {
  for (const host of started.splice(0)) await host.stop().catch(() => {});
  await harness.cleanup();
});

const TIMEOUT = 90_000;

type RelayFetch = NonNullable<HostRelayOptions["fetch"]>;
type RelayFetchHook = (...args: Parameters<RelayFetch>) => ReturnType<RelayFetch> | undefined;

interface Mac {
  readonly env: RelayHostEnv;
  /** The host's and the relay's clock: real time plus an offset the test moves forward. */
  advance(ms: number): void;
  now(): number;
  host: LocalHost;
  ui: HostConnection;
  readonly macUid: string;
  /** Routes the host's relay requests through `hook` (undefined: straight to the fake). */
  intercept(hook: RelayFetchHook | undefined): void;
  /** Stops the host and starts it again on the same data dir (the vault reopens). */
  restart(): Promise<void>;
  /** Runs an owner relay action and, when it hands over, starts the next host. */
  relayAction(method: string): Promise<{ kind: string }>;
}

/** A host whose vault has sync switched on (created at the fake), its first push done. */
async function syncedMac(): Promise<Mac> {
  const env = await harness.setup();
  let offset = 0;
  const now = () => Date.now() + offset;
  let hook: RelayFetchHook | undefined;
  const relay: HostRelayOptions = {
    ...env.relay,
    now,
    fetch: (url, init) => hook?.(url, init) ?? env.fake.fetch(url, init),
  };
  const start = async () => {
    const host = await startLocalHost({
      dataDir: env.fixture.dataDir,
      home: env.fixture.home,
      build: "test",
      launcher: false,
      log: memoryLog(),
      vaultSource: env.fixture.vaultSource,
      now,
      relay,
    });
    started.push(host);
    return host;
  };
  const first = await start();
  const client = await env.ui();
  const enabled = (await client.call("native.relay.enable", { vault: env.vault })) as {
    kind: string;
  };
  if (enabled.kind !== "done") throw new Error("relay enable refused");
  if ((await first.exit) !== HANDOVER_EXIT_CODE) throw new Error("no handover after enable");
  client.close();
  const host = await start();
  env.timers.advance(0);
  await until(() => host.relay.pending() === 0 && relayBytes(env.fake, env.vault) > 0);
  const macUid = env.relay.auth.record?.uid;
  if (macUid === undefined) throw new Error("no relay identity");
  const mac: Mac = {
    env,
    advance(ms) {
      offset += ms;
    },
    now,
    host,
    ui: await env.ui(),
    macUid,
    intercept(next) {
      hook = next;
    },
    async restart() {
      mac.ui.close();
      await mac.host.stop();
      mac.host = await start();
      env.timers.advance(0);
      mac.ui = await env.ui();
    },
    async relayAction(method) {
      const result = (await mac.ui.call(method, { vault: env.vault })) as { kind: string };
      const stopped = await Promise.race([
        mac.host.exit,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
      ]);
      if (stopped === HANDOVER_EXIT_CODE) {
        mac.ui.close();
        mac.host = await start();
        env.timers.advance(0);
        mac.ui = await env.ui();
      }
      return result;
    },
  };
  return mac;
}

const native = (mac: Mac) => {
  const session = mac.host.stores.vaults.get(mac.env.vault)?.native;
  if (session === undefined) throw new Error("vault not open");
  return session;
};

async function ready(mac: Mac): Promise<{ qr: string; operationId: string }> {
  const reply = (await mac.ui.call("native.pairing.invite", { vault: mac.env.vault })) as {
    kind: string;
    qr?: string;
    operationId?: string;
  };
  if (reply.kind !== "ready" || !reply.qr || !reply.operationId)
    throw new Error(`invite ${reply.kind}`);
  return { qr: reply.qr, operationId: reply.operationId };
}

const confirm = (mac: Mac, operationId: string, code: string) =>
  mac.ui.call("native.pairing.confirm", { vault: mac.env.vault, operationId, code }) as Promise<{
    kind: string;
    device?: string;
  }>;

const inspect = async (mac: Mac, operationId: string) =>
  (
    (await mac.ui.call("native.pairing.inspect", { vault: mac.env.vault, operationId })) as {
      kind: string;
    }
  ).kind;

/** The phone: a fresh device identity and its own anonymous relay identity at the fake. */
async function phone(mac: Mac, qr: string, authStore = new MemoryAuthStore()) {
  const { fake, fixture } = mac.env;
  const sodium = fixture.vaultSource.provider.sodium;
  const auth = new AnonymousAuth({ endpoint: fake.identity, store: authStore, fetch: fake.fetch });
  const uid = await auth.uid();
  const rest = new FirestoreRest({
    endpoint: fake.endpoint,
    auth,
    fetch: fake.fetch,
    retries: 0,
    sleep: async () => {},
  });
  const invitation = devices.decodeInvite(qr);
  if (invitation === undefined) throw new Error("qr undecodable");
  const identity = crypto.createDeviceIdentity(sodium);
  const link = new FirestorePairingLink({
    rest,
    uid: () => auth.uid(),
    vault: invitation.vaultId,
    sessionId: pairingSessionId(invitation),
    side: "joiner",
    pollMs: 5,
    now: mac.now,
    receiveTimeoutMs: 20_000,
  });
  return {
    uid,
    auth,
    rest,
    identity,
    async run(onSas: (sas: string) => void) {
      const started = devices.PairingJoiner.start(
        { sodium, identity, name: "Synthetic phone" },
        qr,
        mac.now(),
      );
      if (!started.ok) throw new Error(started.reason);
      await link.claim();
      return devices.runJoiner(started.value.joiner, started.value.hello, link, {
        now: mac.now,
        showSas: onSas,
      });
    },
  };
}

type Phone = Awaited<ReturnType<typeof phone>>;

/** A full pairing: the phone runs the protocol, the owner types its code. */
async function pairPhone(mac: Mac, authStore?: MemoryAuthStore) {
  const { qr, operationId } = await ready(mac);
  const joiner = await phone(mac, qr, authStore);
  let confirmed: Promise<{ kind: string; device?: string }> | undefined;
  const result = await joiner.run((sas) => {
    confirmed = confirm(mac, operationId, sas);
  });
  if (confirmed === undefined) throw new Error("no code shown");
  return { joiner, result, confirmed: await confirmed, operationId };
}

/** One relay pass of the Mac's own (the pull timer), awaited until it reached the relay. */
async function relayPass(mac: Mac): Promise<void> {
  const before = mac.host.relay.status(mac.env.vault).lastSyncAt ?? 0;
  mac.advance(RELAY_PULL_INTERVAL_MS + 1);
  mac.env.timers.advance(RELAY_PULL_INTERVAL_MS + 1);
  await until(() => (mac.host.relay.status(mac.env.vault).lastSyncAt ?? 0) > before);
  // The reconciliation follows the pass's settle signal a turn later.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const memberDoc = (mac: Mac, uid: string) =>
  mac.env.fake
    .documents(`vaults/${mac.env.vault}/members/`)
    .get(`vaults/${mac.env.vault}/members/${uid}`);

const setting = (mac: Mac): RelaySetting | null =>
  runQuery(mac.host.stores.device.store, relaySetting, { vault: mac.env.vault }).value;

async function trusted(mac: Mac, device: string): Promise<boolean | undefined> {
  const list = await native(mac).deviceList();
  if (list.kind !== "ready") throw new Error("device list unavailable");
  return list.devices.find((entry) => entry.id === device)?.trusted;
}

/** Admitted in both places: member document bound to the device, device.added in the vault. */
async function expectAdmitted(mac: Mac, joiner: Phone): Promise<void> {
  expect(memberDoc(mac, joiner.uid)?.fields.device).toEqual({
    stringValue: joiner.identity.deviceId,
  });
  expect(await trusted(mac, joiner.identity.deviceId)).toBe(true);
  const bound = setting(mac)?.memberUids[joiner.identity.deviceId];
  expect(bound === undefined ? undefined : relayMemberUid(bound)).toBe(joiner.uid);
}

/** The host relay's commit that writes `uid`'s member document. */
const writesMember = (mac: Mac, uid: string, url: string, body: string | undefined) =>
  url.endsWith(":commit") && (body ?? "").includes(`vaults/${mac.env.vault}/members/${uid}`);

/**
 * Drops the persisted last complete pull, so with sync off only the devices' kinds decide whether this
 * Mac may lead offline (a phone never leads; an unknown device could).
 */
async function forgetLastCompletePull(mac: Mac): Promise<void> {
  const current = setting(mac);
  if (current === null) throw new Error("no setting");
  const { lastCompletePullAt: _dropped, ...rest } = current;
  const written = await mac.host.stores.device.queue.run(() =>
    mac.host.stores.device.store.run(setRelaySetting, { vault: mac.env.vault, value: rest }),
  );
  if (!written.ok) throw new Error("setting unwritten");
}

async function revoke(mac: Mac, device: string): Promise<void> {
  const preview = (await mac.ui.call("native.devices.revokePreview", {
    vault: mac.env.vault,
    targets: [device],
    recertify: [],
  })) as { kind: string; token?: string };
  if (preview.kind !== "prepared" || !preview.token) throw new Error("preview unavailable");
  const committed = (await mac.ui.call("native.devices.revokeCommit", {
    vault: mac.env.vault,
    token: preview.token,
    warningAcknowledgement: "revoke_risk_acknowledged",
    localStartAcknowledgement: "local_target_stream_never_seen",
    recoveryPhrase: mac.env.fixture.recoveryWords,
  })) as { kind: string };
  if (committed.kind !== "completed") throw new Error(`revoke ${committed.kind}`);
}

describe("the pairing commit point", () => {
  it(
    "a revocation started once the member document is written waits: nothing refuses the admission",
    async () => {
      const mac = await syncedMac();
      const first = await pairPhone(mac);
      expect(first.confirmed.kind).toBe("waiting_for_phone");
      const { qr, operationId } = await ready(mac);
      const joiner = await phone(mac, qr);
      let revoking: Promise<unknown> | undefined;
      mac.intercept((url, init) => {
        if (revoking !== undefined || !writesMember(mac, joiner.uid, url, init.body))
          return undefined;
        // The owner removes the first phone while the second one's membership is written: the
        // vault's authority changes right after the commit point.
        revoking = revoke(mac, first.joiner.identity.deviceId).catch((error: unknown) => error);
        return undefined;
      });
      let confirmed: Promise<{ kind: string }> | undefined;
      await joiner.run((sas) => {
        confirmed = confirm(mac, operationId, sas);
      });
      expect((await confirmed)?.kind).toBe("waiting_for_phone");
      mac.intercept(undefined);
      expect(revoking).toBeDefined();
      await revoking;
      await expectAdmitted(mac, joiner);
      expect(await inspect(mac, operationId)).toBe("waiting_for_phone");
    },
    TIMEOUT,
  );
});

describe("leftover pairing sessions", () => {
  it(
    "deletes a session a crash left at the relay (past its end) at the next invite, keeps a live one",
    async () => {
      const mac = await syncedMac();
      // A session this Mac opened before a crash: never closed, its messages still there.
      const auth = new AnonymousAuth({
        endpoint: mac.env.fake.identity,
        store: mac.env.relay.auth,
        fetch: mac.env.fake.fetch,
      });
      const rest = new FirestoreRest({
        endpoint: mac.env.fake.endpoint,
        auth,
        fetch: mac.env.fake.fetch,
        retries: 0,
      });
      const leftover = new FirestorePairingLink({
        rest,
        uid: () => auth.uid(),
        vault: mac.env.vault,
        sessionId: "c".repeat(32),
        side: "inviter",
        now: mac.now,
      });
      await leftover.open(mac.now() + 10 * 60_000);
      const sessions = () => [
        ...mac.env.fake.documents(`vaults/${mac.env.vault}/pairings/`).keys(),
      ];
      expect(sessions().some((path) => path.includes("c".repeat(32)))).toBe(true);
      // Not yet past its end: the next invite leaves it.
      await ready(mac);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sessions().some((path) => path.includes("c".repeat(32)))).toBe(true);
      // Past its end and the grace: the next invite deletes it, the new invite's session stays.
      mac.advance(11 * 60_000 + 1);
      const fresh = await ready(mac);
      await until(() => !sessions().some((path) => path.includes("c".repeat(32))));
      const invitation = devices.decodeInvite(fresh.qr);
      if (invitation === undefined) throw new Error("qr undecodable");
      const freshId = pairingSessionId(invitation);
      expect(sessions().some((path) => path.includes(freshId))).toBe(true);
    },
    TIMEOUT,
  );
});

describe("membership and device kinds the owner and the lease rely on", () => {
  it(
    "a Mac with only phones keeps fetching with sync off after a purge (the phone's kind is kept)",
    async () => {
      const mac = await syncedMac();
      const { joiner } = await pairPhone(mac);
      expect(native(mac).canFetchPublicMarket()).toBe(true);
      await forgetLastCompletePull(mac);
      expect((await mac.relayAction("native.relay.purge")).kind).toBe("done");
      const after = setting(mac);
      expect(after?.enabled).toBe(false);
      // The binding went with the purge, the kind did not.
      expect(after?.memberUids[joiner.identity.deviceId]).toBeUndefined();
      expect(after === null ? undefined : relayDeviceRole(after, joiner.identity.deviceId)).toBe(
        "member",
      );
      await native(mac).sync();
      expect(native(mac).canFetchPublicMarket()).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "a Mac whose phone paired twice keeps fetching with sync off (the old device stays a phone)",
    async () => {
      const mac = await syncedMac();
      const identity = new MemoryAuthStore();
      const first = await pairPhone(mac, identity);
      const second = await pairPhone(mac, identity);
      const old = first.joiner.identity.deviceId;
      expect(await trusted(mac, old)).toBe(true);
      expect(setting(mac)?.memberUids[old]).toBeUndefined();
      expect(memberDoc(mac, second.joiner.uid)?.fields.device).toEqual({
        stringValue: second.joiner.identity.deviceId,
      });
      expect(relayDeviceRole(setting(mac) as RelaySetting, old)).toBe("member");
      await forgetLastCompletePull(mac);
      expect((await mac.relayAction("native.relay.disable")).kind).toBe("done");
      await native(mac).sync();
      expect(native(mac).canFetchPublicMarket()).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "a legacy binding without a kind learns it from the member document once the relay answers",
    async () => {
      const mac = await syncedMac();
      const { joiner } = await pairPhone(mac);
      const device = joiner.identity.deviceId;
      const current = setting(mac);
      if (current === null) throw new Error("no setting");
      // As written before kinds were kept: a bare uid, no roles.
      const { roles: _roles, ...legacy } = current;
      const written = await mac.host.stores.device.queue.run(() =>
        mac.host.stores.device.store.run(setRelaySetting, {
          vault: mac.env.vault,
          value: { ...legacy, memberUids: { ...legacy.memberUids, [device]: joiner.uid } },
        }),
      );
      expect(written.ok).toBe(true);
      expect(relayDeviceRole(setting(mac) as RelaySetting, device)).toBeUndefined();
      await relayPass(mac);
      await until(() => relayDeviceRole(setting(mac) as RelaySetting, device) === "member");
      expect(setting(mac)?.memberUids[device]).toEqual({ uid: joiner.uid, role: "member" });
    },
    TIMEOUT,
  );

  it(
    "sync off keeps the last complete pull: the reopened engine still knows it",
    async () => {
      const mac = await syncedMac();
      await relayPass(mac);
      await until(() => setting(mac)?.lastCompletePullAt !== undefined);
      const stored = setting(mac)?.lastCompletePullAt;
      expect((await mac.relayAction("native.relay.disable")).kind).toBe("done");
      expect(setting(mac)?.enabled).toBe(false);
      expect(native(mac).engine.pullHistory().lastCompleteAt).toBe(stored);
      // Switched on again, the history is still there.
      expect((await mac.relayAction("native.relay.enable")).kind).toBe("done");
      expect(setting(mac)?.lastCompletePullAt).toBe(stored);
    },
    TIMEOUT,
  );
});
