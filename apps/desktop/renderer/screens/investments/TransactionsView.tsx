import { Money as MoneyValue } from "@cashu/domain";
import { Amount, DateText, Money } from "@cashu/ui";
import { useRef } from "react";
import { useVirtualRows } from "../../presentation/useVirtualRows.js";
import { I } from "./Portfolio.strings.js";
import { investmentButton } from "./PortfolioView.js";
import type { PortfolioScreenState } from "./usePortfolioScreen.js";

/** Complete canonical transaction history, independently windowed from any asset chart. */
export function TransactionsView({ state }: { state: PortfolioScreenState }) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = state.ledger.ok ? [...state.ledger.rows].reverse() : [];
  const virtual = useVirtualRows({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 64,
    overscan: 5,
    getItemKey: (index) => rows[index]?.id ?? index,
  });
  const large = rows.length > 50;
  const items = large ? virtual.items : rows.map((_, index) => ({ index, start: 0 }));
  return (
    <section className="grid gap-3">
      <button
        type="button"
        className={investmentButton}
        disabled={state.privacy}
        onClick={() => state.openTransaction()}
      >
        {I.addTransaction}
      </button>
      <div ref={ref} className="max-h-96 overflow-auto">
        <table aria-label={I.transactions} aria-rowcount={rows.length + 1} className="grid w-full">
          <thead>
            <tr className="grid grid-cols-7">
              <th>{I.date}</th>
              <th>{I.account}</th>
              <th>{I.transactionType}</th>
              <th>{I.instrument}</th>
              <th>{I.quantity}</th>
              <th>{I.price}</th>
              <th>{I.cashAmount}</th>
            </tr>
          </thead>
          <tbody
            className="relative block"
            style={large ? { height: virtual.totalSize } : undefined}
          >
            {items.map((item) => {
              const row = rows[item.index];
              return (
                row && (
                  <tr
                    key={row.id}
                    aria-rowindex={item.index + 2}
                    className={`${large ? "absolute left-0 top-0 " : ""}grid h-16 w-full grid-cols-7 items-center gap-2 border-b border-border text-caption`}
                    style={large ? { transform: `translateY(${item.start}px)` } : undefined}
                  >
                    <td>
                      <DateText value={row.tradeDate} />
                    </td>
                    <td>
                      {state.privacy
                        ? I.hidden
                        : state.portfolio.accounts.find((account) => account.gid === row.accountId)
                            ?.name}
                    </td>
                    <td>{state.transactionTypeLabel(row.type)}</td>
                    <td>
                      <button
                        type="button"
                        disabled={row.instrumentId === null}
                        className="text-left text-accent"
                        onClick={() => {
                          state.close();
                          state.setSelected(row.instrumentId);
                        }}
                      >
                        {state.privacy
                          ? I.hidden
                          : (state.instrumentOptions.find(
                              (instrument) => instrument.id === row.instrumentId,
                            )?.label ?? "-")}
                      </button>
                    </td>
                    <td>
                      <Amount value={row.quantity} />
                    </td>
                    <td>
                      <Money
                        value={row.price === null ? null : new MoneyValue(row.price, row.currency)}
                      />
                    </td>
                    <td>
                      <Money value={new MoneyValue(row.cashAmount, row.cashCurrency)} />
                      <p className="text-fg-muted">{row.source}</p>
                      {row.note && <p>{state.privacy ? I.hidden : row.note}</p>}
                    </td>
                  </tr>
                )
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
