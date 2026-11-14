// Stopping relay work on a native host over the in-memory Firebase fake: `purge` and `disable` halt
// the vault before anything else runs (a push armed or a pull due during the action queues no pass, and
// no caller reaches the relay until the reopen), and the final push before the idle exit (one attempt
// even inside a back-off, at most 10 s, cut short by a stronger stop that keeps its own exit code).
// Synthetic vaults only; the fake is `demo-cashu`.
import { afterEach, expect, it } from "vitest";
import {
  enabledRelayHost,
  HANDOVER_EXIT_CODE,
  relayBytes,
  relayHarness,
  relayRequests,
  renameVault,
  until,
  vaultQueueDrained,
} from "../testing/relayFixture.js";
import {
  RELAY_BACKOFF_MAX_MS,
  RELAY_FINAL_PUSH_TIMEOUT_MS,
  RELAY_PULL_INTERVAL_MS,
  RELAY_PUSH_DEBOUNCE_MS,
} from "./policy.js";

const harness = relayHarness();
afterEach(() => harness.cleanup());

/** Real time for the host's own promises to move (the relay's clock is virtual). */
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

it("purges an enabled vault with a push pending and never pushes it again before the reopen", async () => {
  const env = await harness.setup();
  const host = await enabledRelayHost(env);
  expect(relayBytes(env.fake, env.vault)).toBeGreaterThan(0);
  await renameVault(host, env.vault, "Pending push");
  expect(host.relay.pending()).toBe(1);

  const purging = host.relay.purge(env.vault);
  // The armed debounce and a pull tick fall due while the purge runs.
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  env.timers.advance(RELAY_PULL_INTERVAL_MS);
  expect(await purging).toEqual({ result: { kind: "done" }, reopen: true });
  await vaultQueueDrained(host, env.vault);
  expect(relayBytes(env.fake, env.vault)).toBe(0);
  const purged = relayRequests(env.fake);

  // Until the reopen: no trigger and no other caller reaches the relay.
  env.timers.advance(RELAY_BACKOFF_MAX_MS + RELAY_PULL_INTERVAL_MS);
  await renameVault(host, env.vault, "After the purge");
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  await host.syncVault(env.vault).catch(() => undefined);
  await vaultQueueDrained(host, env.vault);
  // Nothing is armed on the virtual clock but the pull timer: no pass can be on its way.
  expect(env.timers.pendingDelays()).toHaveLength(1);
  expect(host.relay.pending()).toBe(0);
  expect(relayRequests(env.fake)).toBe(purged);
  expect(relayBytes(env.fake, env.vault)).toBe(0);
  expect(host.relay.status(env.vault)).toMatchObject({ enabled: false });
});

it("disables a vault with a push pending: no request from the moment it is asked", async () => {
  const env = await harness.setup();
  const host = await enabledRelayHost(env);
  const pushed = relayBytes(env.fake, env.vault);
  await renameVault(host, env.vault, "Pending push");
  const before = relayRequests(env.fake);

  const disabling = host.relay.disable(env.vault);
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  env.timers.advance(RELAY_PULL_INTERVAL_MS);
  expect(await disabling).toEqual({ result: { kind: "done" }, reopen: true });
  env.timers.advance(RELAY_BACKOFF_MAX_MS + RELAY_PULL_INTERVAL_MS);
  await renameVault(host, env.vault, "After the switch");
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  await host.syncVault(env.vault).catch(() => undefined);
  await vaultQueueDrained(host, env.vault);
  // Nothing is armed on the virtual clock but the pull timer: no pass can be on its way.
  expect(env.timers.pendingDelays()).toHaveLength(1);
  expect(host.relay.pending()).toBe(0);
  expect(relayRequests(env.fake)).toBe(before);
  expect(relayBytes(env.fake, env.vault)).toBe(pushed);
  // The idle exit pushes nothing for it either.
  expect(await host.stop("idle")).toBe(0);
  expect(relayRequests(env.fake)).toBe(before);
});

it("pushes own writes at the idle exit even inside a back-off", async () => {
  const env = await harness.setup();
  const host = await enabledRelayHost(env);
  const before = relayBytes(env.fake, env.vault);
  env.fake.faults.unavailable(1_000);
  await renameVault(host, env.vault, "While offline");
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  await until(() => host.relay.pending() === 0);
  expect(host.relay.status(env.vault).status.lastError).toBe("unavailable");
  // The relay answers again, but the retry is a minute away: the idle exit does not wait for it.
  env.fake.faults.reset();
  expect(await host.stop("idle")).toBe(0);
  expect(relayBytes(env.fake, env.vault)).toBeGreaterThan(before);
});

it("gives the final push at most 10 s, then exits", async () => {
  const env = await harness.setup();
  const host = await enabledRelayHost(env);
  await renameVault(host, env.vault, "Before a stalled relay");
  const before = relayRequests(env.fake);
  env.fake.faults.slow(60_000);
  let code: number | undefined;
  const stopping = host.stop("idle").then((c) => {
    code = c;
    return c;
  });
  await until(() => relayRequests(env.fake) > before);
  env.timers.advance(RELAY_FINAL_PUSH_TIMEOUT_MS - 1);
  await settle();
  expect(code).toBeUndefined();
  env.timers.advance(1);
  expect(await stopping).toBe(0);
});

it("cuts the final push short for a handover, which keeps its exit code", async () => {
  const env = await harness.setup();
  const host = await enabledRelayHost(env);
  await renameVault(host, env.vault, "Before a stalled relay");
  const before = relayRequests(env.fake);
  env.fake.faults.slow(60_000);
  const idle = host.stop("idle");
  await until(() => relayRequests(env.fake) > before);
  // No virtual time passes: only the handover ends the final push.
  expect(await host.stop("handover")).toBe(HANDOVER_EXIT_CODE);
  expect(await idle).toBe(HANDOVER_EXIT_CODE);
  expect(await host.exit).toBe(HANDOVER_EXIT_CODE);
});

it("cuts the final push short for a signal stop", async () => {
  const env = await harness.setup();
  const host = await enabledRelayHost(env);
  await renameVault(host, env.vault, "Before a stalled relay");
  const before = relayRequests(env.fake);
  env.fake.faults.slow(60_000);
  const idle = host.stop("idle");
  await until(() => relayRequests(env.fake) > before);
  expect(await host.stop("signal")).toBe(0);
  expect(await idle).toBe(0);
});
