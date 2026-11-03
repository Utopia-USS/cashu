import { D, Money as MoneyValue } from "@cashu/domain";
import { Amount, DateText, LineChart, Money, Percent } from "@cashu/ui";
import { useEffect, useRef } from "react";
import { useVirtualRows } from "../../presentation/useVirtualRows.js";
import { I } from "./Portfolio.strings.js";
import { investmentButton } from "./PortfolioView.js";
import type { PortfolioScreenState } from "./usePortfolioScreen.js";

const ratio = (value: number | null) => (value === null ? null : D(String(value)));

/** One native held/watched/saved detail surface in a page or modal panel. */
export function AssetDetailView({ state }: { state: PortfolioScreenState }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (state.selected !== null && !state.isPage && !element?.open) element?.showModal();
    if (state.selected === null && element?.open) element.close();
  }, [state.selected, state.isPage]);
  if (state.isPage)
    return (
      <main className="grid gap-6 p-6" data-testid="native-asset-page">
        <AssetBody state={state} />
      </main>
    );
  return (
    <dialog
      ref={ref}
      aria-label={I.details}
      onCancel={(event) => {
        event.preventDefault();
        state.setSelected(null);
      }}
      className="m-auto max-h-full w-full max-w-6xl overflow-auto rounded-lg border border-border bg-surface-overlay p-6 text-fg backdrop:bg-surface-sunken"
    >
      <AssetBody state={state} />
      <button type="button" className={investmentButton} onClick={() => state.setSelected(null)}>
        {I.close}
      </button>
    </dialog>
  );
}

