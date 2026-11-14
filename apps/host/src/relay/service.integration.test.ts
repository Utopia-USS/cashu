// The sync relay on a native host over the in-memory Firebase fake: the owner switch (enable creates
// the vault and this Mac's admin membership, then the reopened vault pushes its history), the push 2 s
// after own writes, back-off while unreachable or over quota, the 60 s gap between pulls, the final
// push before the idle exit, the identity-lost status and its clearing, a vault that is off making no
// request at all, disable and purge, and the refusals. Synthetic vaults only; the fake is `demo-cashu`.
import { relaySetting, setRelaySetting } from "@cashu/store/device";
import { runQuery } from "@cashu/store/query";
import { AnonymousAuth, FirestoreRest } from "@cashu/sync";
import { type FakeFirebase, MemoryAuthStore } from "@cashu/sync/testing";
import { afterEach, expect, it } from "vitest";
import type { LocalHost } from "../host.js";
import {
  enabledRelayHost as enabled,
  enginePasses,
  HANDOVER_EXIT_CODE as HANDOVER,
  membersOnlyFetch,
  presetRelaySetting,
  relayBytes,
  relayHarness,
  relayRequests,
  renameVault as rename,
  until,
  vaultQueueDrained,
} from "../testing/relayFixture.js";
import {
  RELAY_BACKOFF_START_MS,
  RELAY_MIN_PULL_GAP_MS,
  RELAY_PULL_INTERVAL_MS,
  RELAY_PUSH_DEBOUNCE_MS,
  RELAY_QUOTA_BACKOFF_MS,
} from "./policy.js";

const harness = relayHarness();
afterEach(() => harness.cleanup());
const setup = harness.setup;

it("enables the vault at the relay, pushes its history on reopen and own writes 2 s later", async () => {
  const env = await setup();
  const host0 = await env.start();
  const client = await env.ui();
  expect(await client.call("native.relay.status", { vault: env.vault })).toEqual({
    configured: true,
    enabled: false,
    devices: 0,
    identityLost: false,
    canReconnect: false,
  });
  expect(host0.relay.pending()).toBe(0);
  client.close();
  await host0.stop();

  const host = await enabled(env);
  const uid = env.relay.auth.record?.uid;
  if (uid === undefined) throw new Error("no relay identity");
  const device = env.fixture.vaultSource.provider.inventory[0]?.deviceId as string;
  const setting = runQuery(host.stores.device.store, relaySetting, { vault: env.vault }).value;
  expect(setting).toMatchObject({
    enabled: true,
    project: "demo-cashu",
    memberUids: { [device]: { uid, role: "admin" } },
  });
  const docs = env.fake.documents(`vaults/${env.vault}`);
  expect(docs.get(`vaults/${env.vault}`)?.fields.admins).toEqual({
    arrayValue: { values: [{ stringValue: uid }] },
  });
  expect(docs.get(`vaults/${env.vault}/members/${uid}`)?.fields).toMatchObject({
    device: { stringValue: device },
    role: { stringValue: "admin" },
  });
  const status = host.relay.status(env.vault);
  expect(status).toMatchObject({ configured: true, enabled: true, devices: 1 });
  expect(status.lastSyncAt).toBe(env.timers.now());

  const before = relayBytes(env.fake, env.vault);
  await rename(host, env.vault, "Renamed here");
  expect(host.relay.pending()).toBe(1);
  expect(env.timers.pendingDelays()).toContain(RELAY_PUSH_DEBOUNCE_MS);
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS - 1);
  expect(relayBytes(env.fake, env.vault)).toBe(before);
  env.timers.advance(1);
  await until(() => host.relay.pending() === 0 && relayBytes(env.fake, env.vault) > before);

  // Enabling again keeps the remote: no reopen.
  expect((await host.relay.enable(env.vault)).reopen).toBe(false);
});

it("backs off while the relay is unreachable and pushes once it answers again", async () => {
  const env = await setup();
  const host = await enabled(env);
  const before = relayBytes(env.fake, env.vault);
  env.fake.faults.unavailable(1_000);
  await rename(host, env.vault, "While offline");
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  await until(() => host.relay.pending() === 0);
  expect(host.relay.transportStatus(env.vault).lastError).toBe("unavailable");
  expect(env.timers.pendingDelays()).toContain(RELAY_BACKOFF_START_MS);
  env.fake.faults.reset();
  env.timers.advance(RELAY_BACKOFF_START_MS);
  await until(() => host.relay.pending() === 0 && relayBytes(env.fake, env.vault) > before);
  expect(host.relay.transportStatus(env.vault).lastError).toBeUndefined();
});

