// The lease simulation shared by lease.test.ts and the rule-6 sweep (lease.rule6.exhaustive.test.ts):
// three paired devices, a per-minute decide / push / pull loop and one seeded schedule per run.
// Test support only (synthetic data); production code never imports it.

import { expect } from "vitest";
import {
  foldLease,
  holdsLease,
  type LeaseConfig,
  type LeaseView,
  leaseConfig,
  leaseEventFor,
  nextLeaseStep,
} from "./lease.js";
import { createSimVault, mulberry32, newEid, pairDevice, type SimDevice } from "./testkit.js";

export const MIN = 60_000;
export const config: LeaseConfig = leaseConfig({
  ttlMs: 60 * MIN,
  renewBeforeMs: 30 * MIN,
  maxSkewMs: 5 * MIN,
  publishDeadlineMs: MIN,
  settleMs: 7 * MIN,
});

export function view(d: SimDevice): LeaseView {
  return d.devices.lease;
}

export function holds(d: SimDevice): boolean {
  return holdsLease(view(d), d.local(), config);
}

/** One lease round on a device: decide, write the lease event if any. Returns the step kind. */
export function decide(d: SimDevice, eligible = true): string {
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
export function tick(d: SimDevice, eligible = true): string {
  d.sync();
  const kind = decide(d, eligible);
  d.push();
  return kind;
}

/**
 * Three paired devices. Pairing refuses more than 5 minutes of skew, so the clocks drift apart only
 * afterwards: half an hour later, each clock moves by its skew (never behind its own last stamp).
 */
export async function devices(skews: readonly number[] = [0, 0, 0]) {
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

export function advance(d: SimDevice, ms: number): void {
  d.remote.time += ms;
}

/**
 * One seeded schedule of the rule-6 property: 300 simulated minutes of three devices going on and
 * offline, crashing before a push, pulling a lossy remote (kind 2) or running a clock 2 days ahead
 * (kind 1). Asserts never two holders under full visibility and agreement after convergence;
 * returns whether someone held (the schedules must really exercise the lease).
 */
export async function rule6Run(run: number): Promise<{ held: boolean; fullVisibility: boolean }> {
  const DAY = 24 * 60 * MIN;
  const rand = mulberry32(run + 1);
  // Kinds of run: clocks within the bound; one device 2 days ahead (after pairing, nothing
  // re-checks it); clocks an hour apart with a lossy remote (convergence only).
  const kind = run % 3;
  const skewSpan = kind === 2 ? 60 * MIN : 5 * MIN;
  const skews = [0, 1, 2].map(() => Math.round((rand() - 0.5) * skewSpan));
  if (kind === 1) skews[1 + (run % 2)] = 2 * DAY;
  const { a, b, c } = await devices(run === 0 ? [0, 0, 0] : skews);
  const all = [a, b, c];
  const online = new Map(all.map((d) => [d, true]));
  const unpushed = new Set<SimDevice>();
  const fullVisibility = kind !== 2;
  let held = false;
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
    if (fullVisibility) expect(all.filter(holds).length, `run ${run}`).toBeLessThanOrEqual(1);
    held ||= all.some(holds);
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
  return { held, fullVisibility };
}
