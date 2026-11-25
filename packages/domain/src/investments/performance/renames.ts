/** Instrument rename chains over time (`performance/series.py:Renames`). Pure. */

import type { InstrumentRename } from "../domain/instrument.js";
import type { CalendarDate, InstrumentId } from "../domain/values.js";

/**
 * Which instrument an id stands for on a date: rename chains, effective at the start of their date
 * (like the lot engine).
 */
export class Renames {
  private readonly renames: readonly InstrumentRename[];

  constructor(renames: readonly InstrumentRename[]) {
    // Python `sorted(renames, key=date)`: stable
    this.renames = [...renames].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  resolve(instrumentId: InstrumentId | null, on: CalendarDate): InstrumentId | null {
    if (instrumentId === null) return null;
    const redirect = new Map<InstrumentId, InstrumentId>();
    for (const rename of this.renames) {
      if (rename.date > on) break;
      const old = follow(redirect, rename.oldInstrumentId);
      const next = follow(redirect, rename.newInstrumentId);
      if (old !== next) redirect.set(old, next);
    }
    return follow(redirect, instrumentId);
  }

  /** The id after every rename (what attribution groups by). */
  final(instrumentId: InstrumentId | null): InstrumentId | null {
    const last = this.renames[this.renames.length - 1];
    if (last === undefined) return instrumentId;
    return this.resolve(instrumentId, last.date);
  }
}

function follow(
  redirect: ReadonlyMap<InstrumentId, InstrumentId>,
  instrumentId: InstrumentId,
): InstrumentId {
  const seen = new Set<InstrumentId>();
  let current = instrumentId;
  while (redirect.has(current) && !seen.has(current)) {
    seen.add(current);
    current = redirect.get(current) as InstrumentId;
  }
  return current;
}