it("pushes own writes before the idle exit", async () => {
  const env = await setup();
  const host = await enabled(env);
  const before = relayBytes(env.fake, env.vault);
  await rename(host, env.vault, "Just before exit");
  expect(host.relay.pending()).toBe(1);
  expect(await host.stop("idle")).toBe(0);
  expect(relayBytes(env.fake, env.vault)).toBeGreaterThan(before);
});

it("reports a replaced relay identity for good: the new uid is no member, nothing uploads, local work goes on", async () => {
  const env = await setup();
  // The security rules in short: a uid without a member document is refused under the vault.
  const relay = { ...env.relay, fetch: membersOnlyFetch(env.fake) };
  const host = await enabled(env, relay);
  const uid = env.relay.auth.record?.uid as string;
  const pushed = relayBytes(env.fake, env.vault);
  env.fake.expireUser(uid);
  env.fake.expireIdTokens();
  await rename(host, env.vault, "After the identity loss");
  // The pause is the engine's (the host clock, real time here): the first failed pass's start.
  const failedFrom = Date.now();
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  const identityLostAt = () =>
    runQuery(host.stores.device.store, relaySetting, { vault: env.vault }).value?.identityLostAt;
  await until(() => host.relay.pending() === 0 && identityLostAt() !== undefined);
  expect(env.relay.auth.record?.uid).not.toBe(uid);
  const pausedSince = host.relay.status(env.vault).pausedSince as number;
  expect(pausedSince).toBeGreaterThanOrEqual(failedFrom);
  expect(pausedSince).toBeLessThanOrEqual(Date.now());
  // Reconnecting needs the vault's recovery secret, which these options do not keep.
  expect(host.relay.status(env.vault)).toMatchObject({ identityLost: true, canReconnect: false });
  expect(host.relay.transportStatus(env.vault).lastError).toBe("relay-identity-lost");

  // The next passes start after the loss, but the rules refuse the new uid: the flag stays, nothing
  // reaches the relay, and the vault keeps taking local writes.
  await rename(host, env.vault, "With the new identity");
  env.timers.advance(RELAY_BACKOFF_START_MS);
  await until(() => host.relay.pending() === 0);
  await vaultQueueDrained(host, env.vault);
  env.timers.advance(2 * RELAY_BACKOFF_START_MS);
  await until(() => host.relay.pending() === 0);
  await vaultQueueDrained(host, env.vault);
  expect(identityLostAt()).toBeDefined();
  expect(host.relay.status(env.vault)).toMatchObject({ identityLost: true, pausedSince });
  expect(host.relay.transportStatus(env.vault).lastError).toBe("relay-identity-lost");
  expect(relayBytes(env.fake, env.vault)).toBe(pushed);
  expect(host.stores.vaults.get(env.vault)?.native?.isCurrent()).toBe(true);
  await rename(host, env.vault, "Still local");
});

