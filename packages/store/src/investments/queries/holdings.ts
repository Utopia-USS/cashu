// What the vault holds today from its transactions alone (no valuation): Python
// `research/service.py` `held_since` / `held_instrument_ids`. The plan write needs it (a reduce or exit
// recommendation needs a held instrument) and so does the stale-plan rule (a held-only plan written
// before the current holding opened counts as none).
import { asProfileId, buildSnapshot, openedOn } from "@cashu/domain/investments";
import { instrumentRoot, type Read } from "./shared.js";
import { renames, transactions } from "./transactions.js";

/**
 * Instruments the vault holds on `asOf` (the caller's local calendar day) -> the open date of the
 * oldest still-open lot of the holding (`opened_on`), keyed by instrument root gid.
 */
export function heldSince(read: Read, asOf: string): Map<string, string | null> {
  const snapshot = buildSnapshot(asProfileId("vault"), transactions(read), asOf, {
    renames: renames(read),
  });
  const grouped = new Map<string, (typeof snapshot.holdings)[number][]>();
  for (const h of snapshot.holdings) {
    const key = instrumentRoot(read, h.instrumentId);
    grouped.set(key, [...(grouped.get(key) ?? []), h]);
  }
  return new Map([...grouped].map(([key, rows]) => [key, openedOn(rows, snapshot.realized)]));
}
