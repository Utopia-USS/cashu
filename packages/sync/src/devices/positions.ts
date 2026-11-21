// Stream positions and THE definition of a revocation cut (review m3: one definition shared by the
// frame guard, the registry, the lease and the rebuild check).
//
// A position is always the cursor AFTER an item of one device's stream (`SegmentCursor`, the value the
// store persists after applying it): for a frame, the cursor after that frame; for an event, the
// cursor after the batch that carried it (`InboundBatch.cursor`). A revocation's `cut` is a cursor of
// the revoked device's stream (the revoker's applied cursor of it), and an item is before the cut,
// so still accepted, exactly when its END is at or before the cut:
//
//   beforeCut(end, cut)  <=>  end <= cut
//
// A batch is applied whole or not at all, so a cut inside a batch rejects the whole batch: its data
// frames and its statements alike.

import type { SegmentCursor } from "../carrier.js";

export function comparePositions(a: SegmentCursor, b: SegmentCursor): number {
  return a.seg - b.seg || a.offset - b.offset;
}

/** True when an item of the revoked device's stream ending at `end` lies before `cut` (accepted). */
export function beforeCut(end: SegmentCursor, cut: SegmentCursor): boolean {
  return comparePositions(end, cut) <= 0;
}

export function maxPosition(a: SegmentCursor, b: SegmentCursor): SegmentCursor {
  return comparePositions(a, b) >= 0 ? a : b;
}

export function minPosition(a: SegmentCursor, b: SegmentCursor): SegmentCursor {
  return comparePositions(a, b) <= 0 ? a : b;
}

export function positionKey(p: SegmentCursor): string {
  return `${p.seg}:${p.offset}`;
}