it("refuses every pass at once while a back-off runs, reports the pause and clears it on success (S6, D6)", async () => {
  const env = await setup();
  const host = await enabled(env);
  const before = relayBytes(env.fake, env.vault);
  env.fake.faults.unavailable(1_000);
  await rename(host, env.vault, "While offline");
  // The pause is the engine's (the host clock, real time here): the first failed pass's start.
  const failedFrom = Date.now();
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  await until(() => host.relay.pending() === 0);
  const client = await env.ui();
  const paused = (await client.call("native.relay.status", { vault: env.vault })) as {
    pausedSince?: number;
  };
  expect(paused).toMatchObject({ enabled: true, identityLost: false });
  expect(host.relay.transportStatus(env.vault).lastError).toBe("unavailable");
  const failedAt = paused.pausedSince as number;
  expect(failedAt).toBeGreaterThanOrEqual(failedFrom);
  expect(failedAt).toBeLessThanOrEqual(Date.now());
  // The relay now hangs every request for 10 minutes (real time): a pass that asked it would hold
  // the vault queue that long. Any other caller's pass inside the back-off never asks it.
  env.fake.faults.reset();
  env.fake.faults.slow(10 * 60_000);
  const requests = relayRequests(env.fake);
  const result = await host.syncVault(env.vault);
  await rename(host, env.vault, "Local write during the pause");
  await vaultQueueDrained(host, env.vault);
  expect(relayRequests(env.fake)).toBe(requests);
  expect(result).toBeDefined();
  // The pause outlives a later failure: it shows when sync stopped, not the last attempt.
  env.fake.faults.reset();
  env.fake.faults.unavailable(1_000);
  env.timers.advance(RELAY_BACKOFF_START_MS);
  await until(() => host.relay.pending() === 0 && relayRequests(env.fake) > requests);
  await vaultQueueDrained(host, env.vault);
  expect(host.relay.status(env.vault).pausedSince).toBe(failedAt);
  env.fake.faults.reset();
  env.timers.advance(2 * RELAY_BACKOFF_START_MS);
  await until(() => host.relay.pending() === 0 && relayBytes(env.fake, env.vault) > before);
  const status = await client.call("native.relay.status", { vault: env.vault });
  expect(status).not.toHaveProperty("pausedSince");
  expect(status).not.toHaveProperty("stuck");
  client.close();
});

it("runs exactly one more pass for a write made while a pass runs", async () => {
  const env = await setup();
  const host = await enabled(env);
  const passes = enginePasses(host, env.vault);
  await rename(host, env.vault, "Armed");
  // Another caller's pass holds the vault queue; a write and the relay's push queue behind it.
  passes.hold();
  const foreign = host.syncVault(env.vault);
  await until(() => passes.running === 1);
  const writing = rename(host, env.vault, "During the pass");
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  expect(host.relay.pending()).toBe(1);
  // The foreign pass ends, the write commits, the relay's pass starts and is held.
  passes.release();
  passes.hold();
  await writing;
  await foreign;
  await until(() => passes.running === 1 && passes.count === 2);
  const pushed = relayBytes(env.fake, env.vault);
  // The write's push falls due while the relay's pass runs: one more pass after it, not two.
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  passes.release();
  await until(() => host.relay.pending() === 0 && passes.running === 0 && passes.count >= 3);
  await vaultQueueDrained(host, env.vault);
  expect(passes.count).toBe(3);
  expect(relayBytes(env.fake, env.vault)).toBeGreaterThan(pushed);
  // Nothing else is armed on the virtual clock but the pull timer.
  expect(env.timers.pendingDelays()).toHaveLength(1);
});

it("doubles the back-off to its cap while reads answer and every append times out (slow uplink)", async () => {
  const env = await setup();
  // Reads (get, runQuery) answer; every commit (append) fails like a timeout once `slow` is on.
  const uplink = { slow: false, commitsAt: [] as number[], readsAt: [] as number[] };
  const fetch: FakeFirebase["fetch"] = async (url, init) => {
    if (uplink.slow && url.endsWith(":commit")) {
      uplink.commitsAt.push(env.timers.now());
      const text = JSON.stringify({ error: { code: 503, status: "UNAVAILABLE" } });
      return { status: 503, text: async () => text, json: async () => JSON.parse(text) };
    }
    if (uplink.slow && url.includes("/v1/projects/")) uplink.readsAt.push(env.timers.now());
    return env.fake.fetch(url, init);
  };
  const host = await enabled(env, { ...env.relay, fetch });
  uplink.slow = true;
  await rename(host, env.vault, "Slow uplink");
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  await until(() => host.relay.pending() === 0 && uplink.commitsAt.length === 1);
  // Gaps between append attempts: 60 s doubling to the 30 min cap (literal minutes, not the policy's
  // constants), each pass reading successfully before its append fails.
  const expected = [1, 2, 4, 8, 16, 30, 30].map((minutes) => minutes * 60_000);
  const gaps: number[] = [];
  for (const gap of expected) {
    const attempts = uplink.commitsAt.length;
    const last = uplink.commitsAt[attempts - 1] ?? 0;
    env.timers.advance(gap - 1);
    await vaultQueueDrained(host, env.vault);
    expect(uplink.commitsAt).toHaveLength(attempts);
    const reads = uplink.readsAt.length;
    env.timers.advance(1);
    await until(() => host.relay.pending() === 0 && uplink.commitsAt.length > attempts);
    expect(uplink.readsAt.length).toBeGreaterThan(reads);
    gaps.push((uplink.commitsAt[attempts] ?? 0) - last);
  }
  expect(gaps).toEqual(expected);
  expect(host.relay.transportStatus(env.vault).lastError).toBe("unavailable");
});

