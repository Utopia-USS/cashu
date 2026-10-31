import { describe, expect, it } from "vitest";
import { START_CURSOR } from "../carrier.js";
import {
  catchUpMissing,
  foldLease,
  holdsLease,
  type LeaseConfig,
  type LeaseView,
  leaseConfig,
  leaseEventFor,
  mayRunNewestDayImports,
  nextLeaseStep,
} from "./lease.js";
import { createSimVault, newEid, pairDevice, type SimDevice, sodium } from "./testkit.js";

const MIN = 60_000;
const config: LeaseConfig = leaseConfig({
  ttlMs: 60 * MIN,
  renewBeforeMs: 30 * MIN,
  maxSkewMs: 5 * MIN,
  publishDeadlineMs: MIN,
  settleMs: 7 * MIN,
});

function view(d: SimDevice): LeaseView {
  return d.devices.lease;
}

function holds(d: SimDevice): boolean {
  return holdsLease(view(d), d.local(), config);
}

/** One lease round on a device: decide, write the lease event if any. Returns the step kind. */
function decide(d: SimDevice, eligible = true): string {
  const step = nextLeaseStep(view(d), d.local(), eligible, config);
  if (step.kind === "claim" || step.kind === "renew" || step.kind === "release") {
    d.write([
      leaseEventFor(
        step.kind,
        view(d),
        {
          identity: d.identity,
          vaultId: d.ring.vaultId,
          eid: newEid(),
          now: d.now(),
          applied: d.applied,
        },
        config,
      ),
    ]);
  }
  return step.kind;
}

/** sync, decide, push: what an online device does each minute. */
function tick(d: SimDevice, eligible = true): string {
  d.sync();
  const kind = decide(d, eligible);
  d.push();
  return kind;
}

/**
 * Three paired devices. Pairing refuses more than 5 minutes of skew, so the clocks drift apart only
 * afterwards: half an hour later, each clock moves by its skew (never behind its own last stamp).
 */
async function devices(skews: readonly number[] = [0, 0, 0]) {
  const vault = createSimVault();
  const a = vault.creator;
  const b = await pairDevice(a, "phone");
  const c = await pairDevice(a, "laptop");
  for (let i = 0; i < 2; i++) for (const d of [a, b, c]) d.sync();
  vault.remote.time += 30 * MIN;
  [a, b, c].forEach((d, i) => {
    d.skewMs = skews[i] ?? 0;
  });
  return { a, b, c, remote: vault.remote };
}

