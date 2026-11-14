/** Account metadata and already-valued same-base amounts; per-account scope is explicit. */
import { type Decimal, ZERO } from "../../decimal.js";
import type { AccountId } from "../domain/index.js";
import { countedBase } from "../domain/index.js";
import { ratioPct, viewTimestamp } from "./positions.js";
import type { BrokerageAccountFact, PortfolioViewState } from "./types.js";
export function accountsView(
  accounts: readonly BrokerageAccountFact[],
  state: PortfolioViewState | null,
) {
  const values = new Map<AccountId, Decimal>();
  if (state !== null) {
    for (const v of state.valued.valued)
      if (v.marketValueBase !== null)
        values.set(
          v.holding.accountId,
          (values.get(v.holding.accountId) ?? ZERO).add(v.marketValueBase),
        );
    for (const c of state.valued.cash)
      values.set(c.cash.accountId, (values.get(c.cash.accountId) ?? ZERO).add(countedBase(c)));
  }
  return accounts.map((a) => {
    const value = state === null ? null : (values.get(a.id) ?? null),
      inScope =
        state === null || state.accountFilter === null || state.accountFilter.includes(a.id),
      total = state?.valued.totalBase;
    return {
      id: a.id,
      name: a.name,
      broker: a.broker,
      broker_name: a.brokerName,
      wrapper: a.wrapper,
      currency: a.currency,
      importer: a.importer,
      has_mapping: a.hasMapping,
      active: a.active,
      value: value !== null && inScope ? value : null,
      share:
        value !== null && inScope && total !== undefined && !total.isZero()
          ? ratioPct(value.div(total).toFloat())
          : null,
      snapshot_date: a.snapshotDate,
      last_import:
        a.lastImport === null
          ? null
          : {
              batch_id: a.lastImport.batchId,
              at: viewTimestamp(a.lastImport.at),
              file_name: a.lastImport.fileName,
            },
    };
  });
}
