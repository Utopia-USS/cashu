/**
 * End-of-day snapshots (holdings and cash) from one pass of the FIFO lot engine
 * (`performance/series.py:SnapshotStream`). Pure.
 *
 * Drives `IncrementalLotEngine` (Python reads the engine's private `_EngineState`) and builds the
 * holdings exactly like `buildSnapshot` groups them. `keepLots(instrument)` false drops the lots of a
 * holding (quantity and currency stay): valuation needs them only for instruments valued at cost, and
 * converting every lot's cost each day would dominate the run.
 */

import type { Decimal } from "../../decimal.js";
import { sum, ZERO } from "../../decimal.js";
import type { InstrumentRename } from "../domain/instrument.js";
import {
  type CashBalance,
  cashBalance,
  type Holding,
  holding,
  type OpenLot,
  type PortfolioSnapshot,
  portfolioSnapshot,
} from "../domain/snapshot.js";
import type { Transaction } from "../domain/transaction.js";
import { asProfileId, type CalendarDate, type InstrumentId } from "../domain/values.js";
import { orderEvents, type PortfolioEvent } from "../portfolio/events.js";
import type { Fraction } from "../portfolio/fraction.js";
import { IncrementalLotEngine, type RunningLot } from "../portfolio/lotEngine.js";

/** Python's `date.min`: the snapshot before any event. */
const DATE_MIN: CalendarDate = "0001-01-01";

export class SnapshotStream {
  private readonly byDate = new Map<CalendarDate, PortfolioEvent[]>();
  private readonly engine = new IncrementalLotEngine();
  private readonly lots = new Map<string, [Fraction, Decimal | null, OpenLot]>();
  private readonly keep: (instrumentId: InstrumentId) => boolean;
  snapshot: PortfolioSnapshot = portfolioSnapshot({ profileId: asProfileId(""), asOf: DATE_MIN });

  constructor(
    ordered: readonly Transaction[],
    renames: readonly InstrumentRename[],
    keepLots: ((instrumentId: InstrumentId) => boolean) | null = null,
  ) {
    for (const event of orderEvents(ordered, renames)) {
      const day = event.kind === "txn" ? event.txn.tradeDate : event.rename.date;
      const list = this.byDate.get(day);
      if (list === undefined) this.byDate.set(day, [event]);
      else list.push(event);
    }
    this.keep = keepLots ?? (() => true);
  }

  /** Apply `day`'s events (inside `exactDecimals`); true when the snapshot changed. */
  advance(day: CalendarDate): boolean {
    const events = this.byDate.get(day);
    if (events === undefined || events.length === 0) return false;
    for (const event of events) {
      if (event.kind === "rename") this.engine.rename(event.rename);
      else this.engine.apply(event.txn);
    }
    this.snapshot = this.build(day);
    return true;
  }

  private openLot(lot: RunningLot): OpenLot {
    const key = `${lot.accountId}\u0000${lot.openTxnId}`;
    const hit = this.lots.get(key);
    if (
      hit?.[0].eq(lot.quantity) &&
      sameCost(hit[1], lot.cost) &&
      hit[2].instrumentId === lot.instrumentId
    ) {
      return hit[2];
    }
    const open = lot.toOpenLot();
    this.lots.set(key, [lot.quantity, lot.cost, open]);
    return open;
  }

  private build(day: CalendarDate): PortfolioSnapshot {
    const holdings: Holding[] = [];
    for (const queue of this.engine.queues()) {
      if (queue.lots.length === 0) continue;
      const lots = queue.lots.map((lot) => this.openLot(lot));
      holdings.push(
        holding({
          accountId: queue.accountId,
          instrumentId: queue.instrumentId,
          currency: (lots[0] as OpenLot).currency,
          quantity: sum(
            lots.map((lot) => lot.quantity),
            ZERO,
          ),
          lots: this.keep(queue.instrumentId) ? lots : [],
        }),
      );
    }
    const cash: CashBalance[] = [];
    for (const entry of this.engine.cash()) {
      if (entry.amount.isZero()) continue;
      cash.push(
        cashBalance({ accountId: entry.accountId, currency: entry.currency, amount: entry.amount }),
      );
    }
    return portfolioSnapshot({ profileId: asProfileId(""), asOf: day, holdings, cash });
  }
}

function sameCost(a: Decimal | null, b: Decimal | null): boolean {
  if (a === null || b === null) return a === b;
  return a.eq(b);
}
