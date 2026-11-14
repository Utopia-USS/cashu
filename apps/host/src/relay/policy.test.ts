import { expect, it } from "vitest";
import {
  RELAY_BACKOFF_MAX_MS,
  RELAY_BACKOFF_START_MS,
  RELAY_MIN_PULL_GAP_MS,
  RELAY_QUOTA_BACKOFF_MS,
  RelayPolicy,
} from "./policy.js";

it("keeps pulls at least 60 s apart and lets pushes run at once", () => {
  const policy = new RelayPolicy();
  expect(policy.allows("pull", 0)).toBe(true);
  policy.started(0);
  expect(policy.allows("pull", RELAY_MIN_PULL_GAP_MS - 1)).toBe(false);
  expect(policy.nextAt("pull", 10)).toBe(RELAY_MIN_PULL_GAP_MS);
  expect(policy.allows("push", 10)).toBe(true);
  expect(policy.allows("open", 10)).toBe(true);
  expect(policy.allows("pull", RELAY_MIN_PULL_GAP_MS)).toBe(true);
});

it("backs off 60 s doubling to 30 min while unreachable, 1 h on quota, and resets on success", () => {
  const policy = new RelayPolicy();
  const delays: number[] = [];
  let now = 0;
  for (let i = 0; i < 8; i++) {
    policy.failed("unavailable", now, "outage", "read");
    delays.push(policy.blockedUntil - now);
    expect(policy.allows("push", now)).toBe(false);
    // The final push before the idle exit is one attempt whatever the back-off.
    expect(policy.allows("final", now)).toBe(true);
    now = policy.blockedUntil;
  }
  expect(delays).toEqual([
    RELAY_BACKOFF_START_MS,
    2 * RELAY_BACKOFF_START_MS,
    4 * RELAY_BACKOFF_START_MS,
    8 * RELAY_BACKOFF_START_MS,
    16 * RELAY_BACKOFF_START_MS,
    RELAY_BACKOFF_MAX_MS,
    RELAY_BACKOFF_MAX_MS,
    RELAY_BACKOFF_MAX_MS,
  ]);
  policy.succeeded("read");
  expect(policy.allows("push", now)).toBe(true);
  policy.failed("quota", now, "outage", "write");
  expect(policy.nextAt("push", now)).toBe(now + RELAY_QUOTA_BACKOFF_MS);
  expect(policy.nextAt("final", now)).toBe(now);
  policy.succeeded("write");
  policy.failed("unavailable", now, "outage", "write");
  expect(policy.blockedUntil - now).toBe(RELAY_BACKOFF_START_MS);
});

it("keeps doubling while reads answer and every write fails: a read never resets a write's back-off", () => {
  const policy = new RelayPolicy();
  const gaps: number[] = [];
  let now = 0;
  for (let i = 0; i < 8; i++) {
    // One pass: the list answers, the append times out.
    policy.succeeded("read");
    policy.failed("unavailable", now, "outage", "write");
    // The read of the same pass (or of another caller) does not cancel the back-off either.
    policy.succeeded("read");
    expect(policy.allows("push", now)).toBe(false);
    gaps.push(policy.blockedUntil - now);
    now = policy.blockedUntil;
  }
  expect(gaps).toEqual([
    60_000,
    120_000,
    240_000,
    480_000,
    960_000,
    30 * 60_000,
    30 * 60_000,
    30 * 60_000,
  ]);
  // A write that works ends it; so does a working read when writes are healthy.
  policy.succeeded("write");
  expect(policy.blockedUntil).toBe(0);
  policy.failed("unavailable", now, "outage", "read");
  expect(policy.blockedUntil - now).toBe(60_000);
  policy.succeeded("read");
  expect(policy.allows("push", now)).toBe(true);
});

it("remembers why the back-off runs, for the gate's answer (G1)", () => {
  const policy = new RelayPolicy();
  expect(policy.blockedReason).toBe("outage");
  policy.failed("unavailable", 0, "refused", "read");
  expect(policy.blockedReason).toBe("refused");
  policy.failed("quota", 1, "outage", "read");
  expect(policy.blockedReason).toBe("outage");
  policy.failed("unavailable", 2, "identity-lost", "write");
  // A read that works keeps the write's refusal as the reason while the write still fails.
  policy.succeeded("read");
  expect(policy.blockedReason).toBe("identity-lost");
  policy.succeeded("write");
  expect(policy.blockedReason).toBe("outage");
});

it("reports the quota's end only while the quota back-off runs, and a reset clears every back-off", () => {
  const policy = new RelayPolicy();
  expect(policy.quotaUntil(0)).toBeUndefined();
  policy.failed("quota", 1_000, "outage", "write");
  expect(policy.quotaUntil(1_000)).toBe(1_000 + 60 * 60_000);
  expect(policy.quotaUntil(1_000 + 60 * 60_000)).toBeUndefined();
  // An outage after it is not a quota.
  policy.failed("unavailable", 2_000, "outage", "read");
  expect(policy.quotaUntil(2_000)).toBeUndefined();
  policy.failed("unavailable", 3_000, "identity-lost", "write");
  expect(policy.allows("push", 3_000)).toBe(false);
  policy.reset();
  expect(policy.allows("push", 3_000)).toBe(true);
  expect(policy.blockedReason).toBe("outage");
  // The failure counts restarted: the next outage waits the first step again.
  policy.failed("unavailable", 4_000, "outage", "write");
  expect(policy.blockedUntil - 4_000).toBe(60_000);
});
