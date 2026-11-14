// Device pairing over the sync relay through the real native host composition: the desktop's RPCs on
// one side, a Node joiner (the protocol's `runJoiner` over a joiner-side `FirestorePairingLink`) playing
// the phone on the other, one in-memory Firebase fake between them (`demo-cashu`, never a real project).
// The oracles are the relay's documents (session, messages, members) and the host's persisted state
// (relay setting, device list, pairing journal), never the service's own answers alone.
// Synthetic vault, devices and names only.
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HostConnection } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { mintUlid } from "@cashu/store";
import { relayMemberRole, relayMemberUid, relaySetting } from "@cashu/store/device";
import { runQuery } from "@cashu/store/query";
import { loadDeviceAuthority, SqlProvenanceStore } from "@cashu/store/sync";
import {
  AnonymousAuth,
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  devices,
  FirestorePairingLink,
  FirestoreRest,
  FirestoreTransport,
  PairingLinkError,
  pairingSessionId,
} from "@cashu/sync";
import {
  InMemoryKeyStore,
  MemoryAuthStore,
  MemoryClockStore,
  MemorySink,
  MemoryTransport,
} from "@cashu/sync/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type LocalHost, startLocalHost } from "../host.js";
import { memoryLog } from "../log.js";
import { RELAY_MIN_PULL_GAP_MS, RELAY_PULL_INTERVAL_MS } from "../relay/policy.js";
import type { HostRelayOptions } from "../relay/service.js";
import {
  HANDOVER_EXIT_CODE,
  type RelayHostEnv,
  relayBytes,
  relayHarness,
  until,
} from "../testing/relayFixture.js";
import { PAIRING_WELCOME_WINDOW_MS } from "./service.js";

const harness = relayHarness();
/** Hosts the tests start themselves (restarts included), stopped before their data dirs go. */
const started: LocalHost[] = [];
afterEach(async () => {
  for (const host of started.splice(0)) await host.stop().catch(() => {});
  await harness.cleanup();
});

const MINUTE = 60_000;
const TIMEOUT = 60_000;

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

type Clock = ReturnType<typeof testClock>;

interface Paired {
  readonly env: RelayHostEnv;
  readonly clock: Clock;
  readonly relay: HostRelayOptions;
  readonly host: LocalHost;
  readonly ui: HostConnection;
  /** This Mac's relay uid (the vault's admin). */
  readonly macUid: string;
  /** Routes the host's relay requests through `hook` (undefined: straight to the fake). */
  intercept(hook: RelayFetchHook | undefined): void;
  /** Stops this host (a crash's restart point: nothing in memory survives) and starts a new one. */
  restart(): Promise<Paired>;
}

type RelayFetch = NonNullable<HostRelayOptions["fetch"]>;
type RelayFetchHook = (...args: Parameters<RelayFetch>) => ReturnType<RelayFetch> | undefined;

/** A host on `clock` whose vault has sync switched on (created at the fake), its first push done. */
async function syncedHost(options: { readonly relay?: boolean } = {}): Promise<Paired> {
  const env = await harness.setup();
  const clock = testClock();
  let hook: RelayFetchHook | undefined;
  const intercept = (next: RelayFetchHook | undefined) => {
    hook = next;
  };
  const relay: HostRelayOptions = {
    ...env.relay,
    now: clock.now,
    fetch: (url, init) => hook?.(url, init) ?? env.fake.fetch(url, init),
  };
  const start = async (relayOptions: HostRelayOptions | null) => {
    const host = await startLocalHost({
      dataDir: env.fixture.dataDir,
      home: env.fixture.home,
      build: "test",
      launcher: false,
      log: memoryLog(),
      vaultSource: env.fixture.vaultSource,
      now: clock.now,
      ...(relayOptions === null ? {} : { relay: relayOptions }),
    });
    started.push(host);
    return host;
  };
  const restartable = (host: LocalHost, ui: HostConnection, macUid: string): Paired => ({
    env,
    clock,
    relay,
    host,
    ui,
    macUid,
    intercept,
    async restart() {
      ui.close();
      await host.stop();
      const next = await start(relay);
      env.timers.advance(0);
      return restartable(next, await env.ui(), macUid);
    },
  });
  if (options.relay === false) {
    const host = await start(null);
    const ui = await env.ui();
    return restartable(host, ui, "");
  }
  const first = await start(relay);
  if (options.relay === undefined) {
    const client = await env.ui();
    const enabled = (await client.call("native.relay.enable", { vault: env.vault })) as {
      kind: string;
    };
    if (enabled.kind !== "done") throw new Error("relay enable refused");
    if ((await first.exit) !== HANDOVER_EXIT_CODE) throw new Error("no handover after enable");
    client.close();
    const host = await start(relay);
    env.timers.advance(0);
    await until(() => host.relay.pending() === 0 && relayBytes(env.fake, env.vault) > 0);
    const ui = await env.ui();
    const macUid = env.relay.auth.record?.uid;
    if (macUid === undefined) throw new Error("no relay identity");
    return restartable(host, ui, macUid);
  }
  const ui = await env.ui();
  return restartable(first, ui, "");
}