it("waits out a 1 h back-off when the relay's quota is exhausted", async () => {
  const env = await setup();
  const host = await enabled(env);
  const before = relayBytes(env.fake, env.vault);
  env.fake.faults.quota(1_000);
  await rename(host, env.vault, "Over quota");
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  await until(() => host.relay.pending() === 0);
  expect(host.relay.transportStatus(env.vault).lastError).toBe("quota");
  expect(env.timers.pendingDelays()).toContain(RELAY_QUOTA_BACKOFF_MS);
  // The row's quota line: the hour's end on the relay clock.
  const quotaUntil = host.relay.status(env.vault).quotaUntil as number;
  expect(quotaUntil - env.timers.now()).toBeGreaterThan(
    RELAY_QUOTA_BACKOFF_MS - RELAY_PUSH_DEBOUNCE_MS,
  );
  expect(quotaUntil - env.timers.now()).toBeLessThanOrEqual(RELAY_QUOTA_BACKOFF_MS);
  const failed = relayRequests(env.fake);
  // Pull ticks and further writes inside the hour reach nothing.
  await rename(host, env.vault, "Still over quota");
  env.timers.advance(RELAY_QUOTA_BACKOFF_MS - RELAY_PUSH_DEBOUNCE_MS - 1);
  await vaultQueueDrained(host, env.vault);
  expect(relayRequests(env.fake)).toBe(failed);
  env.fake.faults.reset();
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS + 1);
  await until(() => host.relay.pending() === 0 && relayBytes(env.fake, env.vault) > before);
  expect(host.relay.transportStatus(env.vault).lastError).toBeUndefined();
  expect(host.relay.status(env.vault)).not.toHaveProperty("quotaUntil");
});

