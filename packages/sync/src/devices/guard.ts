// Frame enforcement for the carrier (crypto README "S28b": revocation stops reading, not writing;
// the carrier must reject a revoked device's frames). The carrier's codec, per frame:
//
//   const verdict = guard.check(at, ring.get(frameKeyId(frame)));   // before applying its data
//   const plain = openFrame(sodium, ring, frame, ctx, guard.policy(at));
//   guard.record(at, entry);                                        // after its data was applied
//
// and, separately, opens EVERY frame whose key it holds to pass its `device.*` / `lease.*` events to
// `VaultDevices.ingest`, also frames whose data the guard rejects: the registry judges statements by
// their own signatures and stream positions, and it must see all of them to reach the same result on
// every device whatever the delivery order (review B1). Data rules, checked before decryption:
//
// 1. Revocation cut: data of a revoked device ending after its cut (positions.ts `beforeCut`) is
//    rejected, whatever key it uses.
// 2. Per-writer key floor: an honest writer always seals with its active key, which only moves up
//    in (epoch, generation) order, so a frame whose key is below one the same writer already used at
//    an earlier position is rejected. Once a writer wrote at the post-revocation key, a revoked
//    device can no longer forge that writer's frames with an old key.
// 3. Unregistered or untrusted writer ids: their frames must use a key at least as new as the latest
//    revocation (epoch >= revocation count), which no revoked device holds, so a revoked device
//    cannot write under a fresh id either. An honest device whose `device.added` has not arrived
//    yet is retried by the engine on the next pass.
// The remaining window (a revoked device forging a trusted writer's frames at positions that writer
// has not reached, before it writes at the new key) closes with per-device frame signatures (S28d).
//
// Verdicts depend on the registry, which changes as statements arrive. After every registry change
// the store calls `recheck()`: it re-validates every recorded frame against the current registry
// (from scratch, per writer in stream order) and returns, per writer, the position after which data
// is no longer accepted; the store drops that data and re-applies from there (a rejected frame
// blocks its writer's stream until a later registry accepts it). The accepted data of a writer is
// therefore always the longest prefix of its stream that passes the rules under the current
// registry: a function of the log, the same on every device.

import type { SegmentCursor } from "../carrier.js";
import type { FramePolicy } from "../crypto/index.js";
import { beforeCut, comparePositions } from "./positions.js";
import type { Registry } from "./registry.js";

/** Where a frame sits in its writer's stream: its start (frame AAD offset) and the cursor after it. */
export interface FrameAt {
  readonly device: string;
  readonly start: SegmentCursor;
  readonly end: SegmentCursor;
}

export interface KeyOrder {
  readonly epoch: number;
  readonly generation: number;
}

export type FrameRejectionReason = "revoked_writer" | "below_floor" | "stale_epoch";

export type FrameVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: FrameRejectionReason };

/** Data of `device` ending after `after` is no longer accepted: drop it and re-apply from there. */
export interface FrameRejection {
  readonly device: string;
  readonly after: SegmentCursor;
  readonly reason: FrameRejectionReason;
}

/** Consecutive accepted frames of one writer under one key. */
interface Run extends KeyOrder {
  readonly start: SegmentCursor;
  end: SegmentCursor;
}

function compareKeys(a: KeyOrder, b: KeyOrder): number {
  return a.epoch - b.epoch || a.generation - b.generation;
}

function judge(
  registry: Registry,
  device: string,
  end: SegmentCursor,
  key: KeyOrder,
  floor: KeyOrder | undefined,
): FrameVerdict {
  const revocation = registry.revoked.get(device);
  if (revocation && !beforeCut(end, revocation.cut)) return { ok: false, reason: "revoked_writer" };
  if (!revocation && !registry.isTrusted(device) && key.epoch < registry.revocationCount) {
    return { ok: false, reason: "stale_epoch" };
  }
  if (floor && compareKeys(key, floor) < 0) return { ok: false, reason: "below_floor" };
  return { ok: true };
}

export class FrameGuard {
  readonly #registry: () => Registry;
  readonly #runs = new Map<string, Run[]>();

  /** `registry` returns the current registry (it changes as registry events are applied). */
  constructor(registry: () => Registry) {
    this.#registry = registry;
  }

  check(at: FrameAt, key: KeyOrder): FrameVerdict {
    return judge(this.#registry(), at.device, at.end, key, this.#floorBefore(at));
  }

  /** The policy for crypto `openFrame` (data) at this position. */
  policy(at: FrameAt): FramePolicy {
    return { acceptKid: (entry) => this.check(at, entry).ok };
  }

  /** Call after the data of a frame at `at`, opened with a key of this order, was applied. */
  record(at: FrameAt, key: KeyOrder): void {
    const runs = this.#runs.get(at.device) ?? [];
    const last = runs[runs.length - 1];
    if (last && comparePositions(at.end, last.end) <= 0) return; // re-opened, already recorded
    if (last && compareKeys(last, key) === 0 && comparePositions(at.start, last.end) <= 0) {
      last.end = at.end;
    } else {
      runs.push({ start: at.start, end: at.end, epoch: key.epoch, generation: key.generation });
    }
    this.#runs.set(at.device, runs);
  }

  /**
   * Re-validates every recorded frame against the current registry. Returns, sorted by device, the
   * writers whose accepted data shrank and the position after which it is no longer accepted; the
   * guard forgets those frames (the store drops their data and re-applies from `after`).
   */
  recheck(): FrameRejection[] {
    const registry = this.#registry();
    const out: FrameRejection[] = [];
    for (const device of [...this.#runs.keys()].sort()) {
      const runs = this.#runs.get(device) ?? [];
      const kept: Run[] = [];
      let floor: KeyOrder | undefined;
      let rejection: FrameRejection | undefined;
      for (const run of runs) {
        const whole = judge(registry, device, run.end, run, floor);
        if (whole.ok) {
          kept.push(run);
          if (!floor || compareKeys(run, floor) > 0) floor = run;
          continue;
        }
        const revocation = registry.revoked.get(device);
        if (whole.reason === "revoked_writer" && revocation) {
          const first = judge(registry, device, run.start, run, floor);
          if (first.ok && comparePositions(run.start, revocation.cut) < 0) {
            kept.push({ ...run, end: revocation.cut });
          }
          rejection = { device, after: revocation.cut, reason: "revoked_writer" };
        } else {
          rejection = { device, after: run.start, reason: whole.reason };
        }
        break;
      }
      if (rejection) out.push(rejection);
      if (kept.length > 0) this.#runs.set(device, kept);
      else this.#runs.delete(device);
    }
    return out;
  }

  /** Forget every recorded frame (before a rebuild replays the log). */
  reset(): void {
    this.#runs.clear();
  }

  #floorBefore(at: FrameAt): KeyOrder | undefined {
    let floor: KeyOrder | undefined;
    for (const run of this.#runs.get(at.device) ?? []) {
      if (comparePositions(run.start, at.start) >= 0) break;
      if (!floor || compareKeys(run, floor) > 0) floor = run;
    }
    return floor;
  }
}

/**
 * Devices whose revocation cut lies before what this device already applied of their stream: the
 * view holds events the log no longer accepts, so the store must rebuild (with the guard reset).
 */
export function devicesNeedingRebuild(
  registry: Registry,
  applied: ReadonlyMap<string, SegmentCursor>,
): string[] {
  const out: string[] = [];
  for (const [device, revocation] of registry.revoked) {
    const cursor = applied.get(device);
    if (cursor && !beforeCut(cursor, revocation.cut)) out.push(device);
  }
  return out.sort();
}
