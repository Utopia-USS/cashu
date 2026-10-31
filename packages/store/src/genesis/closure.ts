// The instrument closure of a vault (S26 spec 4.6, D-G1, gid.md 7.3): instruments and aliases are
// global in Python, a vault gets every instrument a row of its profile references (columns, signal
// key `i:` parts and payload ids, research note details, research run scopes). Unreferenced
// instruments stay out of the vault (counted `instrument_orphan`). The same reference list as the
// parity check's `_closure` (parity/python/checks/store.py), so genesis and the golden agree.
import { isJsonObject, KEY_PART_RE, rowIdOf } from "./idFields.js";
import type { GenesisCounters } from "./report.js";
import type { InvInstrumentRow } from "./rows.js";
import type { ProfileScope } from "./source.js";

const field = (value: unknown, key: string): unknown =>
  isJsonObject(value) ? value[key] : undefined;

/**
 * Instrument ids of the vault's closure that exist in `instruments`, ascending. Counts the
 * instruments left out as `(inv_instruments, instrument_orphan)` on the vault.
 */
export function instrumentClosure(
  scope: ProfileScope,
  instruments: readonly InvInstrumentRow[],
  counters: GenesisCounters,
  ordinal: number,
): readonly number[] {
  const found = new Set<number>();
  const add = (value: unknown) => {
    const id = rowIdOf(value);
    if (id !== undefined) found.add(id);
  };
  const addAll = (values: unknown) => {
    if (Array.isArray(values)) for (const v of values) add(v);
  };
  for (const rows of [
    scope.invTransactions,
    scope.invPositionSnapshots,
    scope.invManualValuations,
    scope.invProfileInstruments,
    scope.invTheses,
    scope.alerts,
    scope.watchlistItems,
    scope.invDecisions,
  ]) {
    for (const r of rows) add(r.instrumentId);
  }
  for (const r of scope.invInstrumentRenames) {
    add(r.oldInstrumentId);
    add(r.newInstrumentId);
  }
  for (const r of scope.invSignals) {
    add(r.instrumentId);
    for (const part of r.dedupKey.split("|")) {
      const m = KEY_PART_RE.exec(part);
      if (m?.[1] === "i") add(Number(m[2]));
    }
    add(field(r.payload, "instrument_id"));
  }
  for (const r of scope.researchNotes) {
    add(r.instrumentId);
    add(field(r.details, "previous_instrument_id"));
  }
  for (const r of scope.researchRuns) {
    addAll(field(r.scope, "instrument_ids"));
    addAll(field(r.scope, "covered_instrument_ids"));
  }
  const closure = instruments.map((i) => i.id).filter((id) => found.has(id));
  counters.addVault(
    ordinal,
    "inv_instruments",
    "instrument_orphan",
    instruments.length - closure.length,
  );
  return closure;
}
