// Reference `EventSink` for the contract suite and for engine-level tests: idempotent by eid, LWW
// register per gid (`g`) ordered by (hlc, eid), unknown types / newer versions parked raw
// (events.md 7), one transaction per `applyBatches` (all or nothing). The real store (S23) must
// behave the same on these properties.
import type {
  ApplyOutcome,
  DeviceId,
  EventSink,
  InboundBatch,
  SegmentCursor,
  WireEvent,
} from "../carrier.js";

export interface Delivery {
  readonly device: DeviceId;
  readonly own: boolean;
  readonly hlcs: readonly string[];
}

function wins(a: WireEvent, b: WireEvent): boolean {
  return a.h > b.h || (a.h === b.h && a.i > b.i);
}

export class MemorySink implements EventSink {
  #supported: Readonly<Record<string, number>>;
  #cursors = new Map<DeviceId, SegmentCursor>();
  #eids = new Map<string, string>();
  #registers = new Map<string, WireEvent>();
  #parked: WireEvent[] = [];
  /** Every batch applied, in order (cleared by `reset`). */
  readonly deliveries: Delivery[] = [];
  /** Per committed `applyBatches` call, its number of batches and events (cleared by `reset`). */
  readonly transactions: { readonly batches: number; readonly events: number }[] = [];
  /** Fault injection: the next `applyBatches` throws at this batch index (then it is cleared). */
  failAtBatch: number | undefined;
  /** Same eid seen with a different body (corruption, events.md 2). */
  conflicts = 0;

  constructor(supported: Readonly<Record<string, number>> = { "test.set": 1 }) {
    this.#supported = { ...supported };
  }

  cursors(): ReadonlyMap<DeviceId, SegmentCursor> {
    return new Map(this.#cursors);
  }

  applyBatches(batches: readonly InboundBatch[]): ApplyOutcome[] {
    const saved = {
      cursors: new Map(this.#cursors),
      eids: new Map(this.#eids),
      registers: new Map(this.#registers),
      parked: [...this.#parked],
      deliveries: this.deliveries.length,
      conflicts: this.conflicts,
    };
    const fail = this.failAtBatch;
    this.failAtBatch = undefined;
    try {
      const out = batches.map((b, i) => {
        if (i === fail) throw new Error("injected sink failure");
        return this.#apply(b);
      });
      this.transactions.push({
        batches: batches.length,
        events: batches.reduce((n, b) => n + b.events.length, 0),
      });
      return out;
    } catch (e) {
      this.#cursors = saved.cursors;
      this.#eids = saved.eids;
      this.#registers = saved.registers;
      this.#parked = saved.parked;
      this.deliveries.length = saved.deliveries;
      this.conflicts = saved.conflicts;
      throw e;
    }
  }

  #apply(batch: InboundBatch): ApplyOutcome {
    let applied = 0;
    let duplicates = 0;
    let parked = 0;
    for (const e of batch.events) {
      const body = JSON.stringify(e);
      const seen = this.#eids.get(e.i);
      if (seen !== undefined) {
        duplicates += 1;
        if (seen !== body) this.conflicts += 1;
        continue;
      }
      this.#eids.set(e.i, body);
      const max = this.#supported[e.t];
      if (max === undefined || e.v > max || typeof e.g !== "string") {
        this.#parked.push(JSON.parse(body) as WireEvent);
        parked += 1;
        continue;
      }
      const prev = this.#registers.get(e.g);
      if (!prev || wins(e, prev)) this.#registers.set(e.g, e);
      applied += 1;
    }
    this.#cursors.set(batch.device, batch.cursor);
    this.deliveries.push({
      device: batch.device,
      own: batch.own,
      hlcs: batch.events.map((e) => e.h),
    });
    return { applied, duplicates, parked };
  }

  reset(): void {
    this.#cursors.clear();
    this.#eids.clear();
    this.#registers.clear();
    this.#parked = [];
    this.deliveries.length = 0;
    this.transactions.length = 0;
    this.conflicts = 0;
  }

  /** Simulate a crash between apply and cursor persistence (forces re-delivery). */
  forgetCursors(): void {
    this.#cursors.clear();
  }

  /** Simulate an app upgrade: the reader now understands more (type -> max version). */
  upgrade(supported: Readonly<Record<string, number>>): void {
    this.#supported = { ...supported };
  }

  value(gid: string): unknown {
    return this.#registers.get(gid)?.d.value;
  }

  winner(gid: string): WireEvent | undefined {
    return this.#registers.get(gid);
  }

  get size(): number {
    return this.#registers.size;
  }

  parkedEvents(): readonly WireEvent[] {
    return this.#parked;
  }

  /** Canonical view state: equal strings on two devices = converged. */
  snapshot(): string {
    const regs = [...this.#registers.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([g, e]) => [g, e.h, e.i, e.d]);
    const parked = this.#parked.map((e) => e.i).sort();
    return JSON.stringify({ regs, parked });
  }
}
