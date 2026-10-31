// Frame enforcement for the carrier (crypto README "S28b": revocation stops reading, not writing;
// the carrier must reject a revoked device's frames). The carrier's codec calls, per frame:
//
//   const policy = guard.policy(at);                 // before decrypting
//   const plain = openFrame(sodium, ring, frame, ctx, policy);
//   guard.record(at, ring.get(frameKeyId(frame)));   // after it opened
//
// Rules, checked before decryption (`key_not_allowed`):
// 1. Revocation cut: a revoked device's frames at or after its cut (its revocation point in its own
//    stream) are rejected, whatever key they use.
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
// The floor is position aware (a staircase per writer) because the engine opens a frame more than
// once (verify on pull, then apply). After a rebuild, call `reset()`.

import type { SegmentCursor } from "../carrier.js";
import type { FramePolicy } from "../crypto/index.js";
import { comparePositions } from "./events.js";
import type { Registry } from "./registry.js";

export interface FrameAt {
  readonly device: string;
  readonly seg: number;
  readonly offset: number;
}

export interface KeyOrder {
  readonly epoch: number;
  readonly generation: number;
}

export type FrameVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "revoked_writer" | "below_floor" | "stale_epoch" };

interface Stair extends KeyOrder {
  readonly seg: number;
  readonly offset: number;
}

function compareKeys(a: KeyOrder, b: KeyOrder): number {
  return a.epoch - b.epoch || a.generation - b.generation;
}

export class FrameGuard {
  readonly #registry: () => Registry;
  readonly #floors = new Map<string, Stair[]>();

  /** `registry` returns the current registry (it changes as registry events are applied). */
  constructor(registry: () => Registry) {
    this.#registry = registry;
  }

  check(at: FrameAt, key: KeyOrder): FrameVerdict {
    const registry = this.#registry();
    const revocation = registry.revoked.get(at.device);
    if (revocation && comparePositions(at, revocation.cut) >= 0) {
      return { ok: false, reason: "revoked_writer" };
    }
    if (!revocation && !registry.isTrusted(at.device) && key.epoch < registry.revocationCount) {
      return { ok: false, reason: "stale_epoch" };
    }
    const floor = this.#floorAt(at);
    if (floor && compareKeys(key, floor) < 0) return { ok: false, reason: "below_floor" };
    return { ok: true };
  }

  /** The policy for crypto `openFrame` at this position. */
  policy(at: FrameAt): FramePolicy {
    return { acceptKid: (entry) => this.check(at, entry).ok };
  }

  /** Call after a frame at `at` opened with a key of this order. */
  record(at: FrameAt, key: KeyOrder): void {
    const stairs = this.#floors.get(at.device) ?? [];
    const floor = this.#floorAt(at);
    if (floor && compareKeys(key, floor) <= 0) return;
    const stair: Stair = {
      seg: at.seg,
      offset: at.offset,
      epoch: key.epoch,
      generation: key.generation,
    };
    const kept = stairs.filter((s) => comparePositions(s, at) < 0 || compareKeys(s, key) > 0);
    kept.push(stair);
    kept.sort(comparePositions);
    this.#floors.set(at.device, kept);
  }

  /** Forget every floor (before a rebuild replays the log). */
  reset(): void {
    this.#floors.clear();
  }

  #floorAt(at: FrameAt): KeyOrder | undefined {
    let floor: KeyOrder | undefined;
    for (const s of this.#floors.get(at.device) ?? []) {
      if (comparePositions(s, at) >= 0) break;
      if (!floor || compareKeys(s, floor) > 0) floor = s;
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
    if (cursor && comparePositions(cursor, revocation.cut) > 0) out.push(device);
  }
  return out.sort();
}
