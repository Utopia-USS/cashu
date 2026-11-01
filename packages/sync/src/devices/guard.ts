// Data enforcement for verified frames (crypto README "S28b": revocation stops reading, not writing).
// Since S29c phase B2 every frame carries its writer's signed head, checked by the gate (gate.ts)
// before anything here: a revoked device can no longer forge another writer's frames, under any
// key epoch, so the per-writer key floors of S28b are gone (lead decision D6). What remains are the
// two rules that depend on what the log says about the WRITER:
//
// 1. Revocation cut: data of a revoked device ending after its cut (positions.ts `beforeCut`) is
//    rejected.
// 2. Fork freeze: data of a device whose stream is proven forked (heads.ts) ending after the agreed
//    prefix is rejected.
//
// The gate opens and verifies EVERY frame and passes its `device.*` / `lease.*` events to
// `VaultDevices.ingest`, also frames whose data is rejected here: the registry judges statements by
// their own signatures and stream positions, and must see all of them to reach the same result on
// every device whatever the delivery order (review B1).
//
// Verdicts depend on the registry and the freezes, which change as statements arrive. After every
// change `recheck()` reports, per writer, the position after which accepted data is no longer
// accepted; the engine then rebuilds the view (lead decision D8). The accepted data of a writer is
// therefore always the longest prefix of its verified stream that passes both rules under the
// current state: a function of the log, the same on every device.

import type { SegmentCursor } from "../carrier.js";
import { beforeCut, comparePositions } from "./positions.js";
import type { Registry } from "./registry.js";

/** Where a frame of `device` ends (the cursor after it). */
export interface FrameAt {
  readonly device: string;
  readonly end: SegmentCursor;
}

export type FrameRejectionReason = "revoked_writer" | "forked";

export type FrameVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: FrameRejectionReason };

/** Data of `device` ending after `after` is no longer accepted. */
export interface FrameRejection {
  readonly device: string;
  readonly after: SegmentCursor;
  readonly reason: FrameRejectionReason;
}

export class FrameGuard {
  readonly #registry: () => Registry;
  readonly #frozen: () => ReadonlyMap<string, SegmentCursor>;
  /** Per writer, the end of the accepted data recorded so far. */
  readonly #applied = new Map<string, SegmentCursor>();

  /** `registry` and `frozen` return the current state (they change as statements arrive). */
  constructor(
    registry: () => Registry,
    frozen: () => ReadonlyMap<string, SegmentCursor> = () => new Map(),
  ) {
    this.#registry = registry;
    this.#frozen = frozen;
  }

  /** The position after which `device`'s data is not accepted, and why (undefined: none). */
  limit(
    device: string,
  ): { readonly after: SegmentCursor; readonly reason: FrameRejectionReason } | undefined {
    const cut = this.#registry().revoked.get(device)?.cut;
    const freeze = this.#frozen().get(device);
    if (freeze && (!cut || comparePositions(freeze, cut) < 0)) {
      return { after: freeze, reason: "forked" };
    }
    return cut ? { after: cut, reason: "revoked_writer" } : undefined;
  }

  check(at: FrameAt): FrameVerdict {
    const limit = this.limit(at.device);
    if (limit && !beforeCut(at.end, limit.after)) return { ok: false, reason: limit.reason };
    return { ok: true };
  }

  /** Call after the data of a frame was applied. */
  record(at: FrameAt): void {
    const known = this.#applied.get(at.device);
    if (!known || comparePositions(at.end, known) > 0) this.#applied.set(at.device, at.end);
  }

  /**
   * Re-validates the recorded data against the current state. Returns, sorted by device, the
   * writers whose accepted data shrank and the position after which it is no longer accepted.
   */
  recheck(): FrameRejection[] {
    const out: FrameRejection[] = [];
    for (const device of [...this.#applied.keys()].sort()) {
      const applied = this.#applied.get(device) as SegmentCursor;
      const limit = this.limit(device);
      if (!limit || beforeCut(applied, limit.after)) continue;
      out.push({ device, after: limit.after, reason: limit.reason });
      this.#applied.set(device, limit.after);
    }
    return out;
  }

  /** Forget every recorded frame (before a rebuild replays the log). */
  reset(): void {
    this.#applied.clear();
  }

  /** Per writer, the end of the accepted data recorded (the gate snapshot, gateState.ts). */
  entries(): [string, SegmentCursor][] {
    return [...this.#applied.entries()].map(([d, at]) => [d, { seg: at.seg, offset: at.offset }]);
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
