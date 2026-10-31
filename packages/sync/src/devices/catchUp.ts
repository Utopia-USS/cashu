// The catch-up requirement of the fetch lease (events.md 8.3 M6, S29c R3a): before newest-day
// imports a holder applies, for every device, the highest VALID cursor any lease event on the chain
// names. Valid, judged against what the registry proves today (no signed heads yet, R3b adds them):
// - the named device is registered (certified through some chain), else `unknown_device`;
// - a revoked device's entry is capped at its cut (the requirement expires with the revocation);
// - a registered device that is neither trusted nor revoked (conflicted) is `untrusted_device`: its
//   data is never accepted, so requiring it would block forever;
// - an owner waiver (`waive` on a claim or renewal) restarts a device's requirement at that event's
//   own entry for it (or removes it), for data the owner confirmed lost or withheld.
// Entries of a writer revoked later count only when the lease event lies before its cut: the lease
// fold only walks events whose signature verifies with `registry.statementKeys`.

import type { SegmentCursor } from "../carrier.js";
import type { Watermark } from "./events.js";
import { beforeCut, comparePositions, minPosition } from "./positions.js";
import type { Registry } from "./registry.js";
import { cmp } from "./util.js";

export type WatermarkDrop = "unknown_device" | "untrusted_device";

export interface DroppedWatermarkEntry {
  readonly device: string;
  readonly reason: WatermarkDrop;
  /** The lease event that named it. */
  readonly eid: string;
}

export interface CatchUp {
  /** Per device, the cursor to apply first (validated, capped at a revoked device's cut). */
  readonly need: Watermark;
  /** Per device, the eid of the lease event that set the requirement (UI: who requires it). */
  readonly sources: ReadonlyMap<string, string>;
  readonly dropped: readonly DroppedWatermarkEntry[];
}

/** Accumulates the requirement over the lease chain, in chain order. */
export class CatchUpFold {
  readonly #registry: Registry;
  readonly #need = new Map<string, SegmentCursor>();
  readonly #sources = new Map<string, string>();
  readonly #dropped: DroppedWatermarkEntry[] = [];

  constructor(registry: Registry) {
    this.#registry = registry;
  }

  /** One chain event: its watermark and the devices it waives. */
  add(eid: string, watermark: Watermark, waive: readonly string[] = []): void {
    const waived = new Set(waive);
    for (const device of waived) {
      this.#need.delete(device);
      this.#sources.delete(device);
    }
    for (const [device, cursor] of Object.entries(watermark)) {
      const need = this.#valid(eid, device, cursor);
      if (!need) continue;
      const known = this.#need.get(device);
      if (known === undefined || comparePositions(need, known) > 0) {
        this.#need.set(device, need);
        this.#sources.set(device, eid);
      }
    }
  }

  result(): CatchUp {
    const need: Record<string, SegmentCursor> = {};
    for (const device of [...this.#need.keys()].sort(cmp)) {
      need[device] = this.#need.get(device) as SegmentCursor;
    }
    return { need, sources: new Map(this.#sources), dropped: [...this.#dropped] };
  }

  #valid(eid: string, device: string, cursor: SegmentCursor): SegmentCursor | undefined {
    const registry = this.#registry;
    if (!registry.isRegistered(device)) {
      this.#dropped.push({ device, reason: "unknown_device", eid });
      return undefined;
    }
    const revocation = registry.revoked.get(device);
    if (revocation) return minPosition(cursor, revocation.cut);
    if (!registry.isTrusted(device)) {
      this.#dropped.push({ device, reason: "untrusted_device", eid });
      return undefined;
    }
    return cursor;
  }
}

/** Devices whose streams are not applied up to `need` yet, with what is needed. */
export function behindNeed(
  need: Watermark,
  applied: ReadonlyMap<string, SegmentCursor>,
): { readonly device: string; readonly need: SegmentCursor }[] {
  const missing: { device: string; need: SegmentCursor }[] = [];
  for (const [device, cursor] of Object.entries(need)) {
    const have = applied.get(device);
    const behind =
      have === undefined
        ? comparePositions(cursor, { seg: 1, offset: 0 }) > 0
        : !beforeCut(cursor, have);
    if (behind) missing.push({ device, need: cursor });
  }
  return missing.sort((a, b) => cmp(a.device, b.device));
}
