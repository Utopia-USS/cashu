// S29c R4 liveness (lead decision): every device warns the owner when the pinned fetch leader has
// not fetched for more than 36 hours, with the re-pin action (D4). Time is the simulation's injected
// clock (SimDevice.now), never the wall clock.

import { describe, expect, it } from "vitest";
import { buildLeaseFetched } from "./events.js";
import { devices, pin, reportFetch, view } from "./leaseSim.js";
import { LEADER_SILENCE_WARNING_MS, leaderLiveness } from "./liveness.js";
import { newEid, prepareReviewedRevocation, type SimDevice, START_CURSOR } from "./testkit.js";

const HOUR = 60 * 60 * 1000;

function syncAll(all: readonly SimDevice[]): void {
  for (let i = 0; i < 2; i++) for (const d of all) d.sync();
}

function liveness(d: SimDevice) {
  return leaderLiveness(view(d), d.devices.registry, {
    now: d.now(),
    firstSeen: (eid) => d.devices.firstSeen(eid),
  });
}

async function pinnedVault() {
  const vault = await devices([0, 0, 0], { mode: "pinned" });
  syncAll([vault.a, vault.b, vault.c]);
  return vault;
}

describe("liveness of the pinned fetch leader", () => {
  it("warns on every device once the leader has not fetched for more than 36 hours", async () => {
    const { a, b, c, remote } = await pinnedVault();
    a.sync();
    reportFetch(a);
    syncAll([a, b, c]);
    const fetched = view(b).lastFetch?.eid;
    expect(liveness(b)).toMatchObject({
      state: "ok",
      leader: a.id,
      since: { eid: fetched, kind: "fetched" },
      silentForMs: 0,
      warn: false,
    });
    remote.time += LEADER_SILENCE_WARNING_MS; // exactly 36 h: not yet
    for (const d of [a, b, c]) expect(liveness(d).warn, d.name).toBe(false);
    remote.time += 1;
    for (const d of [b, c]) {
      expect(liveness(d), d.name).toMatchObject({
        state: "silent",
        warn: true,
        silentForMs: LEADER_SILENCE_WARNING_MS + 1,
        repin: { candidates: [b.id, c.id].sort(), force: true, mayStillRun: a.id },
      });
    }
    // A new fetch report clears it.
    a.sync();
    reportFetch(a);
    syncAll([a, b, c]);
    for (const d of [a, b, c]) expect(liveness(d).state, d.name).toBe("ok");
  });

  it("measures from the pin until the leader's first fetch, and restarts at a re-pin", async () => {
    const { a, b, c, remote } = await pinnedVault();
    expect(liveness(b).since?.kind).toBe("pinned");
    remote.time += 37 * HOUR;
    expect(liveness(b).state).toBe("silent");
    pin(b, "pinned", c, { force: true }); // the owner acts on the warning
    syncAll([a, b, c]);
    expect(liveness(a)).toMatchObject({ state: "ok", leader: c.id, since: { kind: "pinned" } });
  });

  it("a leader whose clock runs ahead cannot look fresh: the time it was first seen bounds its report", async () => {
    const { a, b, c, remote } = await pinnedVault();
    a.skewMs = 2 * 24 * HOUR;
    a.sync();
    const eid = newEid();
    // The report is stamped (HLC and `at`) two days ahead; B first sees it now.
    a.write([
      buildLeaseFetched(a.identity, a.ring.vaultId, eid, {
        at: a.now(),
        watermark: {},
        prev: view(a).head as string,
      }),
    ]);
    syncAll([a, b, c]);
    expect(view(b).lastFetch?.eid).toBe(eid);
    expect(liveness(b).lastActivityAt).toBe(b.now());
    remote.time += 36 * HOUR + 1;
    expect(liveness(b).warn).toBe(true);
  });

  it("a hand-over stuck for more than 36 hours offers a forced re-pin naming the old leader", async () => {
    const { a, b, c, remote } = await pinnedVault();
    pin(b, "pinned", c); // A never acknowledges (it is gone)
    syncAll([b, c]);
    expect(liveness(c)).toMatchObject({
      state: "handover_pending",
      pendingFrom: a.id,
      warn: false,
    });
    remote.time += 36 * HOUR + 1;
    expect(liveness(c)).toMatchObject({
      state: "handover_pending",
      warn: true,
      repin: { force: true, mayStillRun: a.id },
    });
  });

  it("a revoked leader leaves the vault leaderless: warn at once, no force needed", async () => {
    const { a, b, c, recovery } = await pinnedVault();
    // A certified everyone, so revoking it takes the words, which re-certify the others.
    const r = prepareReviewedRevocation(
      b,
      [{ device: a.id, cut: b.cursors.get(a.id) ?? START_CURSOR }],
      { revoke: newEid(), rotate: newEid(), recertify: newEid },
      recovery,
      { recertify: [b.id, c.id] },
    );
    if (!r.ok) throw new Error(r.reason);
    b.write(r.change.events);
    r.change.commit();
    syncAll([b, c]);
    expect(liveness(c)).toMatchObject({
      state: "leaderless",
      warn: true,
      repin: { candidates: [b.id, c.id].sort(), force: false, mayStillRun: null },
    });
  });

  it("mode auto has no pinned leader to watch", async () => {
    const { b } = await devices();
    expect(liveness(b)).toMatchObject({ mode: "auto", state: "auto", warn: false, repin: null });
  });
});
