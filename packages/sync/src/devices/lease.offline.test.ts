// D6 (B1): a pinned leader keeps acting on the last known lease state while the only thing missing is
// the pull from an unreachable remote (the engine's `PullStatus` `offline`, carried as
// `LeaseLocal.offlinePull`). Mode auto keeps the strict rule. G2: while another device could be pinned,
// only for OFFLINE_LEAD_MAX_MS after the last complete pull. Synthetic devices only.

import { describe, expect, it } from "vitest";
import {
  advance,
  boundedConfig,
  config,
  decide,
  devices,
  MIN,
  pin,
  view,
  visibilityOf,
} from "../testing/devices/leaseSim.js";
import type { SimDevice } from "../testing/devices/testkit.js";
import { holdsLease, type LeaseConfig, type LeaseLocal } from "./lease.js";

const DAY = 24 * 60 * MIN;

/**
 * `d`'s lease inputs after a pass that reached everything but an unreachable remote, `ago` ms ago.
 * By default another device could lead and the last complete pull ended the minute before `since`.
 */
function offline(
  d: SimDevice,
  ago = 0,
  since = d.now() - 10 * MIN,
  bound: { peerCanLead: boolean; lastCompleteAt?: number } = {
    peerCanLead: true,
    lastCompleteAt: since - MIN,
  },
): LeaseLocal {
  return { ...d.local(), offlinePull: { since, reachedAt: d.now() - ago, ...bound } };
}

const holdsWith = (d: SimDevice, local: LeaseLocal, cfg: LeaseConfig = config) =>
  holdsLease(view(d), local, cfg);

describe("D6: pinned leader without the relay", () => {
  it("acts on an offline pass while its complete pull went stale; a stale offline pass does not", async () => {
    const { a, b, c } = await devices([0, 0, 0], { mode: "pinned" });
    for (const d of [a, b, c]) d.sync();
    expect(view(a)).toMatchObject({ mode: "pinned", pinned: a.id, pendingFrom: null });
    expect(holdsWith(a, a.local())).toBe(true);
    advance(a, 2 * config.publishDeadlineMs);
    // The complete pull is older than the publish deadline: refused without the offline pass.
    expect(holdsWith(a, a.local())).toBe(false);
    expect(holdsWith(a, offline(a))).toBe(true);
    expect(holdsWith(a, offline(a, config.publishDeadlineMs))).toBe(true);
    expect(holdsWith(a, offline(a, config.publishDeadlineMs + 1))).toBe(false);
    // An offline pass from the future (a clock that went back) proves nothing.
    expect(holdsWith(a, offline(a, -1))).toBe(false);
    // Nobody else gains anything from being offline.
    for (const d of [b, c]) expect(holdsWith(d, offline(d)), d.name).toBe(false);
  });

  it("a suspect clock still refuses, offline or not", async () => {
    const { a } = await devices([0, 0, 0], { mode: "pinned" });
    a.sync();
    expect(holdsWith(a, { ...offline(a), clockOk: false })).toBe(false);
  });

  it("re-pinned elsewhere while offline: leads on the last known state, stops after the first pull", async () => {
    const { a, b, c } = await devices([0, 0, 0], { mode: "pinned" });
    for (const d of [a, b, c]) d.sync();
    // The owner force-pins the phone (the Mac is unreachable for it); the Mac's relay is down.
    pin(b, "pinned", b, { force: true });
    b.sync();
    expect(view(b)).toMatchObject({ pinned: b.id, pendingFrom: null });
    advance(a, 5 * MIN);
    // The Mac has not seen the pin: it acts on what it knows (the one extra fetch D6 accepts).
    expect(view(a).pinned).toBe(a.id);
    expect(holdsWith(a, offline(a))).toBe(true);
    // Reconnected: the first pull delivers the pin and the Mac stops leading at once.
    a.sync();
    expect(view(a).pinned).toBe(b.id);
    expect(holdsWith(a, a.local())).toBe(false);
    expect(holdsWith(a, offline(a))).toBe(false);
    b.sync();
    expect([a, b, c].filter((d) => holdsWith(d, d.local()))).toEqual([b]);
  });
});

describe("G2: the offline lead is bounded while another device could lead", () => {
  it("another device could be pinned: 7 days after the last complete pull, not a millisecond more", async () => {
    const { a } = await devices([0, 0, 0], { mode: "pinned" });
    a.sync();
    advance(a, 2 * config.publishDeadlineMs);
    const now = a.now();
    const withLast = (lastCompleteAt: number | undefined) =>
      offline(a, 0, now - MIN, {
        peerCanLead: true,
        ...(lastCompleteAt === undefined ? {} : { lastCompleteAt }),
      });
    // The literal 7 days, not the constant: the oracle does not come from the code under test.
    expect(holdsWith(a, withLast(now - 3 * DAY))).toBe(true);
    expect(holdsWith(a, withLast(now - 7 * DAY))).toBe(true);
    expect(holdsWith(a, withLast(now - 7 * DAY - 1))).toBe(false);
    expect(holdsWith(a, withLast(now - 30 * DAY))).toBe(false);
    // No known complete pull (nothing persisted): no grace at all.
    expect(holdsWith(a, withLast(undefined))).toBe(false);
    // A last complete pull from the future (a clock that went back) proves nothing.
    expect(holdsWith(a, withLast(now + MIN))).toBe(false);
  });

  it("this device is the only one that can lead: no limit", async () => {
    const { a } = await devices([0, 0, 0], { mode: "pinned" });
    a.sync();
    advance(a, 2 * config.publishDeadlineMs);
    const now = a.now();
    for (const last of [now - 7 * DAY - 1, now - 365 * DAY, undefined]) {
      const bound = { peerCanLead: false, ...(last === undefined ? {} : { lastCompleteAt: last }) };
      expect(holdsWith(a, offline(a, 0, now - MIN, bound)), String(last)).toBe(true);
    }
    // The bound never stretches recency: an old offline pass is refused either way.
    expect(
      holdsWith(a, offline(a, config.publishDeadlineMs + 1, now - DAY, { peerCanLead: false })),
    ).toBe(false);
  });
});

describe("D6: mode auto keeps the strict rule", () => {
  it("a settled holder whose pull went stale is refused even with an offline pass", async () => {
    const { a, b, c, remote } = await devices([0, 0, 0], {
      visibility: visibilityOf("bounded"),
      cfg: boundedConfig,
    });
    remote.flush();
    for (const d of [a, b, c]) d.sync();
    expect(decide(b, true, boundedConfig)).toBe("claim");
    b.push();
    advance(b, 10 * MIN);
    b.sync();
    expect(view(b).mode).toBe("auto");
    expect(holdsWith(b, b.local(), boundedConfig)).toBe(true);
    advance(b, 2 * boundedConfig.publishDeadlineMs);
    expect(holdsWith(b, b.local(), boundedConfig)).toBe(false);
    expect(holdsWith(b, offline(b), boundedConfig)).toBe(false);
  });
});
