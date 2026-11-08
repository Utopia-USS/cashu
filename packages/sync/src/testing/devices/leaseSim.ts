// The lease simulation shared by lease.test.ts and the rule-6 sweep (lease.rule6.exhaustive.test.ts):
// three paired devices, a per-minute decide / push / pull loop and one seeded schedule per run.
// Test support only (synthetic data); production code never imports it.

import { expect } from "vitest";
import type { RecoveryIdentity } from "../../crypto/index.js";
import { buildLeasePin, type PinRequest, pinConfirmationText } from "../../devices/events.js";
import {
  foldLease,
  holdsLease,
  type LeaseConfig,
  type LeaseView,
  leaseConfig,
  leaseEventFor,
  nextLeaseStep,
  pinEventFor,
} from "../../devices/lease.js";
import {
  createSimVault,
  hlcAt,
  mulberry32,
  newEid,
  pairDevice,
  prepareReviewedRevocation,
  type SimDevice,
  SimRemote,
  type SimVisibility,
  START_CURSOR,
} from "./testkit.js";

export const MIN = 60_000;
export const config: LeaseConfig = leaseConfig({
  ttlMs: 60 * MIN,
  renewBeforeMs: 30 * MIN,
  maxSkewMs: 5 * MIN,
  publishDeadlineMs: MIN,
  settleMs: 7 * MIN,
});

/** Mode auto over a relay whose propagation bound is 2 minutes (settle covers it). */
export const boundedConfig: LeaseConfig = leaseConfig({
  ttlMs: 60 * MIN,
  renewBeforeMs: 30 * MIN,
  maxSkewMs: 5 * MIN,
  publishDeadlineMs: MIN,
  propagationMs: 2 * MIN,
  settleMs: 9 * MIN,
});

export function view(d: SimDevice): LeaseView {
  return d.devices.lease;
}

export function holds(d: SimDevice): boolean {
  return holdsLease(view(d), d.local(), config);
}

function writeOf(d: SimDevice) {
  return {
    identity: d.identity,
    vaultId: d.ring.vaultId,
    eid: newEid(),
    now: d.now(),
    applied: d.applied,
  };
}

/** One lease round on a device: decide, write the lease event if any. Returns the step kind. */
export function decide(d: SimDevice, eligible = true, cfg: LeaseConfig = config): string {
  const step = nextLeaseStep(view(d), d.local(), eligible, cfg);
  if (step.kind === "claim" || step.kind === "renew" || step.kind === "release") {
    d.write([leaseEventFor(step.kind, view(d), writeOf(d), cfg)]);
  }
  return step.kind;
}

/** The leader reports a completed fetch (it checked `holdsLease` right before). */
export function reportFetch(d: SimDevice): void {
  d.write([leaseEventFor("fetched", view(d), writeOf(d))]);
}

/**
 * An owner pin written by `d`: typed on `d` (the text the owner would type), or with the recovery
 * words when given.
 */
