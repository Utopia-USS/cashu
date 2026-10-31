/**
 * Stand-in for budget's net-worth contributor (`modules/budget/networth.py`, `CashContributor`):
 * the cash pool is worth the running sum of its transactions. It lives here until the budget port
 * exports its own contributor; it is built on the core `RunningValuation`, so the parity run
 * exercises the real valuation code.
 */

import { core, D, type Decimal, type IsoDate } from "@cashu/domain";

export interface CashTxn {
  readonly accountKey: string;
  readonly id: number;
  readonly bookingDate: IsoDate;
  readonly amount: Decimal;
}

export class CashPoolContributor implements core.NetWorthContributor {
  private readonly txns: readonly CashTxn[];

  /** `txns`: the profile's budget transactions (any account; non-cash ones are ignored). */
  constructor(txns: readonly CashTxn[]) {
    this.txns = txns;
  }

  valuations(
    accounts: ReadonlyMap<string, core.NetWorthAccount>,
  ): ReadonlyMap<string, core.Valuation> {
    const cashIds = [...accounts.values()].filter((a) => a.type === "cash").map((a) => a.id);
    const out = new Map<string, core.Valuation>();
    for (const id of cashIds) {
      const rows = this.txns
        .filter((t) => t.accountKey === id)
        .sort((a, b) =>
          a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : a.id - b.id,
        );
      const byDate = new Map<IsoDate, Decimal>();
      let run = D("0.00");
      for (const t of rows) {
        run = run.add(t.amount);
        byDate.set(t.bookingDate, run);
      }
      out.set(id, new core.RunningValuation([...byDate.entries()]));
    }
    return out;
  }
}