type InviteReply = { kind: string; code?: string; qr?: string; operationId?: string };

async function invite(paired: Paired): Promise<InviteReply> {
  return (await paired.ui.call("native.pairing.invite", {
    vault: paired.env.vault,
  })) as InviteReply;
}

async function ready(paired: Paired): Promise<{ qr: string; operationId: string }> {
  const reply = await invite(paired);
  if (reply.kind !== "ready" || !reply.qr || !reply.operationId)
    throw new Error(`invite ${reply.kind} ${reply.code ?? ""}`);
  return { qr: reply.qr, operationId: reply.operationId };
}

const confirm = (paired: Paired, operationId: string, code: string) =>
  paired.ui.call("native.pairing.confirm", {
    vault: paired.env.vault,
    operationId,
    code,
  }) as Promise<{ kind: string; code?: string; device?: string }>;

const inspect = (paired: Paired, operationId: string) =>
  paired.ui.call("native.pairing.inspect", { vault: paired.env.vault, operationId }) as Promise<{
    kind: string;
  }>;

/**
 * Inspects until the answer is `kind`, moving the relay's clock past its pull spacing in between (an
 * inspect while the phone has not synced asks for a pull). Returns the last answer.
 */
async function inspectUntil(paired: Paired, operationId: string, kind: string): Promise<string> {
  let last = "";
  for (let round = 0; round < 40; round++) {
    last = (await inspect(paired, operationId)).kind;
    if (last === kind) return last;
    paired.clock.advance(RELAY_MIN_PULL_GAP_MS);
    paired.env.timers.advance(RELAY_MIN_PULL_GAP_MS);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}

const cancel = (paired: Paired, operationId: string) =>
  paired.ui.call("native.pairing.cancel", { vault: paired.env.vault, operationId }) as Promise<{
    kind: string;
  }>;

/** The phone: a fresh device identity and its own anonymous relay identity at the fake. */
async function phone(paired: Paired, qr: string, authStore = new MemoryAuthStore()) {
  const { fake, fixture } = paired.env;
  const sodium = fixture.vaultSource.provider.sodium;
  const auth = new AnonymousAuth({
    endpoint: fake.identity,
    store: authStore,
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
    now: paired.clock.now,
    receiveTimeoutMs: 20_000,
  });
  return {
    uid,
    identity,
    invitation,
    link,
    /**
     * The phone's first sync after it kept the welcome: one pass of its own engine over the relay (it
     * pulls the vault, then pushes its first signed frame, the gossip every pass emits).
     */
    async firstSync(welcome: devices.JoinerWelcome) {
      const now = paired.clock.now;
      const vault = welcome.ring.vaultId;
      const device = identity.deviceId;
      const keyStore = new InMemoryKeyStore();
      await crypto.saveDeviceIdentity(keyStore, identity);
      await crypto.saveKeyring(keyStore, welcome.ring);
      const provenance = SqlProvenanceStore.open(
        openNodeSqlite(join(fixture.home, `phone-${device}.db`)),
        welcome.ring,
        "new",
      );
      devices.recordPairingProvenance(provenance, welcome.ring, welcome.inviter, now());
      // The inviter's chain from the welcome's device.added events, this phone's certificate last.
      const chain = welcome.registryEvents.flatMap((event) =>
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
        bootstrapCertificates: [...chain, welcome.certificate],
      });
      candidate.devices.ingest(welcome.registryEvents);
      const engine = await createSyncEngine({
        vault,
        device,
        local: new MemoryTransport(),
        remotes: [new FirestoreTransport({ rest, uid: () => auth.uid(), now })],
        codec: createOwnLogCodec({ sodium, ring: candidate.ring, signer: candidate.identity }),
        gate: candidate.gate,
        sink: new MemorySink(),
        clockStore: new MemoryClockStore(),
        physicalClock: { now },
        gossipEid: () => mintUlid(now()),
      });
      const pass = await engine.sync();
      if (pass.offlineRemotes > 0) throw new Error("phone pass offline");
    },
    /** Claims the session and runs the protocol; `onSas` sees the six digits. */
    async run(onSas: (sas: string) => void) {
      const started = devices.PairingJoiner.start(
        { sodium, identity, name: "Synthetic phone" },
        qr,
        paired.clock.now(),
      );
      if (!started.ok) throw new Error(started.reason);
      await link.claim();
      return devices.runJoiner(started.value.joiner, started.value.hello, link, {
        now: paired.clock.now,
        showSas: onSas,
      });
    },
  };
}