export function pin(
  d: SimDevice,
  mode: "pinned" | "auto",
  leader: SimDevice | null,
  options: { force?: boolean; recovery?: RecoveryIdentity; text?: string; cfg?: LeaseConfig } = {},
): void {
  const force = options.force ?? false;
  const id = leader?.id ?? null;
  const request: PinRequest = {
    mode,
    leader: id,
    force,
    confirmation: options.recovery
      ? { kind: "recovery", recovery: options.recovery }
      : { kind: "typed", text: options.text ?? pinConfirmationText(mode, id, force) },
  };
  d.write([pinEventFor(view(d), writeOf(d), request, d.local(), options.cfg ?? config)]);
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
export async function devices(
  skews: readonly number[] = [0, 0, 0],
  options: {
    mode?: "pinned" | "auto";
    visibility?: SimVisibility;
    seed?: number;
    cfg?: LeaseConfig;
  } = {},
) {
  const remote = new SimRemote({
    ...(options.visibility ? { visibility: options.visibility } : {}),
    seed: options.seed ?? 1,
  });
  const vault = createSimVault(remote);
  const a = vault.creator;
  const b = await pairDevice(a, "phone");
  const c = await pairDevice(a, "laptop");
  remote.flush(); // pairing happens with every device online
  for (let i = 0; i < 2; i++) for (const d of [a, b, c]) d.sync();
  // The owner opts into automatic handover on the creator (the pinned leader writes it itself;
  // over a synced folder only a device that also had a relay could, so the creator assumes one).
  if ((options.mode ?? "auto") === "auto") {
    a.assumeBounded = options.visibility?.kind === "eventual";
    pin(a, "auto", null, { ...(options.cfg ? { cfg: options.cfg } : {}) });
    a.assumeBounded = false;
    for (let i = 0; i < 2; i++) for (const d of [a, b, c]) d.sync();
  }
  remote.unflush();
  vault.remote.time += 30 * MIN;
  [a, b, c].forEach((d, i) => {
    d.skewMs = skews[i] ?? 0;
  });
  return { a, b, c, remote: vault.remote, recovery: vault.recovery };
}

export function advance(d: SimDevice, ms: number): void {
  d.remote.time += ms;
}

export type Backend = "linearizable" | "bounded" | "eventual";

/** The remote of a backend kind: a relay keeping a 2-minute bound, or a synced folder (no bound). */
export function visibilityOf(backend: Backend): SimVisibility {
  if (backend === "bounded") return { kind: "bounded", maxDelayMs: 2 * MIN };
  if (backend === "eventual") return { kind: "eventual", maxDelayMs: 30 * MIN, stallRate: 0.1 };
  return { kind: "linearizable" };
}

/**
 * One seeded schedule of the mode-auto rule-6 property: 300 simulated minutes of three devices going
 * on and offline, crashing before a push, pulling a lossy remote (kind 2) or running a clock 2 days
 * ahead (kind 1), over a linearizable remote, a relay keeping its declared bound, or a synced folder.
 * Asserts never two holders under full visibility and agreement after convergence; over an eventual
 * transport nobody ever holds. `control` makes every device BELIEVE its eventual transport is bounded
 * (what R4 forbids): the result reports whether two devices then held at once.
 */
export async function rule6Run(
  run: number,
  backend: Backend = "linearizable",
  control = false,
): Promise<{ held: boolean; fullVisibility: boolean; overlap: boolean }> {
  const DAY = 24 * 60 * MIN;
  const rand = mulberry32(run + 1);
  const cfg = backend === "bounded" ? boundedConfig : config;
  const holding = (d: SimDevice) => holdsLease(view(d), d.local(), cfg);
  // Kinds of run: clocks within the bound; one device 2 days ahead (after pairing, nothing
  // re-checks it); clocks an hour apart with a lossy remote (convergence only).
  const kind = run % 3;
  const skewSpan = kind === 2 ? 60 * MIN : 5 * MIN;
  const skews = [0, 1, 2].map(() => Math.round((rand() - 0.5) * skewSpan));
  if (kind === 1) skews[1 + (run % 2)] = 2 * DAY;
  const { a, b, c, remote } = await devices(run === 0 ? [0, 0, 0] : skews, {
    visibility: visibilityOf(backend),
    seed: run + 1,
    cfg,
  });
  const all = [a, b, c];
  if (control) for (const d of all) d.assumeBounded = true;
  const online = new Map(all.map((d) => [d, true]));
  const unpushed = new Set<SimDevice>();
  const fullVisibility = kind !== 2;
  let held = false;
  let overlap = false;
  for (let minute = 0; minute < 300; minute++) {
    for (const d of all) if (rand() < 0.05) online.set(d, !online.get(d));
    const live = all.filter((d) => online.get(d));
    for (const d of live) {
      if (!unpushed.has(d)) d.push();
      d.pull(fullVisibility ? undefined : () => rand() < 0.7);
    }
    for (const d of live) decide(d, d !== c || run % 3 !== 0, cfg);
    for (const d of live) {
      if (rand() < 0.03)
        unpushed.add(d); // crashed before pushing: published late
      else {
        unpushed.delete(d);
        d.push();
      }
    }
    const holders = all.filter(holding).length;
    overlap ||= holders > 1;
    if (backend === "eventual" && !control) expect(holders, `run ${run}`).toBe(0);
    else if (fullVisibility && !control) expect(holders, `run ${run}`).toBeLessThanOrEqual(1);
    held ||= holders > 0;
    advance(a, MIN);
  }
  remote.flush();
  for (let i = 0; i < 2; i++) for (const d of all) d.sync();
  const views = all.map(view);
  expect(new Set(views.map((v) => v.head)).size).toBe(1);
  expect(new Set(views.map((v) => v.holder)).size).toBe(1);
  if (!control) expect(all.filter(holding).length).toBeLessThanOrEqual(1);
  // The fold depends only on the set: a shuffled delivery gives the same view.
  const events = all.flatMap((d) => d.stream.flatMap((s) => s.events));
  const shuffled = [...events].sort(() => rand() - 0.5);
  const again = foldLease(a.devices.registry, shuffled);
  expect(again.head).toBe(views[0]?.head);
  expect(again.term).toEqual(views[0]?.term);
  return { held, fullVisibility, overlap };
}

/**
 * One seeded schedule of the mode-pinned rule-6 property (S29c R4): 300 simulated minutes of three
 * devices going on and offline over a synced folder (eventual: delays up to 30 min, some batches
 * held back until the end) or a bounded relay, while the owner re-pins the leader at random (typed
 * on a random device, or with the recovery words), with `force` in force runs. The leader reports
 * fetches; a pending leader acknowledges. Without force: never two holders, and a designated leader
 * whose hand-over is done holds at its next pull. With force, every overlap involves a holder that
 * has not seen a forced pin the other holder's chain contains.
 */
export async function pinnedRun(
  run: number,
  backend: Backend,
  withForce: boolean,
): Promise<{ moves: number; leaders: number; overlaps: number }> {
  const rand = mulberry32(7919 * (run + 1));
  const { a, b, c, recovery, remote } = await devices([0, 0, 0], {
    mode: "pinned",
    visibility: visibilityOf(backend),
    seed: run + 11,
  });
  const all = [a, b, c];
  const online = new Map(all.map((d) => [d, true]));
  const forced: string[] = [];
  const leaders = new Set<string>();
  let moves = 0;
  let overlaps = 0;
  for (let minute = 0; minute < 300; minute++) {
    for (const d of all) if (rand() < 0.04) online.set(d, !online.get(d));
    const live = all.filter((d) => online.get(d));
    for (const d of live) d.sync();
    for (const d of live) {
      const step = decide(d);
      if (step === "lead" && holds(d) && rand() < 0.1) reportFetch(d);
      if (step === "lead") {
        // A designated leader whose hand-over is done holds right after its pull (liveness).
        expect(holds(d), `run ${run} minute ${minute}`).toBe(true);
      }
    }
    if (live.length > 0 && rand() < 0.03) {
      const writer = live[Math.floor(rand() * live.length)] as SimDevice;
      const others = all.filter((d) => d.id !== view(writer).pinned);
      const target = others[Math.floor(rand() * others.length)] as SimDevice;
      const force = withForce && rand() < 0.5;
      pin(writer, "pinned", target, { force, ...(rand() < 0.3 ? { recovery } : {}) });
      if (force) forced.push(view(writer).head as string);
      moves += 1;
    }
    for (const d of live) d.push();
    const holding = all.filter(holds);
    for (const d of holding) leaders.add(d.id);
    if (holding.length > 1) {
      overlaps += 1;
      expect(withForce, `run ${run}: overlap without force`).toBe(true);
      // Some holder has not seen a forced pin another holder has.
      const explained = holding.some((x) =>
        holding.some(
          (y) =>
            y !== x &&
            forced.some(
              (f) => y.devices.firstSeen(f) !== undefined && x.devices.firstSeen(f) === undefined,
            ),
        ),
      );
      expect(explained, `run ${run} minute ${minute}`).toBe(true);
    }
    advance(a, MIN);
  }
  remote.flush();
  for (let i = 0; i < 3; i++) for (const d of all) d.sync();
  const views = all.map(view);
  expect(new Set(views.map((v) => v.head)).size).toBe(1);
  expect(new Set(views.map((v) => v.pinned)).size).toBe(1);
  expect(all.filter(holds).length).toBeLessThanOrEqual(1);
  return { moves, leaders: leaders.size, overlaps };
}

/**
 * One seeded schedule of the S1 property (sibling pins): the owner moves the leader from the
 * creator A to C; at a random minute B pins ITSELF on the same `prev`, stamped up to 10 minutes
 * earlier (a backdating device, or an offline tablet's pin arriving late). Devices sync at random
 * over a synced folder (seeded delays up to 30 minutes). Never two holders; afterwards everyone
 * agrees on the leader the old one acknowledged first.
 */
export async function siblingRun(
  run: number,
  /** S1b: right before the sibling, B retires the old leader A (after B saw A's acknowledgement). */
  retire = false,
): Promise<{ overlaps: number; acks: number; attacked: boolean }> {
  const rand = mulberry32(104_729 * (run + 1));
  const { a, b, c, remote, recovery } = await devices([0, 0, 0], {
    mode: "pinned",
    visibility: { kind: "eventual", maxDelayMs: 30 * MIN },
    seed: run + 101,
  });
  const all = [a, b, c];
  remote.flush();
  for (let i = 0; i < 2; i++) for (const d of all) d.sync();
  remote.unflush();
  const root = view(b).head as string;
  pin(b, "pinned", c);
  const wall = b.now() - 1 - Math.floor(rand() * 10 * MIN);
  const attackAt = 1 + Math.floor(rand() * 40);
  let overlaps = 0;
  let acks = 0;
  let attacked = false;
  for (let minute = 0; minute < 150; minute++) {
    const handedOver = view(b).pinned === c.id && view(b).pendingFrom === null;
    if (!attacked && minute >= attackAt && (!retire || handedOver)) {
      attacked = true;
      if (retire) {
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
      }
      const text = pinConfirmationText("pinned", b.id, false);
      b.write(
        [
          buildLeasePin(
            b.identity,
            b.ring.vaultId,
            newEid(),
            { at: wall, watermark: {}, prev: root },
            { mode: "pinned", leader: b.id, force: false, confirmation: { kind: "typed", text } },
          ),
        ],
        { hlc: () => hlcAt(b.id, wall) },
      );
    }
    for (const d of all) {
      if (rand() < 0.5) d.sync();
      else d.pull(() => false); // awake, but sees nothing new this minute
      if (decide(d) === "release") acks += 1;
      d.push();
    }
    const holding = all.filter(holds).length;
    if (holding > 1) overlaps += 1;
    expect(holding, `run ${run} minute ${minute}`).toBeLessThanOrEqual(1);
    advance(a, MIN);
  }
  remote.flush();
  for (let i = 0; i < 3; i++) for (const d of all) d.sync();
  expect(new Set(all.map((d) => view(d).pinned)).size).toBe(1);
  return { overlaps, acks, attacked };
}
