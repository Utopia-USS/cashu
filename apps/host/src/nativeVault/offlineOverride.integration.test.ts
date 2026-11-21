// G2 owner override ("Keep fetching on this Mac"): while the 7-day offline bound refuses this Mac as
// the pinned fetch leader, `native.relay.keepFetching` records the acknowledgement in the vault's
// device-local relay setting and the bound counts 7 days from it; it is refused whenever the bound is
// not what stops this Mac, and it never stands in for the offline evidence itself (a removed Mac stays
// refused). Synthetic vaults over the in-memory Firebase fake only.
import { connectHost } from "@cashu/node-host";
import { type RelaySetting, relaySetting, setRelaySetting } from "@cashu/store/device";
import { runQuery } from "@cashu/store/query";
import { AnonymousAuth, FirestoreRest } from "@cashu/sync";
import { createFakeFirebase, MemoryAuthStore } from "@cashu/sync/testing";
import { afterEach, expect, it } from "vitest";
import { type LocalHost, startLocalHost } from "../host.js";
import { memoryLog } from "../log.js";
import { RELAY_PUSH_DEBOUNCE_MS } from "../relay/policy.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import {
  enabledRelayHost,
  fakeRelayOptions,
  HANDOVER_EXIT_CODE,
  ManualRelayTimers,
  membersOnlyFetch,
  presetRelaySetting,
  relayBytes,
  relayHarness,
  renameVault as rename,
  until,
  vaultQueueDrained,
} from "../testing/relayFixture.js";

// Literal days, not the constant: the oracle does not come from the code under test.
const DAY = 24 * 60 * 60_000;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A Mac pinned as the fetch leader with a synthetic second device of unknown kind (so it could lead),
 * sync switched off, the last complete pull 8 days before the start: the bound refuses it.
 */
async function pausedMac(options: { readonly peer?: boolean } = {}) {
  const fixture = await nativeVaultFixture({ modules: ["budget"], pairPeer: options.peer ?? true });
  cleanups.push(() => fixture.cleanup());
  let time = Date.now();
  const clock = {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
  const fake = createFakeFirebase();
  const relay = fakeRelayOptions(fake, new ManualRelayTimers(time));
  const setting: RelaySetting = {
    enabled: false,
    project: relay.endpoints.projectId,
    enabledAt: time - 30 * DAY,
    memberUids: {},
    lastCompletePullAt: time - 8 * DAY,
  };
  presetRelaySetting(fixture.dataDir, fixture.vaultId, setting);
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    log: memoryLog(),
    now: clock.now,
    vaultSource: fixture.vaultSource,
    relay,
  });
  cleanups.push(() => host.stop().then(() => {}));
  const ui = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "test" });
  cleanups.push(() => ui.close());
  const vault = fixture.vaultId;
  const session = host.stores.vaults.get(vault)?.native;
  if (session === undefined) throw new Error("synthetic native vault unavailable");
  return {
    host,
    clock,
    vault,
    session,
    keepFetching: () => ui.call("native.relay.keepFetching", { vault }),
    stored: () => runQuery(host.stores.device.store, relaySetting, { vault }).value,
    async paused() {
      await session.sync();
      const list = await session.deviceList();
      if (list.kind !== "ready") throw new Error(`device list refused: ${list.code}`);
      expect(list.leader.device).toBe(session.device);
      // The override names the other device that could lead: the synthetic peer, only while paused.
      expect(list.leader.pausedPeer).toBe(
        list.leader.paused === undefined ? undefined : fixture.peerIdentity?.deviceId,
      );
      return list.leader.paused === "offline_too_long";
    },
  };
}

it("bound hit -> refused; acknowledged -> allowed for 7 days -> refused and asked again", async () => {
  const mac = await pausedMac();
  expect(await mac.paused()).toBe(true);
  expect(mac.session.canFetchPublicMarket()).toBe(false);

  const ackAt = mac.clock.now();
  expect(await mac.keepFetching()).toEqual({ kind: "done" });
  expect(mac.stored()?.offlineLeadAckAt).toBe(ackAt);
  expect(await mac.paused()).toBe(false);
  expect(mac.session.canFetchPublicMarket()).toBe(true);
  // Not paused any more: the host refuses a second acknowledgement (nothing to override).
  expect(await mac.keepFetching()).toEqual({ kind: "refused", reason: "busy" });
  expect(mac.stored()?.offlineLeadAckAt).toBe(ackAt);

  mac.clock.advance(7 * DAY - 60_000);
  expect(await mac.paused()).toBe(false);
  expect(mac.session.canFetchPublicMarket()).toBe(true);
  mac.clock.advance(60_000 + 1);
  expect(await mac.paused()).toBe(true);
  expect(mac.session.canFetchPublicMarket()).toBe(false);
  // Asked again: a new acknowledgement starts a new 7 days.
  expect(await mac.keepFetching()).toEqual({ kind: "done" });
  expect(await mac.paused()).toBe(false);
});

