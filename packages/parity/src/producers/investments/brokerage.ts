/**
 * The investments net-worth contributor of one profile for the core producers: the domain
 * `BrokerageContributor` over the profile's rows from the read-only source (Python's
 * `_ProfileHistory` loads the same: transactions, renames, the referenced instruments as the profile
 * sees them, their manual valuations, every stored bar of them and every stored rate).
 */

import { investments as inv } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import {
  fxRate,
  loadInstruments,
  manualValuation,
  pk,
  priceBar,
  rename,
  sid,
  transaction,
} from "./rows.ts";

export function brokerageContributor(db: PythonDb, profileId: number): inv.BrokerageContributor {
  const txns = db.investments.transactions(profileId).map(transaction);
  const renames = db.investments.renames(profileId).map(rename);
  const ids = new Set<number>();
  for (const t of txns) if (t.instrumentId !== null) ids.add(pk(t.instrumentId));
  for (const r of renames) {
    ids.add(pk(r.oldInstrumentId));
    ids.add(pk(r.newInstrumentId));
  }
  const instruments = loadInstruments(db, profileId, ids);
  const history: inv.BrokerageHistory = {
    profileId: inv.asProfileId(sid(profileId)),
    txns,
    renames,
    instruments,
    // `manual_valuations(session, profile_id, ids)`
    manualValuations: db.investments
      .manualValuations(profileId)
      .filter((v) => ids.has(v.instrumentId))
      .map(manualValuation),
    bars: db.investments.priceBars([...ids]).map(priceBar),
    rates: db.investments.fxRates().map(fxRate),
  };
  // Net worth speaks natural keys (the goldens' account ids); the transactions carry `str(pk)`.
  const byKey = new Map(
    db
      .accounts(profileId, { includeRemoved: true })
      .map((a) => [db.keys.key("accounts", a.id), inv.asAccountId(sid(a.id))] as const),
  );
  return new inv.BrokerageContributor(history, db.asOf, (key) => {
    const id = byKey.get(key);
    if (id === undefined) throw new Error("net worth asked for an account of another profile");
    return id;
  });
}
