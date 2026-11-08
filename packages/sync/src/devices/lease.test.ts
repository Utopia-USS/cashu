import { describe, expect, it } from "vitest";
import { type SegmentCursor, START_CURSOR } from "../carrier.js";
import {
  advance,
  config,
  decide,
  devices,
  holds,
  MIN,
  rule6Run,
  tick,
  view,
} from "../testing/devices/leaseSim.js";
import {
  createSimVault,
  newEid,
  optInAutoHandover,
  pairDevice,
  prepareConsented,
  prepareReviewedRevocation,
} from "../testing/devices/testkit.js";
import { buildLeaseClaim } from "./events.js";
import {
  catchUpMissing,
  foldLease,
  type LeaseView,
  leaseConfig,
  MAX_LEASE_TTL_MS,
  mayRunNewestDayImports,
  nextLeaseStep,
} from "./lease.js";
import { comparePositions } from "./positions.js";

/** The devices a holder still has to catch up with. */
function missing(v: LeaseView, applied: ReadonlyMap<string, SegmentCursor>): string[] {
  return catchUpMissing(v, applied).map((m) => m.device);
}

describe("fetch lease", () => {
  it("a claim holds only after it settled; others wait", async () => {
    const { a, b } = await devices();
    expect(tick(a)).toBe("claim");
    expect(holds(a)).toBe(false);
    expect(tick(b)).toBe("wait");
    for (let i = 0; i < 6; i++) {
      advance(a, MIN);
      expect(tick(a)).toBe("settle");
    }
    advance(a, 2 * MIN);
    a.sync();
    expect(holds(a)).toBe(true);
    expect(nextLeaseStep(view(a), a.local(), true, config).kind).toBe("hold");
  });

  it("renewals keep the lease with its holder for hours", async () => {
    const { a, b, c } = await devices();
    for (let minute = 0; minute < 2 * 60; minute += 5) {
      for (const d of [a, b, c]) tick(d);
      expect([a, b, c].filter(holds).length).toBeLessThanOrEqual(1);
      if (minute > 10) expect(holds(a)).toBe(true);
      advance(a, 5 * MIN);
    }
    expect(view(b).holder).toBe(a.id);
  });

  it("hands over when the leader is silent past expiry, and the new leader catches up first", async () => {
    const { a, b, c } = await devices();
    tick(a);
    advance(a, 10 * MIN);
    tick(a);
    expect(holds(a)).toBe(true);
    // C writes data A applies; A renews with that in its watermark, then goes silent.
    c.write([{ t: "note.added", v: 1, i: newEid(), d: {} }]);
    c.push();
    advance(a, 25 * MIN);
    expect(tick(a)).toBe("renew");
    const until = view(a).until;
    let handedOverAt: number | undefined;
    for (let t = 0; t < 120; t++) {
      advance(a, MIN);
      // B pulls everything except C's stream, so it is behind the watermark.
      b.push();
      b.pull((batch) => batch.device !== c.id);
      decide(b);
      b.push();
      expect([a, b].filter(holds).length).toBeLessThanOrEqual(1);
      if (holds(b) && handedOverAt === undefined) handedOverAt = b.now();
    }
    expect(handedOverAt).toBeDefined();
    expect(handedOverAt ?? 0).toBeGreaterThanOrEqual(until + config.maxSkewMs + config.settleMs);
    expect(holds(a)).toBe(false); // A's own clock says its lease ran out (until - skew)
    expect(view(b).catchUp[c.id]).toBeDefined();
    expect(missing(view(b), b.applied)).toEqual([c.id]);
    expect(mayRunNewestDayImports(view(b), b.local(), b.applied, config)).toBe(false);
    b.pull();
    expect(mayRunNewestDayImports(view(b), b.local(), b.applied, config)).toBe(true);
    // A wakes up and syncs: it sees B's term and never believes again.
    a.sync();
    expect(view(a).holder).toBe(b.id);
    expect(holds(a)).toBe(false);
  });

  it("concurrent claims: the first by (hlc, eid) wins on every device; only it holds after settling", async () => {
    const { a, b, c } = await devices();
    for (const d of [a, b]) d.sync();
    for (const d of [a, b]) expect(decide(d)).toBe("claim");
    for (const d of [a, b]) d.push();
    for (let i = 0; i < 8; i++) {
      advance(a, MIN);
      for (const d of [a, b, c]) tick(d);
      expect([a, b, c].filter(holds).length).toBeLessThanOrEqual(1);
    }
    expect(view(a).holder).toBe(view(b).holder);
    expect(view(c).holder).toBe(view(a).holder);
    expect([a, b].filter(holds)).toHaveLength(1);
    expect(view(a).ignored.map((i) => i.reason)).toContain("stale_prev");
  });

  it("release frees the lease at once; a revoked holder's lease is free at once", async () => {
    const { a, b, c } = await devices();
    tick(a);
    advance(a, 8 * MIN);
    tick(a);
    expect(holds(a)).toBe(true);
    expect(tick(a, false)).toBe("release");
    expect(tick(b)).toBe("claim");
    advance(a, 8 * MIN);
    tick(b);
    expect(holds(b)).toBe(true);
    // B is revoked by C: the lease is free for others immediately (no wait for expiry).
    const r = prepareConsented(c, [b]);
    if (!r.ok) throw new Error(r.reason);
    c.write(r.change.events);
    r.change.commit();
    c.push();
    a.sync();
    b.sync();
    expect(view(a).free).toBe(true);
    expect(holds(b)).toBe(false);
    expect(tick(a)).toBe("claim");
  });

  it("clock skew of 5 minutes (the bound): beliefs never overlap, handover still happens", async () => {
    // The claimer's clock runs the full bound ahead of the silent holder's.
    const { a, b, c } = await devices([0, 5 * MIN, 0]);
    let bHeld = false;
    for (let minute = 0; minute < 2 * 60; minute++) {
      const live = minute > 20 ? [b, c] : [a, b, c]; // A stops after taking the lease
      for (const d of live) tick(d);
      expect([a, b, c].filter(holds).length).toBeLessThanOrEqual(1);
      bHeld ||= holds(b) || holds(c);
      advance(a, MIN);
    }
    expect(bHeld).toBe(true);
  });

  it("clock skew beyond 5 minutes never makes beliefs overlap (a holder must have pulled within the deadline)", async () => {
    // A silent holder and a claimer whose clock runs 20 minutes ahead: the silent holder has not
    // pulled within the publish deadline, so it no longer acts, whatever its clock says (review M2).
    // A clock 2 days ahead: A3 below.
    const { a, b, c } = await devices([0, 20 * MIN, 0]);
    for (let minute = 0; minute < 2 * 60; minute++) {
      const live = minute > 20 ? [b, c] : [a, b, c];
      for (const d of live) tick(d);
      expect([a, b, c].filter(holds).length).toBeLessThanOrEqual(1);
      advance(a, MIN);
    }
    for (let i = 0; i < 2; i++) for (const d of [a, b, c]) d.sync();
    expect(new Set([a, b, c].map((d) => view(d).holder)).size).toBe(1);
    expect([a, b, c].filter(holds).length).toBeLessThanOrEqual(1);
  });

  // One schedule (a device whose clock runs 2 days ahead, 2 simulated hours); the sweep over every
  // schedule kind and backend is lease.rule6.exhaustive.test.ts.
  it("property (rule 6): never two leaders at once; all devices agree after convergence", async () => {
    const { held, fullVisibility } = await rule6Run(1, "linearizable", false, 2 * 60);
    expect(fullVisibility).toBe(true);
    expect(held).toBe(true);
  });

  it("A3: a holder pre-empted by a device whose clock runs 2 days ahead stops before the other acts; the fast device cannot block fetching for 2 days", async () => {
    const { a, b, c } = await devices();
    tick(a);
    advance(a, 8 * MIN);
    tick(a);
    expect(holds(a)).toBe(true);
    b.skewMs = 2 * 24 * 60 * MIN; // B's clock jumps 2 days ahead after pairing
    let bHeld = false;
    // A stops pulling (asleep, offline) while its own clock still says its term runs: B pre-empts.
    for (let minute = 0; minute < 30; minute++) {
      for (const d of [b, c]) tick(d);
      expect([a, b, c].filter(holds).length).toBeLessThanOrEqual(1);
      bHeld ||= holds(b);
      advance(a, MIN);
    }
    for (let minute = 0; minute < 5; minute++) {
      for (const d of [a, b, c]) tick(d);
      expect([a, b, c].filter(holds).length).toBeLessThanOrEqual(1);
      advance(a, MIN);
    }
    expect(bHeld).toBe(true); // B pre-empted A (its clock says A's term expired)
    expect(holds(a)).toBe(false);
    // B goes silent. C waits at most one term after it first saw B's last lease event, not 2 days.
    const lastB = view(c).term[view(c).term.length - 1];
    const seen = c.devices.firstSeen(lastB?.eid ?? "") ?? 0;
    let cHeldAt: number | undefined;
    for (let minute = 0; minute < 3 * 60 && cHeldAt === undefined; minute++) {
      for (const d of [a, c]) tick(d);
      expect([a, b, c].filter(holds).length).toBeLessThanOrEqual(1);
      if (holds(c) || holds(a)) cHeldAt = c.now();
      advance(a, MIN);
    }
    expect(cHeldAt).toBeDefined();
    expect((cHeldAt ?? 0) - seen).toBeLessThanOrEqual(
      config.ttlMs + config.maxSkewMs + config.settleMs + 3 * MIN,
    );
    // The chain continues through B's far-future events (prev links, not HLC order).
    for (const d of [a, b, c]) d.sync();
    expect(new Set([a, b, c].map((d) => view(d).head)).size).toBe(1);
    expect(view(a).holder).not.toBe(b.id);
  });

  it("A6: terms longer than 24 hours and lease events whose time disagrees with their own stamp are ignored", async () => {
    const { a, b } = await devices();
    a.write([
      buildLeaseClaim(a.identity, a.ring.vaultId, newEid(), {
        at: a.now(),
        until: Number.MAX_SAFE_INTEGER,
        watermark: {},
        prev: null,
      }),
    ]);
    a.write([
      buildLeaseClaim(a.identity, a.ring.vaultId, newEid(), {
        at: a.now() + 60 * MIN, // not what its own clock stamped
        until: a.now() + 2 * 60 * MIN,
        watermark: {},
        prev: null,
      }),
    ]);
    a.push();
    b.pull();
    expect(view(b).holder).toBeNull();
    expect(
      view(b)
        .ignored.map((i) => i.reason)
        .sort(),
    ).toEqual(["clock_mismatch", "term_too_long"]);
    expect(MAX_LEASE_TTL_MS).toBe(24 * 60 * MIN);
    expect(() => leaseConfig({ ttlMs: MAX_LEASE_TTL_MS + 1 })).toThrow(RangeError);
  });

  it("A4 / M3: catch-up is the highest watermark of every lease event in the chain, a revoked holder's stream included up to its cut", async () => {
    const vault = createSimVault();
    const a = vault.creator;
    const b = await pairDevice(a, "b");
    const c = await pairDevice(a, "c");
    const d = await pairDevice(a, "d");
    const all = [a, b, c, d];
    c.write([{ t: "note.added", v: 1, i: newEid(), d: {} }]); // everyone applies this one
    for (let i = 0; i < 2; i++) for (const x of all) x.sync();
    optInAutoHandover(a);
    for (let i = 0; i < 2; i++) for (const x of all) x.sync();
    vault.remote.time += 30 * MIN;
    // C writes; A applies it, holds and releases with C's cursor in its watermark.
    c.write([{ t: "note.added", v: 1, i: newEid(), d: {} }]);
    c.push();
    tick(a);
    advance(a, 8 * MIN);
    tick(a);
    expect(holds(a)).toBe(true);
    a.write([{ t: "import.done", v: 1, i: newEid(), d: {} }]); // A's newest-day import
    expect(tick(a, false)).toBe("release");
    const cCursor = c.cursors.get(c.id);
    // B and D never pull C's stream. B claims and releases; D claims next.
    const notC = (batch: { device: string }) => batch.device !== c.id;
    b.push();
    b.pull(notC);
    expect(decide(b)).toBe("claim");
    b.push();
    advance(a, 8 * MIN);
    b.pull(notC);
    expect(holds(b)).toBe(true);
    expect(decide(b, false)).toBe("release");
    b.push();
    d.pull(notC);
    expect(decide(d)).toBe("claim");
    d.push();
    advance(a, 8 * MIN);
    d.pull(notC);
    expect(holds(d)).toBe(true);
    expect(view(d).catchUp[c.id]).toEqual(cCursor);
    expect(missing(view(d), d.applied)).toContain(c.id);
    expect(mayRunNewestDayImports(view(d), d.local(), d.applied, config)).toBe(false);
    d.pull();
    expect(missing(view(d), d.applied)).toEqual([]);
    // A is revoked: its last import (in A's stream, named by A's own watermark) is still required,
    // up to the lower of the watermark and A's cut (C applied it before revoking A).
    c.pull();
    // A certified everyone, so revoking it needs the recovery words (they re-certify the others).
    const r = prepareReviewedRevocation(
      c,
      [{ device: a.id, cut: c.cursors.get(a.id) ?? START_CURSOR }],
      { revoke: newEid(), rotate: newEid(), recertify: newEid },
      vault.recovery,
      { recertify: [b.id, c.id, d.id] }, // the owner re-certifies every orphan it recognises
    );
    if (!r.ok) throw new Error(r.reason);
    c.write(r.change.events);
    r.change.commit();
    c.push();
    // A device whose store has not applied A's import yet (its data lags behind the statements)
    // must not run newest-day imports, although A is revoked now: A's stream is required up to the
    // lower of A's watermark and its cut (here the watermark: C applied the import before revoking).
    b.pull();
    expect(b.devices.registry.revoked.has(a.id)).toBe(true);
    const w = view(b).catchUp[a.id];
    const cut = b.devices.registry.revoked.get(a.id)?.cut;
    expect(w && cut && comparePositions(w, cut) <= 0).toBe(true);
    const lagging = new Map(b.applied);
    lagging.set(a.id, { seg: 1, offset: (w?.offset ?? 100) - 100 });
    expect(missing(view(b), lagging)).toContain(a.id);
    expect(missing(view(b), b.applied)).not.toContain(a.id);
  });

  it("rejects lease events that are forged, not signed by their writer, or stale", async () => {
    const { a, b } = await devices();
    tick(a);
    const events = a.stream.flatMap((s) => s.events);
    const pins = events.filter((e) => e.type === "lease.pinned");
    const lease = events.filter((e) => e.type === "lease.claimed");
    const forged = lease.map((e) => ({ ...e, eid: newEid(), writer: b.id }));
    const tampered = lease.map((e) => ({ ...e, data: { ...e.data, watermark: {} } }));
    const v = foldLease(a.devices.registry, [...pins, ...forged, ...tampered]);
    expect(v.mode).toBe("auto");
    expect(v.holder).toBeNull();
    expect(v.ignored.map((i) => i.reason).sort()).toEqual(["bad_signature", "writer_mismatch"]);
  });
});