/** Relay documents of the vault's pairing sessions (sessions and messages). */
const pairingDocs = (paired: Paired) => [
  ...paired.env.fake.documents(`vaults/${paired.env.vault}/pairings/`).keys(),
];

const memberDoc = (paired: Paired, uid: string) =>
  paired.env.fake
    .documents(`vaults/${paired.env.vault}/members/`)
    .get(`vaults/${paired.env.vault}/members/${uid}`);

const memberDocs = (paired: Paired) => [
  ...paired.env.fake.documents(`vaults/${paired.env.vault}/members/`).keys(),
];

function settingMembers(paired: Paired) {
  const setting = runQuery(paired.host.stores.device.store, relaySetting, {
    vault: paired.env.vault,
  }).value;
  return setting?.memberUids ?? {};
}

async function deviceList(paired: Paired) {
  const session = paired.host.stores.vaults.get(paired.env.vault)?.native;
  if (session === undefined) throw new Error("vault not open");
  const list = await session.deviceList();
  if (list.kind !== "ready") throw new Error("device list unavailable");
  return list.devices;
}

/** Nothing of a failed or cancelled pairing is left: no session at the relay, no new member. */
async function expectClean(paired: Paired, phoneUid: string): Promise<void> {
  await until(() => pairingDocs(paired).length === 0);
  expect(memberDoc(paired, phoneUid)).toBeUndefined();
  expect(memberDocs(paired)).toEqual([`vaults/${paired.env.vault}/members/${paired.macUid}`]);
  expect(Object.keys(settingMembers(paired))).toEqual([
    paired.env.fixture.vaultSource.provider.inventory[0]?.deviceId,
  ]);
}

/** A full pairing; returns the phone and the confirmed reply. */
async function pairPhone(paired: Paired, authStore?: MemoryAuthStore) {
  const { qr, operationId } = await ready(paired);
  const joiner = await phone(paired, qr, authStore);
  let confirmed: Promise<{ kind: string; device?: string }> | undefined;
  const result = await joiner.run((sas) => {
    confirmed = confirm(paired, operationId, sas);
  });
  if (confirmed === undefined) throw new Error("no code shown");
  return { joiner, result, confirmed: await confirmed, operationId };
}

