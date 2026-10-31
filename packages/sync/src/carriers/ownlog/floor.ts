// Per-writer generation floor (crypto README, "S28b"): revocation stops a revoked device from reading
// new data, but it still holds the old keys and can keep writing frames that open, under any device
// id. Until per-device frame signatures land (S28d), the carrier refuses, from every writer, frames
// under a generation below the revocation key once that writer has written at or above it.
//
// The rule is positional, so history stays readable: a writer's old-generation frames that sit
// BEFORE its first frame at the floor still open (a new device replays them); old-generation frames
// AFTER that point are refused (`key_not_allowed`, checked before decrypting). Between a revocation
// and a writer's first frame at the new generation the floor cannot tell the revoked device from that
// writer; only signatures close that window.
//
// State must survive restarts (S29 persists `state()` with its registry and passes it back); a lost
// state only reopens the window above, it never refuses honest frames.
import type { FramePosition, SegmentCursor } from "../../carrier.js";
import type { KeyEntry } from "../../crypto/keys.js";

export interface WriterKeyFloorState {
  /** Generation of the latest revocation key (0 = no floor). */
  readonly generation: number;
  /** `vault/device` -> position of that writer's first frame at or above the floor. */
  readonly marks: Readonly<Record<string, SegmentCursor>>;
}

function before(a: SegmentCursor, b: SegmentCursor): boolean {
  return a.seg < b.seg || (a.seg === b.seg && a.offset < b.offset);
}

export class WriterKeyFloor {
  #generation = 0;
  readonly #marks = new Map<string, SegmentCursor>();

  constructor(state?: WriterKeyFloorState) {
    if (!state) return;
    this.#generation = state.generation;
    for (const [key, at] of Object.entries(state.marks)) {
      this.#marks.set(key, { seg: at.seg, offset: at.offset });
    }
  }

  get generation(): number {
    return this.#generation;
  }

  /** S29, after applying a revocation: the revocation key's generation becomes the floor. */
  raise(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new RangeError("floor generation must be a positive integer");
    }
    if (generation <= this.#generation) return;
    this.#generation = generation;
    // A mark proves writing at the old floor, not at the new one.
    this.#marks.clear();
  }

  /** Checked before decrypting a frame at `at` sealed with `entry`. */
  allows(at: FramePosition, entry: KeyEntry): boolean {
    if (entry.generation >= this.#generation) return true;
    const mark = this.#marks.get(`${at.vault}/${at.device}`);
    return !mark || before(at, mark);
  }

  /** Called after a frame opened: remembers the writer's first frame at the floor. */
  record(at: FramePosition, entry: KeyEntry): void {
    if (this.#generation === 0 || entry.generation < this.#generation) return;
    const key = `${at.vault}/${at.device}`;
    const mark = this.#marks.get(key);
    if (!mark || before(at, mark)) this.#marks.set(key, { seg: at.seg, offset: at.offset });
  }

  state(): WriterKeyFloorState {
    return { generation: this.#generation, marks: Object.fromEntries(this.#marks) };
  }
}