function AssetBody({ state }: { state: PortfolioScreenState }) {
  const data = state.asset;
  if (data.status !== "ready") return <p>{I.unavailable}</p>;
  const { detail, chart, quoteFacts, lotFacts } = data;
  const position = detail.position;
  const currency = chart.currency;

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-caption text-fg-muted">
            {detail.entry.state === "held"
              ? I.entryHeld
              : detail.entry.state === "watched"
                ? I.entryWatched
                : I.entrySaved}{" "}
            · {detail.instrument.asset_class} · {detail.instrument.currency}
          </p>
          <h1 className="text-headline font-strong">
            {state.privacy ? I.hidden : detail.instrument.label}
          </h1>
          {!state.privacy && (
            <p className="text-caption">
              {detail.instrument.isin} · {detail.instrument.mic} · {detail.instrument.region}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={investmentButton}
            disabled={state.privacy}
            onClick={() => state.openTransaction(detail.instrument.id)}
          >
            {I.addTransaction}
          </button>
          <button
            type="button"
            className={investmentButton}
            disabled={state.privacy}
            onClick={() => state.openClassification(detail.instrument.id)}
          >
            {I.classify}
          </button>
          {detail.entry.watch_item_id && (
            <button
              type="button"
              className={investmentButton}
              disabled={state.privacy}
              onClick={state.openNote}
            >
              {I.note}
            </button>
          )}
          {!state.isPage && (
            <button type="button" className={investmentButton} onClick={state.openPage}>
              {I.openPage}
            </button>
          )}
        </div>
      </header>
      {!state.privacy && (
        <div className="flex flex-wrap gap-2 text-caption text-fg-muted">
          {state
            .marksFor(detail.instrument, detail.hints, detail.entry.state === "held")
            .map((mark) => (
              <span key={mark}>{mark}</span>
            ))}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-4">
        <section className="grid content-start gap-1">
          <h2>{I.value}</h2>
          <Money value={state.money(position?.value ?? null)} />
        </section>
        <section className="grid content-start gap-1">
          <h2>{I.quantity}</h2>
          <Amount value={position?.quantity ?? null} />
        </section>
        <section className="grid content-start gap-1">
          <h2>{I.result}</h2>
          <Money value={state.money(position?.unrealized ?? null)} />
          <Percent value={ratio(position?.unrealized_pct ?? null)} />
        </section>
        <section className="grid content-start gap-1">
          <h2>{I.price}</h2>
          <Money value={state.money(chart.last?.close ?? position?.price ?? null, currency)} />
          <DateText value={chart.last?.date ?? position?.price_date ?? null} />
        </section>
      </div>
      <div className="flex flex-wrap gap-3 text-caption">
        <span>
          {I.transactions}{" "}
          <Amount value={D(String(detail.transactions.length))} fractionDigits={0} />
        </span>
        <span>
          {I.lots} <Amount value={D(String(lotFacts.rows.length))} fractionDigits={0} />
        </span>
        {data.fees.map((fee) => (
          <span key={fee.currency}>
            {I.fees} <Money value={new MoneyValue(fee.amount, fee.currency)} />
          </span>
        ))}
        {Object.entries(position?.dividends ?? {}).map(([c, value]) => (
          <span key={c}>
            {I.dividend} <Money value={new MoneyValue(value, c)} />
          </span>
        ))}
      </div>
      <section className="rounded-lg border border-border p-4">
        <header className="flex justify-between gap-3">
          <h2>{I.price}</h2>
          <label>
            {I.range}
            <select
              className="border border-border bg-surface p-2"
              value={state.months}
              onChange={(event) => state.setMonths(Number(event.target.value))}
            >
              {[1, 3, 12, 24, 60, 1200].map((months) => (
                <option key={months} value={months}>
                  {months === 1200 ? "max" : `${months}m`}
                </option>
              ))}
            </select>
          </label>
        </header>
        {state.assetChart && <LineChart {...state.assetChart} yFormat={state.format} />}
        <div className="flex flex-wrap gap-4 text-caption">
          <span>
            {I.fromHigh} <Percent value={ratio(quoteFacts.fromHigh)} />
          </span>
          <span>
            {I.low}{" "}
            <Money
              value={
                quoteFacts.rangeLow === null ? null : new MoneyValue(quoteFacts.rangeLow, currency)
              }
            />
          </span>
          <span>
            {I.volatility} <Percent value={ratio(quoteFacts.volatility30)} />
          </span>
          {quoteFacts.nearest && (
            <button
              type="button"
              className="text-accent"
              onClick={() => state.adjacent("investments.alerts")}
            >
              {I.nearestAlert}{" "}
              <Money value={state.money(D(String(quoteFacts.nearest.alert.level)), currency)} />
              <Percent value={ratio(quoteFacts.nearest.distance)} />
            </button>
          )}
        </div>
      </section>
      {position && (
        <section>
          <h2>{I.accounts}</h2>
          <table className="w-full text-caption">
            <thead>
              <tr>
                <th>{I.account}</th>
                <th>{I.quantity}</th>
                <th>{I.cost}</th>
                <th>{I.value}</th>
                <th>{I.result}</th>
              </tr>
            </thead>
            <tbody>
              {position.accounts.map((account) => (
                <tr key={account.account_id}>
                  <th>{state.privacy ? I.hidden : account.account_name}</th>
                  <td>
                    <Amount value={account.quantity} />
                  </td>
                  <td>
                    <Money
                      value={
                        account.average_cost === null
                          ? null
                          : new MoneyValue(account.average_cost, account.cost_currency ?? currency)
                      }
                    />
                  </td>
                  <td>
                    <Money value={state.money(account.value)} />
                  </td>
                  <td>
                    <Percent value={ratio(account.unrealized_pct)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>{I.lots}</h2>
          <LotTable state={state} />
        </section>
      )}
      <section className="rounded-lg border border-border p-4">
        <header className="flex justify-between gap-3">
          <h2>{I.thesis}</h2>
          <button
            type="button"
            className={investmentButton}
            disabled={state.privacy}
            onClick={() => state.openThesis(null)}
          >
            {I.createThesis}
          </button>
        </header>
        {detail.theses.length === 0 && <p>{I.noThesis}</p>}
        {!state.privacy &&
          detail.theses.map((thesis) => (
            <article key={thesis.id} className="border-b border-border py-3">
              <div className="flex justify-between gap-2">
                <DateText value={state.calendarDate(thesis.updated_at)} />
                <button
                  type="button"
                  className={investmentButton}
                  onClick={() => state.openThesis(thesis.id)}
                >
                  {I.editThesis}
                </button>
              </div>
              <p className="whitespace-pre-wrap">{thesis.thesis}</p>
              {[
                [I.invalidation, thesis.invalidation],
                [I.exitPlan, thesis.exit_plan],
                [I.sizePlan, thesis.size_plan],
              ].map(
                ([label, value]) =>
                  value && (
                    <p key={label}>
                      <b>{label}</b> {value}
                    </p>
                  ),
              )}
              {thesis.reviewed_at && (
                <p>
                  {I.reviewed} <DateText value={state.calendarDate(thesis.reviewed_at)} />
                </p>
              )}
            </article>
          ))}
      </section>
      <section>
        <h2>{I.transactions}</h2>
        <AssetTransactions state={state} />
      </section>
      <nav className="flex flex-wrap gap-2">
        {[
          ["investments.signals", I.signals],
          ["investments.research", I.research],
          ["investments.strategies", I.strategies],
        ].map(([tab, label]) => (
          <button
            type="button"
            key={tab}
            className={investmentButton}
            onClick={() => state.adjacent(tab ?? "")}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function LotTable({ state }: { state: PortfolioScreenState }) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = state.asset.status === "ready" ? state.asset.lotFacts.rows : [];
  const virtual = useVirtualRows({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 48,
    overscan: 5,
  });
  const large = rows.length > 50;
  const items = large ? virtual.items : rows.map((_, index) => ({ index, start: 0 }));
  return (
    <div ref={ref} className="max-h-72 overflow-auto">
      <table aria-label={I.lots} aria-rowcount={rows.length + 1} className="grid w-full">
        <thead>
          <tr className="grid grid-cols-5">
            <th>{I.date}</th>
            <th>{I.account}</th>
            <th>{I.quantity}</th>
            <th>{I.cost}</th>
            <th>{I.result}</th>
          </tr>
        </thead>
        <tbody className="relative block" style={large ? { height: virtual.totalSize } : undefined}>
          {items.map((item) => {
            const row = rows[item.index];
            return (
              row && (
                <tr
                  key={`${row.open_txn_id}:${row.account_id}`}
                  aria-rowindex={item.index + 2}
                  className={`${large ? "absolute left-0 top-0 " : ""}grid h-12 w-full grid-cols-5`}
                  style={large ? { transform: `translateY(${item.start}px)` } : undefined}
                >
                  <td>
                    <DateText value={row.open_date} />
                  </td>
                  <td>
                    {state.privacy
                      ? I.hidden
                      : state.portfolio.accounts.find((account) => account.gid === row.account_id)
                          ?.name}
                  </td>
                  <td>
                    <Amount value={row.quantity} />
                  </td>
                  <td>
                    <Money
                      value={
                        row.unit_cost === null ? null : new MoneyValue(row.unit_cost, row.currency)
                      }
                    />
                  </td>
                  <td>
                    <Percent value={ratio(row.resultPct)} />
                  </td>
                </tr>
              )
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AssetTransactions({ state }: { state: PortfolioScreenState }) {
  const ref = useRef<HTMLDivElement>(null);
  const rows = state.asset.status === "ready" ? state.asset.detail.transactions : [];
  const virtual = useVirtualRows({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 56,
    overscan: 5,
  });
  const large = rows.length > 50;
  const items = large ? virtual.items : rows.map((_, index) => ({ index, start: 0 }));
  return (
    <div ref={ref} className="max-h-96 overflow-auto">
      <table aria-label={I.transactions} aria-rowcount={rows.length + 1} className="grid w-full">
        <thead>
          <tr className="grid grid-cols-7">
            <th>{I.date}</th>
            <th>{I.transactionType}</th>
            <th>{I.account}</th>
            <th>{I.quantity}</th>
            <th>{I.price}</th>
            <th>{I.cashAmount}</th>
            <th>{I.source}</th>
          </tr>
        </thead>
        <tbody className="relative block" style={large ? { height: virtual.totalSize } : undefined}>
          {items.map((item) => {
            const row = rows[item.index];
            return (
              row && (
                <tr
                  key={row.id}
                  aria-rowindex={item.index + 2}
                  className={`${large ? "absolute left-0 top-0 " : ""}grid h-14 w-full grid-cols-7 items-center gap-2 text-caption`}
                  style={large ? { transform: `translateY(${item.start}px)` } : undefined}
                >
                  <td>
                    <DateText value={row.trade_date} />
                  </td>
                  <td>{state.transactionTypeLabel(row.type)}</td>
                  <td>{state.privacy ? I.hidden : row.account_name}</td>
                  <td>
                    <Amount value={row.quantity} />
                  </td>
                  <td>
                    <Money
                      value={row.price === null ? null : new MoneyValue(row.price, row.currency)}
                    />
                  </td>
                  <td>
                    <Money value={new MoneyValue(row.cash_amount, row.cash_currency)} />
                  </td>
                  <td>{row.source}</td>
                </tr>
              )
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