it("keeps a pull at least 60 s after the previous pass", async () => {
  const env = await setup();
  const host = await enabled(env);
  // The pull timer ticks every 5 minutes from the start; a push 28 s before a tick.
  const lead = RELAY_MIN_PULL_GAP_MS / 2 - RELAY_PUSH_DEBOUNCE_MS;
  env.timers.advance(RELAY_PULL_INTERVAL_MS - RELAY_MIN_PULL_GAP_MS / 2);
  await vaultQueueDrained(host, env.vault);
  await rename(host, env.vault, "Before the tick");
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  await until(() => host.relay.pending() === 0);
  await vaultQueueDrained(host, env.vault);
  // The member reconciliation that follows a pass reaching the relay lists members (a runQuery too):
  // counted only once it is done.
  let settled = -1;
  while (settled !== env.fake.counters.runQuery) {
    settled = env.fake.counters.runQuery;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const pushed = env.fake.counters.runQuery;
  env.timers.advance(lead);
  await vaultQueueDrained(host, env.vault);
  expect(host.relay.pending()).toBe(0);
  expect(env.fake.counters.runQuery).toBe(pushed);
  // The next tick is far enough from the push: it pulls.
  env.timers.advance(RELAY_PULL_INTERVAL_MS);
  await until(() => env.fake.counters.runQuery > pushed && host.relay.pending() === 0);
});

it("makes no relay request for a vault that is off, whatever triggers a pass", async () => {
  const env = await setup();
  presetRelaySetting(env.fixture.dataDir, env.vault, {
    enabled: false,
    project: "demo-cashu",
    enabledAt: env.timers.now(),
    memberUids: {},
  });
  const host = await env.start();
  env.timers.advance(0);
  await rename(host, env.vault, "Local only");
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  env.timers.advance(3 * RELAY_PULL_INTERVAL_MS);
  await host.syncVault(env.vault);
  const client = await env.ui();
  expect(await client.call("native.relay.status", { vault: env.vault })).toMatchObject({
    configured: true,
    enabled: false,
  });
  client.close();
  expect(host.relay.pending()).toBe(0);
  expect(await host.stop("idle")).toBe(0);
  expect(relayRequests(env.fake)).toBe(0);
});

it("runs no pass once the switch reads off, even before the vaults reopen", async () => {
  const env = await setup();
  const host = await enabled(env);
  const device = host.stores.device;
  const setting = runQuery(device.store, relaySetting, { vault: env.vault }).value;
  if (setting === null) throw new Error("no relay setting");
  // Turned off underneath the relay (not through its action): every trigger re-reads it.
  const off = await device.queue.run(() =>
    device.store.run(setRelaySetting, { vault: env.vault, value: { ...setting, enabled: false } }),
  );
  expect(off.ok).toBe(true);
  const before = relayRequests(env.fake);
  await rename(host, env.vault, "After the switch");
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  env.timers.advance(RELAY_PULL_INTERVAL_MS);
  await vaultQueueDrained(host, env.vault);
  expect(host.relay.pending()).toBe(0);
  expect(relayRequests(env.fake)).toBe(before);
});

it("disables (reopening without the remote) and purges the vault's segments only", async () => {
  const env = await setup();
  const host = await enabled(env);
  const client = await env.ui();
  expect(await client.call("native.relay.disable", { vault: env.vault })).toEqual({
    kind: "done",
  });
  expect(await host.exit).toBe(HANDOVER);
  const reopened = await env.start();
  expect(reopened.relay.status(env.vault)).toMatchObject({ enabled: false, devices: 0 });
  await rename(reopened, env.vault, "Local only");
  expect(reopened.relay.pending()).toBe(0);

  const uid = env.relay.auth.record?.uid as string;
  expect(relayBytes(env.fake, env.vault)).toBeGreaterThan(0);
  expect(await reopened.relay.purge(env.vault)).toEqual({
    result: { kind: "done" },
    reopen: false,
  });
  expect(relayBytes(env.fake, env.vault)).toBe(0);
  expect([...env.fake.documents(`vaults/${env.vault}/segments/`).keys()]).toEqual([]);
  const left = env.fake.documents(`vaults/${env.vault}`);
  expect(left.has(`vaults/${env.vault}`)).toBe(true);
  expect(left.has(`vaults/${env.vault}/members/${uid}`)).toBe(true);
});

it("refuses without a config, when another admin owns the vault and while offline", async () => {
  const bare = await setup({ relay: false });
  await bare.start();
  const client = await bare.ui();
  expect(await client.call("native.relay.status", { vault: bare.vault })).toEqual({
    configured: false,
    enabled: false,
    devices: 0,
    identityLost: false,
    canReconnect: false,
  });
  for (const method of [
    "native.relay.enable",
    "native.relay.disable",
    "native.relay.purge",
    "native.relay.reconnect",
  ])
    expect(await client.call(method, { vault: bare.vault })).toEqual({
      kind: "refused",
      reason: "no_config",
    });

  const env = await setup();
  const host = await env.start();
  env.fake.faults.unavailable(1_000);
  expect(await host.relay.enable(env.vault)).toEqual({
    result: { kind: "refused", reason: "offline" },
    reopen: false,
  });
  env.fake.faults.reset();
  // Another device made the vault first: this Mac's uid is not its admin.
  await createVaultAsOtherAdmin(env.fake, env.vault);
  expect(await host.relay.enable(env.vault)).toEqual({
    result: { kind: "refused", reason: "not_admin" },
    reopen: false,
  });
  expect(runQuery(host.stores.device.store, relaySetting, { vault: env.vault }).value).toBeNull();
  expect(await host.relay.enable("f".repeat(32))).toEqual({
    result: { kind: "refused", reason: "busy" },
    reopen: false,
  });
});

/** A second identity at the same fake creates the vault documents first. */
async function createVaultAsOtherAdmin(fake: FakeFirebase, vault: string): Promise<void> {
  const auth = new AnonymousAuth({
    endpoint: fake.identity,
    store: new MemoryAuthStore(),
    fetch: fake.fetch,
  });
  const rest = new FirestoreRest({ endpoint: fake.endpoint, auth, fetch: fake.fetch });
  const uid = await auth.uid();
  const at = { timestampValue: new Date().toISOString() };
  await rest.commit([
    {
      update: {
        name: `vaults/${vault}`,
        fields: { createdAt: at, admins: { arrayValue: { values: [{ stringValue: uid }] } } },
      },
      currentDocument: { exists: false },
    },
    {
      update: {
        name: `vaults/${vault}/members/${uid}`,
        fields: {
          device: { stringValue: "e".repeat(32) },
          role: { stringValue: "admin" },
          addedAt: at,
        },
      },
    },
  ]);
}

it("answers admin when the create commit landed but its response was lost and the retry found it", async () => {
  const env = await setup();
  const host = await env.start({ ...env.relay, retries: 1 });
  env.fake.faults.loseNextCommitResponse();
  const outcome = await host.relay.enable(env.vault);
  expect(outcome.result).toEqual({ kind: "done" });
  const uid = env.relay.auth.record?.uid as string;
  expect(env.fake.documents(`vaults/${env.vault}`).has(`vaults/${env.vault}/members/${uid}`)).toBe(
    true,
  );
});

const always = () => true;
const pullKind = (host: LocalHost, vault: string) =>
  host.stores.vaults.get(vault)?.native?.engine.fetchLeaseEvidence(always, always).pull.kind;

/**
 * Deletes (or adds) a member document as a second identity: the fake runs no rules, so this
 * stands in for another admin's purge, or a phone the Mac granted.
 */
async function memberDocAs(
  fake: FakeFirebase,
  vault: string,
  uid: string,
  action: "delete" | "add" = "delete",
): Promise<void> {
  const auth = new AnonymousAuth({
    endpoint: fake.identity,
    store: new MemoryAuthStore(),
    fetch: fake.fetch,
  });
  const rest = new FirestoreRest({ endpoint: fake.endpoint, auth, fetch: fake.fetch });
  const name = `vaults/${vault}/members/${uid}`;
  await rest.commit([
    action === "delete"
      ? { delete: name }
      : { update: { name, fields: { device: { stringValue: "e".repeat(32) } } } },
  ]);
}

it("a removed Mac (member doc deleted) is never offline, not even through the back-off (G1)", async () => {
  const env = await setup();
  const relay = { ...env.relay, fetch: membersOnlyFetch(env.fake) };
  const host = await enabled(env, relay);
  const uid = env.relay.auth.record?.uid as string;
  await host.syncVault(env.vault);
  expect(pullKind(host, env.vault)).toBe("pulled");
  await memberDocAs(env.fake, env.vault, uid);
  // The relay's own push pass meets the 403 and arms the back-off.
  await rename(host, env.vault, "After removal");
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  await until(() => host.relay.pending() === 0);
  await vaultQueueDrained(host, env.vault);
  expect(host.relay.transportStatus(env.vault).lastError).toBe("forbidden");
  expect(pullKind(host, env.vault)).toBe("incomplete");
  // Another caller's pass inside the back-off is refused at once, with the refusal's reason.
  const requests = relayRequests(env.fake);
  await host.syncVault(env.vault);
  expect(relayRequests(env.fake)).toBe(requests);
  expect(pullKind(host, env.vault)).toBe("incomplete");
});

it("a quota day is an outage: offline, and the back-off answer says so (G1)", async () => {
  const env = await setup();
  const host = await enabled(env);
  env.fake.faults.quota(1_000);
  await host.syncVault(env.vault);
  expect(host.relay.transportStatus(env.vault).lastError).toBe("quota");
  expect(pullKind(host, env.vault)).toBe("offline");
  const requests = relayRequests(env.fake);
  await host.syncVault(env.vault);
  expect(relayRequests(env.fake)).toBe(requests);
  expect(pullKind(host, env.vault)).toBe("offline");
});

it("any caller's failed pass arms the back-off, so the next caller never waits on the relay (G4)", async () => {
  const env = await setup();
  const host = await enabled(env);
  const before = relayRequests(env.fake);
  env.fake.faults.unavailable(1_000);
  // A UI pass, not the relay's own: it asks the relay once and fails.
  await host.syncVault(env.vault);
  const asked = relayRequests(env.fake);
  expect(asked).toBeGreaterThan(before);
  // The relay now hangs every request for 10 minutes (real time): a pass that asked would hold the
  // vault queue that long. A bank sync's pass right after never asks.
  env.fake.faults.reset();
  env.fake.faults.slow(10 * 60_000);
  await host.syncVault(env.vault);
  expect(relayRequests(env.fake)).toBe(asked);
  // On the virtual clock: still refused 1 ms before the back-off ends, asked again once it ended.
  env.fake.faults.reset();
  env.timers.advance(RELAY_BACKOFF_START_MS - 1);
  await host.syncVault(env.vault);
  expect(relayRequests(env.fake)).toBe(asked);
  env.timers.advance(1);
  await host.syncVault(env.vault);
  expect(relayRequests(env.fake)).toBeGreaterThan(asked);
  expect(pullKind(host, env.vault)).toBe("pulled");
});

it("keeps the pause and the last complete pull with the relay switch across a restart (G2, G5)", async () => {
  const env = await setup();
  const host = await enabled(env);
  const stored = (h: LocalHost) =>
    runQuery(h.stores.device.store, relaySetting, { vault: env.vault }).value;
  await host.syncVault(env.vault);
  await until(() => stored(host)?.lastCompletePullAt !== undefined);
  expect(stored(host)?.pausedSince).toBeUndefined();
  env.fake.faults.unavailable(1_000);
  await host.syncVault(env.vault);
  await until(() => stored(host)?.pausedSince !== undefined);
  const pausedSince = stored(host)?.pausedSince as number;
  const lastComplete = stored(host)?.lastCompletePullAt as number;
  // Written together with the pause: exactly the engine's history.
  expect(host.stores.vaults.get(env.vault)?.native?.engine.pullHistory()).toEqual({
    lastCompleteAt: lastComplete,
    pausedSince,
  });
  expect(lastComplete).toBeLessThanOrEqual(pausedSince);
  expect(host.relay.status(env.vault).pausedSince).toBe(pausedSince);
  await host.stop();

  // A new host start (the idle exit and a later launch): the pause shows when sync stopped.
  const again = await env.start();
  env.timers.advance(0);
  await until(() => again.relay.pending() === 0);
  expect(again.relay.status(env.vault).pausedSince).toBe(pausedSince);
  expect(again.stores.vaults.get(env.vault)?.native?.engine.pullHistory()).toEqual({
    lastCompleteAt: lastComplete,
    pausedSince,
  });
  // The next complete pull clears the pause, in memory and in the switch.
  env.fake.faults.reset();
  env.timers.advance(RELAY_QUOTA_BACKOFF_MS);
  await again.syncVault(env.vault);
  await until(() => stored(again)?.pausedSince === undefined);
  expect(again.relay.status(env.vault)).not.toHaveProperty("pausedSince");
  expect(stored(again)?.lastCompletePullAt as number).toBeGreaterThan(lastComplete);
});

it("answers retry for a purge that stopped part way, offline for one that deleted nothing", async () => {
  const env = await setup();
  // Commits fail from the n-th on (n = Infinity: never); every other request passes.
  const gate = { failFrom: Number.POSITIVE_INFINITY, commits: 0 };
  const fetch: FakeFirebase["fetch"] = async (url, init) => {
    if (url.endsWith(":commit") && ++gate.commits >= gate.failFrom) {
      const text = JSON.stringify({ error: { code: 503, status: "UNAVAILABLE" } });
      return { status: 503, text: async () => text, json: async () => JSON.parse(text) };
    }
    return env.fake.fetch(url, init);
  };
  const host = await enabled(env, { ...env.relay, fetch });
  // A phone's member document: the purge deletes it in a commit of its own, before the segments.
  await memberDocAs(env.fake, env.vault, "uid-phone", "add");
  expect(relayBytes(env.fake, env.vault)).toBeGreaterThan(0);
  gate.commits = 0;
  gate.failFrom = 1;
  expect((await host.relay.purge(env.vault)).result).toEqual({
    kind: "refused",
    reason: "offline",
  });
  gate.commits = 0;
  gate.failFrom = 2;
  expect((await host.relay.purge(env.vault)).result).toEqual({ kind: "refused", reason: "retry" });
  expect(env.fake.documents(`vaults/${env.vault}/members/uid-phone`).size).toBe(0);
  expect(relayBytes(env.fake, env.vault)).toBeGreaterThan(0);
  gate.failFrom = Number.POSITIVE_INFINITY;
  expect((await host.relay.purge(env.vault)).result).toEqual({ kind: "done" });
  expect(relayBytes(env.fake, env.vault)).toBe(0);
});