describe("pairing over the relay", () => {
  it(
    "admits the phone: welcome, member document with role member, device.added pushed",
    async () => {
      const paired = await syncedHost();
      const before = relayBytes(paired.env.fake, paired.env.vault);
      const { qr, operationId } = await ready(paired);
      // The QR names this build's project: the phone refuses another one.
      expect(devices.decodeInvite(qr)?.rendezvous).toBe(
        `fb1:${paired.env.fake.endpoint.projectId}`,
      );
      // The session exists before anyone scanned; it is bound to this Mac and nobody claimed it yet.
      expect(pairingDocs(paired)).toHaveLength(1);

      const joiner = await phone(paired, qr);
      let confirmed: Promise<{ kind: string; device?: string }> | undefined;
      let memberBeforeCode: unknown = "unread";
      const result = await joiner.run((sas) => {
        memberBeforeCode = memberDoc(paired, joiner.uid);
        confirmed = confirm(paired, operationId, sas);
      });
      expect(result.ok).toBe(true);
      // Before the six digits nothing admits the phone.
      expect(memberBeforeCode).toBeUndefined();
      expect(await confirmed).toEqual({
        kind: "waiting_for_phone",
        operationId,
        device: joiner.identity.deviceId,
      });

      // The commit point: the phone's uid is a member of the vault at the relay, bound to its device.
      const member = memberDoc(paired, joiner.uid);
      expect(member?.fields.device).toEqual({ stringValue: joiner.identity.deviceId });
      expect(member?.fields.role).toEqual({ stringValue: "member" });
      const bound = settingMembers(paired)[joiner.identity.deviceId];
      expect(bound === undefined ? undefined : relayMemberUid(bound)).toBe(joiner.uid);
      expect(bound === undefined ? undefined : relayMemberRole(bound)).toBe("member");
      // The vault lists it, and its device.added reached the relay.
      expect(
        (await deviceList(paired)).find((device) => device.id === joiner.identity.deviceId)
          ?.trusted,
      ).toBe(true);
      expect(relayBytes(paired.env.fake, paired.env.vault)).toBeGreaterThan(before);
      // "Paired" only once the phone's first signed frame reached this Mac through the relay.
      expect((await inspect(paired, operationId)).kind).toBe("waiting_for_phone");
      if (!result.ok) throw new Error("joiner failed");
      await joiner.firstSync(result.value);
      expect(await inspectUntil(paired, operationId, "completed")).toBe("completed");

      // The session stays while the phone may still read the pages, then goes; a new invite works.
      expect(pairingDocs(paired).length).toBeGreaterThan(0);
      paired.clock.advance(11 * MINUTE);
      expect((await invite(paired)).kind).toBe("ready");
      await until(
        () =>
          !pairingDocs(paired).some((path) =>
            path.includes(joiner.link === undefined ? "" : pairingSessionId(joiner.invitation)),
          ),
      );
    },
    TIMEOUT,
  );

  it(
    "ends after three wrong codes with nothing admitted, then a new invite pairs",
    async () => {
      const paired = await syncedHost();
      const { qr, operationId } = await ready(paired);
      const joiner = await phone(paired, qr);
      const replies: { kind: string; code?: string }[] = [];
      const run = joiner
        .run((sas) => {
          const wrong = sas === "000000" ? "111111" : "000000";
          void (async () => {
            for (let i = 0; i < 3; i++) replies.push(await confirm(paired, operationId, wrong));
          })();
        })
        .catch((error: unknown) => error);
      const ended = await run;
      await until(() => replies.length === 3);
      expect(replies.map((reply) => reply.kind)).toEqual(["refused", "refused", "refused"]);
      expect(replies.map((reply) => reply.code)).toEqual(["invalid", "invalid", "invalid"]);
      expect(ended instanceof Error || (ended as { ok?: boolean }).ok === false).toBe(true);
      await expectClean(paired, joiner.uid);
      expect((await inspect(paired, operationId)).kind).toBe("not_started");

      const again = await pairPhone(paired);
      expect(again.confirmed.kind).toBe("waiting_for_phone");
      expect(memberDoc(paired, again.joiner.uid)?.fields.role).toEqual({ stringValue: "member" });
    },
    TIMEOUT,
  );

  it(
    "expires an unscanned code after its 5 minutes: the session is gone and a new invite works",
    async () => {
      const paired = await syncedHost();
      const { qr, operationId } = await ready(paired);
      paired.clock.advance(5 * MINUTE + 1_000);
      // The next action prunes the expired invite; the new one is not refused as busy.
      expect((await invite(paired)).kind).toBe("ready");
      expect((await inspect(paired, operationId)).kind).toBe("not_started");
      const late = await phone(paired, qr);
      await expect(late.run(() => {})).rejects.toBeInstanceOf(PairingLinkError);
      await until(
        () => !pairingDocs(paired).some((path) => path.includes(pairingSessionId(late.invitation))),
      );
      expect(memberDoc(paired, late.uid)).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "expires a code nobody typed: the phone's wait ends and nothing is admitted",
    async () => {
      const paired = await syncedHost();
      const { qr } = await ready(paired);
      const joiner = await phone(paired, qr);
      let shown = false;
      const run = joiner
        .run(() => {
          shown = true;
        })
        .catch((error: unknown) => error);
      await until(() => shown);
      // The 2-minute code window and its grace pass; the next action prunes the invite.
      paired.clock.advance(devices.SAS_TTL_MS + 2 * MINUTE);
      expect((await invite(paired)).kind).toBe("ready");
      const ended = await run;
      expect(ended instanceof Error || (ended as { ok?: boolean }).ok === false).toBe(true);
      await until(
        () =>
          !pairingDocs(paired).some((path) => path.includes(pairingSessionId(joiner.invitation))),
      );
      expect(memberDoc(paired, joiner.uid)).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "ends clean when the session ends while the welcome is written (before the commit point)",
    async () => {
      const paired = await syncedHost();
      const { qr, operationId } = await ready(paired);
      const joiner = await phone(paired, qr);
      const sid = pairingSessionId(joiner.invitation);
      // The relay refuses the Mac's welcome (message 2) as its rules do once the session expired, and
      // the clock is past the session's end by then.
      let refused = false;
      paired.intercept((url, init) => {
        if (
          refused ||
          !url.endsWith(":commit") ||
          !(init.body ?? "").includes(`pairings/${sid}/messages/0002`)
        )
          return undefined;
        refused = true;
        paired.clock.advance(11 * MINUTE);
        const text = JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED" } });
        return Promise.resolve({
          status: 403,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
      let confirmed: Promise<{ kind: string; code?: string }> | undefined;
      const ended = await joiner
        .run((sas) => {
          confirmed = confirm(paired, operationId, sas);
        })
        .catch((error: unknown) => error);
      expect(refused).toBe(true);
      expect(ended instanceof Error || (ended as { ok?: boolean }).ok === false).toBe(true);
      expect(await confirmed).toEqual({ kind: "refused", code: "expired" });
      await expectClean(paired, joiner.uid);
      // Nothing appended: the phone is not in the vault and the journal holds no attempt.
      expect(
        (await deviceList(paired)).some((device) => device.id === joiner.identity.deviceId),
      ).toBe(false);
      expect((await inspect(paired, operationId)).kind).toBe("not_started");
      expect(PAIRING_WELCOME_WINDOW_MS).toBe(3 * MINUTE);
    },
    TIMEOUT,
  );

  it(
    "cancels before the scan and after the hello, each time leaving both sides clean",
    async () => {
      const paired = await syncedHost();
      // Before anyone scanned.
      const first = await ready(paired);
      expect((await cancel(paired, first.operationId)).kind).toBe("cancelled");
      const unscanned = await phone(paired, first.qr);
      await expect(unscanned.run(() => {})).rejects.toBeInstanceOf(PairingLinkError);
      await expectClean(paired, unscanned.uid);

      // After the hello, while the phone shows its code.
      const second = await ready(paired);
      const joiner = await phone(paired, second.qr);
      let cancelled: Promise<{ kind: string }> | undefined;
      const ended = await joiner
        .run(() => {
          cancelled = cancel(paired, second.operationId);
        })
        .catch((error: unknown) => error);
      expect((await cancelled)?.kind).toBe("cancelled");
      expect(ended instanceof Error || (ended as { ok?: boolean }).ok === false).toBe(true);
      await expectClean(paired, joiner.uid);
      expect((await inspect(paired, second.operationId)).kind).toBe("not_started");

      // Once the code was typed the commit may run: cancel is refused, the pairing completes.
      const third = await ready(paired);
      const last = await phone(paired, third.qr);
      let late: Promise<{ kind: string }> | undefined;
      let confirmed: Promise<{ kind: string }> | undefined;
      const result = await last.run((sas) => {
        confirmed = confirm(paired, third.operationId, sas);
        late = cancel(paired, third.operationId);
      });
      expect((await late)?.kind).toBe("refused");
      expect(result.ok).toBe(true);
      expect((await confirmed)?.kind).toBe("waiting_for_phone");
    },
    TIMEOUT,
  );

  it(
    "binds a phone that pairs again (same relay identity, new device) to its new device only",
    async () => {
      const paired = await syncedHost();
      const identity = new MemoryAuthStore();
      const first = await pairPhone(paired, identity);
      expect(first.confirmed.kind).toBe("waiting_for_phone");
      const second = await pairPhone(paired, identity);
      expect(second.confirmed.kind).toBe("waiting_for_phone");
      expect(second.joiner.uid).toBe(first.joiner.uid);
      expect(memberDoc(paired, second.joiner.uid)?.fields.device).toEqual({
        stringValue: second.joiner.identity.deviceId,
      });
      const members = settingMembers(paired);
      expect(members[first.joiner.identity.deviceId]).toBeUndefined();
      expect(relayMemberUid(members[second.joiner.identity.deviceId] ?? "")).toBe(
        second.joiner.uid,
      );
    },
    TIMEOUT,
  );

  it(
    "removes the revoked phone's membership once the revocation reached the relay",
    async () => {
      const paired = await syncedHost();
      const { joiner, confirmed } = await pairPhone(paired);
      expect(confirmed.kind).toBe("waiting_for_phone");
      expect(memberDoc(paired, joiner.uid)).toBeDefined();

      const preview = (await paired.ui.call("native.devices.revokePreview", {
        vault: paired.env.vault,
        targets: [joiner.identity.deviceId],
        recertify: [],
      })) as { kind: string; token?: string; operationId?: string };
      if (preview.kind !== "prepared" || !preview.token || !preview.operationId)
        throw new Error("preview unavailable");
      const committed = (await paired.ui.call("native.devices.revokeCommit", {
        vault: paired.env.vault,
        token: preview.token,
        warningAcknowledgement: "revoke_risk_acknowledged",
        localStartAcknowledgement: "local_target_stream_never_seen",
        recoveryPhrase: paired.env.fixture.recoveryWords,
      })) as { kind: string };
      expect(committed.kind).toBe("completed");
      // Not before the revocation was pushed: the phone may still pull and learn it was removed.
      // Device changes without a relay pass (an inspect signals one) leave the membership alone.
      const pushedBefore = relayBytes(paired.env.fake, paired.env.vault);
      for (let i = 0; i < 3; i++) {
        await paired.ui.call("native.devices.revokeInspect", {
          vault: paired.env.vault,
          operationId: preview.operationId,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(relayBytes(paired.env.fake, paired.env.vault)).toBe(pushedBefore);
      expect(memberDoc(paired, joiner.uid)).toBeDefined();
      paired.clock.advance(2 * MINUTE);
      paired.env.timers.advance(2 * MINUTE);
      await until(() => relayBytes(paired.env.fake, paired.env.vault) > pushedBefore);
      await until(() => memberDoc(paired, joiner.uid) === undefined);
      expect(settingMembers(paired)[joiner.identity.deviceId]).toBeUndefined();
      expect(memberDocs(paired)).toEqual([`vaults/${paired.env.vault}/members/${paired.macUid}`]);
    },
    TIMEOUT,
  );

  it(
    "refuses an invite while sync is off (relay_off) or without a sync config (no_config)",
    async () => {
      const off = await syncedHost({ relay: true });
      expect(await invite(off)).toEqual({ kind: "refused", code: "relay_off" });
      // The relay itself refuses a pairing link for a vault whose sync is off.
      expect(() => off.host.relay.pairingLink(off.env.vault, "0".repeat(32))).toThrow("relay_off");
      expect(pairingDocs(off)).toEqual([]);

      const none = await syncedHost({ relay: false });
      expect(await invite(none)).toEqual({ kind: "refused", code: "no_config" });
      expect(() => none.host.relay.pairingLink(none.env.vault, "0".repeat(32))).toThrow(
        "relay_no_config",
      );
    },
    TIMEOUT,
  );
});

/** A relay answer that says nothing about whether the write landed (HTTP 503). */
function unavailable() {
  const text = JSON.stringify({ error: { code: 503, status: "UNAVAILABLE" } });
  return { status: 503, text: async () => text, json: async () => JSON.parse(text) };
}

/** The commit that writes (not deletes) `uid`'s member document. */
const writesMember = (url: string, init: { readonly body?: string }, uid: string) =>
  url.endsWith(":commit") &&
  (init.body ?? "").includes(`/members/${uid}`) &&
  !(init.body ?? "").includes('"delete"');

/** The commit that deletes `uid`'s member document. */
const deletesMember = (url: string, init: { readonly body?: string }, uid: string) =>
  url.endsWith(":commit") &&
  (init.body ?? "").includes(`/members/${uid}`) &&
  (init.body ?? "").includes('"delete"');

/**
 * Lets relay pull passes run (the 5-minute timer, moved forward) until `check` holds; each pass ends
 * with the device-change signal the membership reconciliation runs on.
 */
async function passesUntil(paired: Paired, check: () => Promise<boolean>): Promise<void> {
  for (let round = 0; round < 40; round++) {
    if (await check()) return;
    paired.clock.advance(RELAY_PULL_INTERVAL_MS);
    paired.env.timers.advance(RELAY_PULL_INTERVAL_MS);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not reached after 40 relay passes");
}

const trusted = async (paired: Paired, device: string) =>
  (await deviceList(paired)).some((entry) => entry.id === device && entry.trusted);

/** Runs a pairing up to the owner's confirm; `hook` sees the host's relay requests meanwhile. */
async function pairThrough(paired: Paired, hook: (joinerUid: string) => RelayFetchHook) {
  const { qr, operationId } = await ready(paired);
  const joiner = await phone(paired, qr);
  paired.intercept(hook(joiner.uid));
  let confirmed: Promise<{ kind: string; code?: string; device?: string }> | undefined;
  const result = await joiner
    .run((sas) => {
      confirmed = confirm(paired, operationId, sas);
    })
    .catch((error: unknown) => error);
  if (confirmed === undefined) throw new Error("no code shown");
  const reply = await confirmed;
  paired.intercept(undefined);
  return { joiner, result, reply, operationId };
}

/** The vault's log folders (the engine's local own log) made unwritable, or writable again. */
function logWritable(paired: Paired, writable: boolean): void {
  const root = paired.env.fixture.vaultSource.provider.inventory[0]?.vaultRoot;
  if (root === undefined) throw new Error("no vault root");
  const mode = writable ? 0o700 : 0o500;
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) visit(join(dir, entry.name));
    chmodSync(dir, mode);
  };
  visit(join(root, "log"));
}

// The pairing's ONE commit point is the joiner's member document. Every check that can refuse runs
// before it; after it nothing refuses: the device.added append converges (retried, reopen included),
// an unknown membership outcome is resolved from the relay's member list, and a member document that
// nothing in the vault explains is removed. Each case ends with the phone admitted in both places
// (member document + trusted device) or in neither.
describe("the pairing commit point", () => {
  it(
    "resolves a membership write whose answer was lost from the member list: admitted, never refused",
    async () => {
      const paired = await syncedHost();
      let lost = false;
      const { joiner, reply, operationId } = await pairThrough(paired, (uid) => (url, init) => {
        if (lost || !writesMember(url, init, uid)) return undefined;
        lost = true;
        return paired.env.fake.fetch(url, init).then(unavailable);
      });
      expect(lost).toBe(true);
      expect(reply).toEqual({ kind: "outcome_unknown", operationId });
      // The write landed: the commit point passed, the append is owed. The unknown outcome reopens
      // the vaults (a handover: the app starts the host again).
      expect(memberDoc(paired, joiner.uid)?.fields.device).toEqual({
        stringValue: joiner.identity.deviceId,
      });
      expect(await paired.host.exit).toBe(HANDOVER_EXIT_CODE);
      const after = await paired.restart();
      await passesUntil(after, () => trusted(after, joiner.identity.deviceId));
      expect(memberDoc(after, joiner.uid)).toBeDefined();
      expect((await inspect(after, operationId)).kind).toBe("waiting_for_phone");
      // The setting the lost answer never wrote is adopted from the member list.
      await passesUntil(after, async () => {
        const bound = settingMembers(after)[joiner.identity.deviceId];
        return bound !== undefined && relayMemberUid(bound) === joiner.uid;
      });
      expect(relayMemberRole(settingMembers(after)[joiner.identity.deviceId])).toBe("member");
    },
    TIMEOUT,
  );

  it(
    "keeps an unknown membership owed while the relay stays out after the restart, then admits",
    async () => {
      const paired = await syncedHost();
      let lost = false;
      const { joiner, reply, operationId } = await pairThrough(paired, (uid) => (url, init) => {
        if (lost || !writesMember(url, init, uid)) return undefined;
        lost = true;
        return paired.env.fake.fetch(url, init).then(unavailable);
      });
      expect(reply.kind).toBe("outcome_unknown");
      expect(memberDoc(paired, joiner.uid)).toBeDefined();
      // The relay cannot be reached when the host comes back: nothing can be read, nothing resolves.
      paired.intercept(() => Promise.resolve(unavailable()));
      const after = await paired.restart();
      for (let i = 0; i < 3; i++) {
        after.clock.advance(RELAY_PULL_INTERVAL_MS);
        after.env.timers.advance(RELAY_PULL_INTERVAL_MS);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect((await inspect(after, operationId)).kind).toBe("outcome_unknown");
      expect(await trusted(after, joiner.identity.deviceId)).toBe(false);
      after.intercept(undefined);
      await passesUntil(after, () => trusted(after, joiner.identity.deviceId));
      expect((await inspect(after, operationId)).kind).toBe("waiting_for_phone");
    },
    TIMEOUT,
  );

  it(
    "ends with nothing admitted when the unknown membership write never landed",
    async () => {
      const paired = await syncedHost();
      let dropped = false;
      const { joiner, reply, operationId } = await pairThrough(paired, (uid) => (url, init) => {
        if (dropped || !writesMember(url, init, uid)) return undefined;
        dropped = true;
        // Lost on the way: the relay never saw it, the Mac cannot tell.
        return Promise.resolve(unavailable());
      });
      expect(reply.kind).toBe("outcome_unknown");
      expect(memberDoc(paired, joiner.uid)).toBeUndefined();
      expect(await paired.host.exit).toBe(HANDOVER_EXIT_CODE);
      const after = await paired.restart();
      // A member list read after the write ended shows no document: the attempt never started.
      await passesUntil(
        after,
        async () => (await inspect(after, operationId)).kind === "not_started",
      );
      expect(await trusted(after, joiner.identity.deviceId)).toBe(false);
      expect(memberDoc(after, joiner.uid)).toBeUndefined();
      expect((await pairPhone(after)).confirmed.kind).toBe("waiting_for_phone");
    },
    TIMEOUT,
  );

  it(
    "re-appends after the append failed past the member write (reopen), never downgrading to not_started",
    async () => {
      const paired = await syncedHost();
      let failed = false;
      const { joiner, reply, operationId } = await pairThrough(paired, (uid) => (url, init) => {
        if (failed || !writesMember(url, init, uid)) return undefined;
        failed = true;
        // The membership lands; the vault's own log then refuses the device.added append.
        return paired.env.fake.fetch(url, init).then((response) => {
          logWritable(paired, false);
          return response;
        });
      });
      logWritable(paired, true);
      expect(failed).toBe(true);
      expect(reply).toEqual({ kind: "outcome_unknown", operationId });
      expect(memberDoc(paired, joiner.uid)).toBeDefined();

      const after = await paired.restart();
      expect((await inspect(after, operationId)).kind).not.toBe("not_started");
      await passesUntil(after, () => trusted(after, joiner.identity.deviceId));
      expect((await inspect(after, operationId)).kind).toBe("waiting_for_phone");
      expect(memberDoc(after, joiner.uid)?.fields.device).toEqual({
        stringValue: joiner.identity.deviceId,
      });
    },
    TIMEOUT,
  );

  it(
    "refuses before the commit point when the relay cannot be reached: no member, no live row",
    async () => {
      const paired = await syncedHost();
      let refused = false;
      const { joiner, reply, operationId } = await pairThrough(paired, () => (url, init) => {
        // The admission's preflight (the member list) after the welcome went out.
        if (!url.endsWith(":runQuery") || !(init.body ?? "").includes('"members"'))
          return undefined;
        refused = true;
        return Promise.resolve(unavailable());
      });
      expect(refused).toBe(true);
      expect(reply).toEqual({ kind: "refused", code: "unavailable" });
      await expectClean(paired, joiner.uid);
      expect(await trusted(paired, joiner.identity.deviceId)).toBe(false);
      expect((await inspect(paired, operationId)).kind).toBe("not_started");
      // Nothing blocks the vault: the next pairing goes through.
      expect((await pairPhone(paired)).confirmed.kind).toBe("waiting_for_phone");
    },
    TIMEOUT,
  );

  it(
    "removes a member document nothing explains after a later pass; paired devices stay",
    async () => {
      const paired = await syncedHost();
      const { joiner } = await pairPhone(paired);
      const stray = { device: "5".repeat(32), uid: "stray-uid-0001", role: "member" as const };
      await paired.host.relay.addMember(paired.env.vault, stray);
      expect(memberDoc(paired, stray.uid)).toBeDefined();
      // A second Mac that wrote it may be offline for days: still kept after 6 days of passes
      // (literal days, not the constant).
      const day = 24 * 60 * 60_000;
      await passesUntil(paired, async () => false).catch(() => {});
      paired.clock.advance(6 * day);
      paired.env.timers.advance(6 * day);
      await passesUntil(paired, async () => false).catch(() => {});
      expect(memberDoc(paired, stray.uid)).toBeDefined();
      paired.clock.advance(day);
      paired.env.timers.advance(day);
      await passesUntil(paired, async () => memberDoc(paired, stray.uid) === undefined);
      expect(settingMembers(paired)[stray.device]).toBeUndefined();
      // The paired phone (a registered device) and this Mac keep theirs.
      expect(memberDoc(paired, joiner.uid)).toBeDefined();
      expect(memberDoc(paired, paired.macUid)).toBeDefined();
      expect(await trusted(paired, joiner.identity.deviceId)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "shows a revoked phone's failing membership removal in the relay status until it succeeds",
    async () => {
      const paired = await syncedHost();
      const { joiner } = await pairPhone(paired);
      const preview = (await paired.ui.call("native.devices.revokePreview", {
        vault: paired.env.vault,
        targets: [joiner.identity.deviceId],
        recertify: [],
      })) as { kind: string; token?: string };
      if (preview.kind !== "prepared" || !preview.token) throw new Error("preview unavailable");
      const committed = (await paired.ui.call("native.devices.revokeCommit", {
        vault: paired.env.vault,
        token: preview.token,
        warningAcknowledgement: "revoke_risk_acknowledged",
        localStartAcknowledgement: "local_target_stream_never_seen",
        recoveryPhrase: paired.env.fixture.recoveryWords,
      })) as { kind: string };
      expect(committed.kind).toBe("completed");
      let attempts = 0;
      paired.intercept((url, init) => {
        if (!deletesMember(url, init, joiner.uid)) return undefined;
        attempts += 1;
        return Promise.resolve(unavailable());
      });
      const status = () =>
        paired.ui.call("native.relay.status", { vault: paired.env.vault }) as Promise<{
          removalsFailing?: { devices: number; since: number; ids: string[] };
        }>;
      await passesUntil(paired, async () => (await status()).removalsFailing !== undefined);
      expect(attempts).toBeGreaterThan(0);
      expect((await status()).removalsFailing).toEqual({
        devices: 1,
        since: expect.any(Number),
        ids: [joiner.identity.deviceId],
      });
      expect(memberDoc(paired, joiner.uid)).toBeDefined();

      paired.intercept(undefined);
      await passesUntil(paired, async () => memberDoc(paired, joiner.uid) === undefined);
      await passesUntil(paired, async () => (await status()).removalsFailing === undefined);
    },
    TIMEOUT,
  );
});
