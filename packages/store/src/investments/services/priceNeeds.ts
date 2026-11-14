/** Canonical refresh subjects, without strategy version recording or any financial write. */
import type { DateTime } from "@cashu/domain";
import {
  asInstrumentId,
  asProfileId,
  buildSnapshot,
  type CalendarDate,
  type Currency,
  fxCurrenciesFor,
  type Instrument,
  type InstrumentId,
  type ManualValuation,
  marketView,
  TxnType,
} from "@cashu/domain/investments";
import { alerts, LIVE_ALERT_STATUSES, watchlist } from "../queries/alerts.js";
import { loadInstruments } from "../queries/instruments.js";
import type { Read } from "../queries/shared.js";
import { manualValuations, renames, transactions } from "../queries/transactions.js";

export interface PriceNeeds {
  readonly instruments: ReadonlyMap<InstrumentId, Instrument>;
  readonly watched: ReadonlyMap<InstrumentId, Instrument>;
  readonly currencies: ReadonlySet<Currency>;
  readonly fxHistoryFrom: ReadonlyMap<Currency, CalendarDate>;
  readonly splitDates: ReadonlyMap<InstrumentId, CalendarDate>;
}
export function collectPriceNeeds(
  read: Read,
  asOf: CalendarDate,
  now: DateTime,
  base: Currency,
): PriceNeeds {
  const profile = read<{ gid: string }>("SELECT gid FROM profiles")[0];
  if (profile === undefined) throw new Error("missing refresh vault");
  const txns = transactions(read);
  const snapshot = buildSnapshot(asProfileId(profile.gid), txns, asOf, { renames: renames(read) });
  const held = new Set(snapshot.holdings.map((h) => h.instrumentId));
  const instruments = new Map([...loadInstruments(read, held).values()].map((i) => [i.id, i]));
  const wanted = new Set(watchlist(read).map((w) => w.instrument));
  for (const a of alerts(read, now, LIVE_ALERT_STATUSES))
    if (a.instrument !== null) wanted.add(a.instrument);
  const watched = new Map(
    [
      ...loadInstruments(
        read,
        [...wanted].filter((id) => !held.has(asInstrumentId(id))),
      ).values(),
    ].map((i) => [i.id, i]),
  );
  const manual = new Map<InstrumentId, ManualValuation[]>();
  for (const v of manualValuations(read))
    if (held.has(v.instrumentId)) {
      const list = manual.get(v.instrumentId) ?? [];
      list.push(v);
      manual.set(v.instrumentId, list);
    }
  const { currencies } = fxCurrenciesFor(
    snapshot,
    marketView({ asOf, instruments, manualValuations: manual }),
    base,
  );
  const fxHistoryFrom = new Map<Currency, CalendarDate>();
  const earliest = (c: Currency, d: CalendarDate) => {
    if (d < (fxHistoryFrom.get(c) ?? "9999-12-31")) fxHistoryFrom.set(c, d);
  };
  for (const h of snapshot.holdings) for (const lot of h.lots) earliest(lot.currency, lot.openDate);
  for (const r of snapshot.realized) earliest(r.costCurrency ?? r.currency, r.openDate);
  const splitDates = new Map<InstrumentId, CalendarDate>();
  for (const t of txns)
    if (t.type === TxnType.SPLIT && t.instrumentId !== null && held.has(t.instrumentId)) {
      if (t.tradeDate > (splitDates.get(t.instrumentId) ?? ""))
        splitDates.set(t.instrumentId, t.tradeDate);
    }
  return { instruments, watched, currencies, fxHistoryFrom, splitDates };
}