it("refuses the override when the bound is not what stops this Mac (nobody else can lead)", async () => {
  const mac = await pausedMac({ peer: false });
  expect(await mac.paused()).toBe(false);
  expect(await mac.keepFetching()).toEqual({ kind: "refused", reason: "busy" });
  expect(mac.stored()?.offlineLeadAckAt).toBeUndefined();
});

it("a complete pull clears the acknowledgement", async () => {
  const harness = relayHarness();
  cleanups.push(() => harness.cleanup());
  const env = await harness.setup();
  const host = await enabledRelayHost(env);
  const stored = () => runQuery(host.stores.device.store, relaySetting, { vault: env.vault }).value;
  await host.syncVault(env.vault);
  await until(() => stored()?.lastCompletePullAt !== undefined);
  const current = stored();
  if (current === null) throw new Error("no relay setting");
  // An acknowledgement from before the next pass (the pass runs on the host's real clock).
  const written = await host.stores.device.queue.run(() =>
    host.stores.device.store.run(setRelaySetting, {
      vault: env.vault,
      value: { ...current, offlineLeadAckAt: Date.now() - 1 },
    }),
  );
  expect(written.ok).toBe(true);
  await host.syncVault(env.vault);
  await until(() => stored()?.offlineLeadAckAt === undefined);
  expect(stored()?.lastCompletePullAt).toBeDefined();
});

it("a removed Mac stays refused whatever the acknowledgement says", async () => {
  const harness = relayHarness();
  cleanups.push(() => harness.cleanup());
  const env = await harness.setup();
  let time = Date.now();
  const relay = { ...env.relay, fetch: membersOnlyFetch(env.fake) };
  const start = async () => {
    const started = await startLocalHost({
      dataDir: env.fixture.dataDir,
      home: env.fixture.home,
      build: "test",
      launcher: false,
      log: memoryLog(),
      now: () => time,
      vaultSource: env.fixture.vaultSource,
      relay,
    });
    cleanups.push(() => started.stop().then(() => {}));
    return started;
  };
  const first = await start();
  const ui = await env.ui();
  expect(await ui.call("native.relay.enable", { vault: env.vault })).toEqual({ kind: "done" });
  expect(await first.exit).toBe(HANDOVER_EXIT_CODE);
  const host: LocalHost = await start();
  env.timers.advance(0);
  await until(() => host.relay.pending() === 0 && relayBytes(env.fake, env.vault) > 0);
  const session = host.stores.vaults.get(env.vault)?.native;
  if (session === undefined) throw new Error("synthetic native vault unavailable");
  await host.syncVault(env.vault);
  // The oracle that this Mac leads: it may fetch right after a complete pull.
  expect(session.canFetchPublicMarket()).toBe(true);
  const uid = env.relay.auth.record?.uid as string;
  // The member document of this Mac is gone (removed by the owner elsewhere). The fake runs no
  // rules: a second identity stands in for the other admin.
  const rest = new FirestoreRest({
    endpoint: env.fake.endpoint,
    auth: new AnonymousAuth({
      endpoint: env.fake.identity,
      store: new MemoryAuthStore(),
      fetch: env.fake.fetch,
    }),
    fetch: env.fake.fetch,
  });
  await rest.commit([{ delete: `vaults/${env.vault}/members/${uid}` }]);
  await rename(host, env.vault, "After removal");
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  await until(() => host.relay.pending() === 0);
  await vaultQueueDrained(host, env.vault);
  expect(host.relay.transportStatus(env.vault).lastError).toBe("forbidden");
  // Past the lease's publish deadline (a minute): only offline evidence could still vouch.
  time += 2 * 60_000;
  const current = runQuery(host.stores.device.store, relaySetting, { vault: env.vault }).value;
  if (current === null) throw new Error("no relay setting");
  await host.stores.device.queue.run(() =>
    host.stores.device.store.run(setRelaySetting, {
      vault: env.vault,
      value: { ...current, offlineLeadAckAt: time },
    }),
  );
  await host.syncVault(env.vault);
  expect(session.canFetchPublicMarket()).toBe(false);
  const list = await session.deviceList();
  if (list.kind !== "ready") throw new Error(`device list refused: ${list.code}`);
  // Not the offline bound: no override offered, and the RPC refuses it.
  expect(list.leader.paused).toBeUndefined();
  const again = await env.ui();
  expect(await again.call("native.relay.keepFetching", { vault: env.vault })).toEqual({
    kind: "refused",
    reason: "busy",
  });
});