function advance(d: SimDevice, ms: number): void {
  d.remote.time += ms;
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
    for (let minute = 0; minute < 6 * 60; minute += 5) {
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
    expect(catchUpMissing(view(b), b.applied, b.devices.registry)).toEqual([c.id]);
    expect(mayRunNewestDayImports(view(b), b.local(), b.applied, b.devices.registry, config)).toBe(
      false,
    );
    b.pull();
    expect(mayRunNewestDayImports(view(b), b.local(), b.applied, b.devices.registry, config)).toBe(
      true,
    );
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
    const r = c.devices.prepareRevocation(
      [{ device: b.id, cut: c.cursors.get(b.id) ?? START_CURSOR }],
      {
        revoke: newEid(),
        rotate: newEid(),
      },
    );
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

  it("clock skew within 5 minutes: beliefs never overlap, handover still happens", async () => {
    for (const skews of [
      [2.5 * MIN, -2.5 * MIN, 0],
      [-2.5 * MIN, 2.5 * MIN, 0],
      [0, 5 * MIN, 0],
    ]) {
      const { a, b, c } = await devices(skews);
      let bHeld = false;
      for (let minute = 0; minute < 4 * 60; minute++) {
        const silent = minute > 20; // A stops after taking the lease
        for (const d of silent ? [b, c] : [a, b, c]) d.sync();
        for (const d of silent ? [b, c] : [a, b, c]) decide(d);
        for (const d of silent ? [b, c] : [a, b, c]) d.push();
        expect([a, b, c].filter(holds).length).toBeLessThanOrEqual(1);
        bHeld ||= holds(b) || holds(c);
        advance(a, MIN);
      }
      expect(bHeld).toBe(true);
    }
  });

  it("clock skew beyond 5 minutes: margins absorb up to 2 skew + settle, beyond that beliefs overlap until the next pull, never after convergence", async () => {
    // A silent holder and a claimer whose clock runs ahead: the holder stops believing at until - 5,
    // the claimer claims at its until + 5 and believes 7 minutes later, so up to 17 minutes of skew
    // never overlap; more can, until the holder pulls (pairing refuses more than 5 minutes).
    for (const [skew, overlapExpected] of [
      [15 * MIN, false],
      [20 * MIN, true],
    ] as const) {
      const { a, b, c } = await devices([0, skew, 0]);
      let overlap = false;
      for (let minute = 0; minute < 3 * 60; minute++) {
        const silent = minute > 20;
        for (const d of silent ? [b, c] : [a, b, c]) tick(d);
        overlap ||= [a, b, c].filter(holds).length > 1;
        advance(a, MIN);
      }
      expect(overlap).toBe(overlapExpected);
      for (let i = 0; i < 2; i++) for (const d of [a, b, c]) d.sync();
      const holders = new Set([a, b, c].map((d) => view(d).holder));
      expect(holders.size).toBe(1);
      expect([a, b, c].filter(holds).length).toBeLessThanOrEqual(1);
    }
  });

  it("property: after convergence all devices agree and at most one holds, over random schedules", async () => {
    const base = await devices();
    const runs = 60;
    for (let run = 0; run < runs; run++) {
      const rand = mulberry32(run + 1);
      // Fresh clocks and streams on the same paired devices: clone the vault per run cheaply by
      // re-pairing would be slow, so each run uses new devices.
      const skewSpan = run % 2 === 0 ? 5 * MIN : 60 * MIN; // within and far beyond the bound
      const skews = [0, 1, 2].map(() => Math.round((rand() - 0.5) * skewSpan));
      const { a, b, c } = run === 0 ? base : await devices(skews);
      const all = [a, b, c];
      const online = new Map(all.map((d) => [d, true]));
      const unpushed = new Set<SimDevice>();
      const fullVisibility = skewSpan <= 5 * MIN;
      for (let minute = 0; minute < 300; minute++) {
        for (const d of all) if (rand() < 0.05) online.set(d, !online.get(d));
        const live = all.filter((d) => online.get(d));
        for (const d of live) {
          if (!unpushed.has(d)) d.push();
          d.pull(fullVisibility ? undefined : () => rand() < 0.7);
        }
        for (const d of live) decide(d, d !== c || run % 3 !== 0);
        for (const d of live) {
          if (rand() < 0.03)
            unpushed.add(d); // crashed before pushing: published late
          else {
            unpushed.delete(d);
            d.push();
          }
        }
        if (fullVisibility) expect(all.filter(holds).length).toBeLessThanOrEqual(1);
        advance(a, MIN);
      }
      for (let i = 0; i < 2; i++) for (const d of all) d.sync();
      const views = all.map(view);
      expect(new Set(views.map((v) => v.head)).size).toBe(1);
      expect(new Set(views.map((v) => v.holder)).size).toBe(1);
      expect(all.filter(holds).length).toBeLessThanOrEqual(1);
      // The fold depends only on the set: a shuffled delivery gives the same view.
      const events = all.flatMap((d) => d.stream.flatMap((s) => s.events));
      const shuffled = [...events].sort(() => rand() - 0.5);
      const again = foldLease(a.devices.registry, shuffled);
      expect(again.head).toBe(views[0]?.head);
      expect(again.term).toEqual(views[0]?.term);
    }
  }, 120_000);

  it("rejects lease events that are forged, not signed by their writer, or stale", async () => {
    const { a, b } = await devices();
    tick(a);
    const claim = view(a).term[0];
    const events = a.stream.flatMap((s) => s.events);
    const lease = events.filter((e) => e.type === "lease.claimed");
    const forged = lease.map((e) => ({ ...e, eid: newEid(), writer: b.id }));
    const tampered = lease.map((e) => ({ ...e, data: { ...e.data, until: 1 } }));
    const v = foldLease(a.devices.registry, [...forged, ...tampered]);
    expect(v.holder).toBeNull();
    expect(v.ignored.map((i) => i.reason).sort()).toEqual(["bad_signature", "writer_mismatch"]);
    expect(claim).toBeDefined();
    expect(sodium).toBeDefined();
  });
});

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
