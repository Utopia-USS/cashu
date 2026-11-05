import { D, Money as MoneyValue } from "@cashu/domain";
import {
  Amount,
  BarChart,
  Card,
  DateText,
  Donut,
  LineChart,
  Money,
  Percent,
  Select,
  Sparkline,
  useVirtualRows,
} from "@cashu/ui";
import { type ReactNode, useRef } from "react";
import { I } from "./Portfolio.strings.js";
import type { PortfolioScreenState } from "./usePortfolioScreen.js";

export const investmentButton =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent aria-pressed:bg-accent-muted";
const ratio = (value: number | null) => (value === null ? null : D(String(value)));

/** Native portfolio composition; financial results arrive already computed from the tracked query. */
export function PortfolioView({
  state,
  homeRail,
}: {
  state: PortfolioScreenState;
  homeRail?: ReactNode;
}) {
  const data = state.portfolio;
  return (
    <main className="grid gap-6 p-6" data-testid="native-portfolio">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-headline font-strong">{I.title}</h1>
        <div className="flex gap-2">
          <button
            type="button"
            className={investmentButton}
            disabled={state.privacy}
            onClick={state.openAccount}
          >
            {I.addAccount}
          </button>
          <button
            type="button"
            className={investmentButton}
            disabled={state.privacy || data.accounts.length === 0}
            onClick={() => state.openTransaction()}
          >
            {I.addTransaction}
          </button>
          <button
            type="button"
            className={investmentButton}
            onClick={() => {
              state.setSelected(null);
              state.setDrawer("transactions");
            }}
          >
            {I.transactions}
          </button>
          <button
            type="button"
            className={investmentButton}
            disabled={state.privacy}
            onClick={() => state.openImport()}
          >
            {I.import}
          </button>
        </div>
      </header>
      {state.notice && <p role="status">{state.notice}</p>}
      <Select
        label={I.account}
        inline
        value={state.account ?? ""}
        onChange={(value) => state.setAccount(value || null)}
        options={[
          { value: "", label: I.all },
          ...data.accounts.map((account, index) => ({
            value: account.gid,
            label: state.privacy ? `${I.hidden} ${index + 1}` : account.name,
          })),
        ]}
      />
      {homeRail}
      {data.status !== "ready" ? (
        <Card>
          <p>{data.accounts.length === 0 ? I.empty : I.unavailable}</p>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              [I.value, data.overview.kpis.value.total],
              [I.cash, data.overview.kpis.cash.amount],
              [I.result, data.overview.kpis.unrealized.amount],
              [I.cost, data.overview.kpis.unrealized.cost],
            ].map(([label, value]) => (
              <Card key={String(label)}>
                <h2 className="text-caption text-fg-muted">{String(label)}</h2>
                <Money
                  value={state.money(typeof value === "string" ? null : value)}
                  size="headline"
                />
              </Card>
            ))}
          </div>
          <Card>
            <header className="flex flex-wrap items-center justify-between gap-3">
              <h2>{I.performance}</h2>
              <div className="flex gap-2">
                <Select
                  label={I.range}
                  value={state.range}
                  onChange={state.setRange}
                  options={["1m", "3m", "ytd", "1y", "3y", "max"].map((range) => ({
                    value: range,
                    label: range,
                  }))}
                />
                <button
                  type="button"
                  className={investmentButton}
                  aria-pressed={state.table}
                  onClick={() => state.setTable(!state.table)}
                >
                  {state.table ? I.chart : I.table}
                </button>
              </div>
            </header>
            {data.performance.summary === null ? (
              <p>{I.noHistory}</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-6 py-3">
                  <span>
                    {I.twr} <Percent value={ratio(data.performance.summary.twr)} />
                  </span>
                  <span>
                    {I.xirr} <Percent value={ratio(data.performance.summary.xirr)} />
                  </span>
                  <span>
                    {I.contributions}{" "}
                    <Money
                      value={
                        data.performance.summary.net_contributions === null
                          ? null
                          : state.money(D(String(data.performance.summary.net_contributions)))
                      }
                    />
                  </span>
                </div>
                {state.table ? (
                  <PerformanceTable state={state} />
                ) : (
                  <LineChart
                    label={I.performance}
                    height={240}
                    series={[
                      {
                        values: data.performance.points.map((point) => point.simulated_value),
                        tone: "bench",
                        name: I.benchmark,
                      },
                      {
                        values: data.performance.points.map((point) => point.value),
                        area: true,
                        name: I.value,
                      },
                    ]}
                    yFormat={state.format}
                    xLabels={data.performance.points.flatMap((point, index) =>
                      index === 0 || index === data.performance.points.length - 1
                        ? [{ i: index, text: point.date }]
                        : [],
                    )}
                    tooltip={(index) => ({
                      title: data.performance.points[index]?.date ?? "",
                      rows: [
                        {
                          name: I.value,
                          value:
                            data.performance.points[index]?.value == null
                              ? "-"
                              : formatOptional(data.performance.points[index]?.value, state.format),
                          amount: true,
                        },
                        {
                          name: I.benchmark,
                          value:
                            data.performance.points[index]?.simulated_value == null
                              ? "-"
                              : formatOptional(
                                  data.performance.points[index]?.simulated_value,
                                  state.format,
                                ),
                          amount: true,
                        },
                      ],
                    })}
                  />
                )}
              </>
            )}
            {data.performance.benchmark.status !== "ok" && (
              <p className="text-caption text-fg-muted">
                {I.benchmarkMissing} · {data.performance.benchmark.status}
              </p>
            )}
          </Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <h2>{I.drawdown}</h2>
              <LineChart
                label={I.drawdown}
                height={160}
                ymax={0}
                valueKind="share"
                series={[
                  {
                    values: data.performance.points.map((point) => point.drawdown),
                    tone: "negative",
                    area: true,
                    areaTo: 0,
                  },
                ]}
                yFormat={(value) => `${state.format(value * 100)}%`}
              />
            </Card>
            <Card>
              <h2>{I.contributions}</h2>
              <BarChart
                label={I.contributions}
                height={160}
                values={data.contributions.map((point) => point.amount.toFloat())}
                labels={data.contributions.map((point) => point.month)}
                format={state.format}
                plan={data.contributionPlan?.monthlyAmount.toFloat() ?? null}
                planLabel={I.plan}
              />
            </Card>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <PositionList state={state} />
            <AllocationPanel state={state} />
          </div>
          <Card>
            <h2>{I.accounts}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {data.accountViews.map((account, index) => (
                <article key={account.id} className="rounded-sm border border-border p-3">
                  <button
                    type="button"
                    className="text-accent"
                    onClick={() => state.setAccount(account.id)}
                  >
                    {state.privacy ? `${I.hidden} ${index + 1}` : account.name}
                  </button>
                  <p className="text-caption text-fg-muted">
                    {account.broker_name} · {account.wrapper} · {account.currency}
                  </p>
                  <Money value={state.money(account.value)} />
                  <p>
                    {I.latest} <DateText value={account.snapshot_date} />
                  </p>
                  <button
                    type="button"
                    className={investmentButton}
                    disabled={state.privacy}
                    onClick={() => {
                      state.setAccount(account.id);
                      state.openImport(account.id);
                    }}
                  >
                    {I.reconciliation}
                  </button>
                </article>
              ))}
            </div>
          </Card>
          <Card>
            <h2>{I.warnings}</h2>
            {data.overview.freshness.prices.stale_count > 0 && (
              <p>
                {I.stale} <Amount value={D(String(data.overview.freshness.prices.stale_count))} />
              </p>
            )}
            {data.overview.freshness.fx.missing.map((currency) => (
              <p key={currency}>
                {I.currency}: {currency}
              </p>
            ))}
            {data.overview.warnings.map((warning) => (
              <button
                type="button"
                key={JSON.stringify(warning)}
                className="block text-left text-tone-warning"
                onClick={() =>
                  warning.account_id
                    ? state.openImport(warning.account_id)
                    : warning.instrument_id
                      ? state.setSelected(warning.instrument_id)
                      : state.adjacent("investments.strategies")
                }
              >
                {I.warningKind(warning.kind)}
              </button>
            ))}
            {data.strategy.state !== "valid" && (
              <button
                type="button"
                className="text-accent"
                onClick={() => state.adjacent("investments.strategies")}
              >
                {I.strategies}: {data.strategy.state}
              </button>
            )}
          </Card>
        </>
      )}
      <nav className="flex flex-wrap gap-3" aria-label={I.details}>
        {[
          ["investments.signals", I.signals],
          ["investments.research", I.research],
          ["investments.review", I.review],
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
    </main>
  );
}

function PositionList({ state }: { state: PortfolioScreenState }) {
  const ref = useRef<HTMLDivElement>(null);
  const data = state.portfolio;
  const watched = data.status === "ready" ? data.watch : [];
  const rows =
    state.tab === "positions"
      ? state.rows.map((row) => ({
          id: row.instrument.id,
          marks: state.marksFor(row.instrument, row.hints, true),
          label: row.instrument.label,
          value: row.value,
          currency: state.base,
          result: row.unrealized_pct,
          quantity: row.quantity,
          closes: row.closes_30d,
          accounts: row.accounts,
          needs: row.instrument.needs_classification,
        }))
      : watched.map((row) => ({
          id: row.instrument_id,
          marks: row.instrument === null ? [] : state.marksFor(row.instrument, row.hints, false),
          label: row.instrument?.label ?? row.instrument_id,
          value: row.price?.close ?? null,
          currency: row.price?.currency || row.instrument?.currency || state.base,
          result: row.price?.change_1m ?? null,
          quantity: null,
          closes: row.closes_30d,
          accounts: [],
          needs: row.instrument?.needs_classification ?? false,
        }));
  const virtual = useVirtualRows({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => (state.split ? 96 : 64),
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 5,
  });
  const large = rows.length > 50;
  const items = large
    ? virtual.items
    : rows.map((_, index) => ({ index, key: rows[index]?.id ?? index, start: 0 }));
  return (
    <Card>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2>{I.assets}</h2>
        <div className="flex gap-2">
          <button
            type="button"
            className={investmentButton}
            aria-pressed={state.tab === "positions"}
            onClick={() => state.setTab("positions")}
          >
            {I.positions}
          </button>
          <button
            type="button"
            className={investmentButton}
            aria-pressed={state.tab === "watch"}
            onClick={() => state.setTab("watch")}
          >
            {I.watched}
          </button>
        </div>
      </header>
      <div className="flex gap-2 py-3">
        <Select
          label={I.sorting}
          value={state.sort}
          onChange={(value) =>
            state.setSort(value === "value" ? "value" : value === "week" ? "week" : "result")
          }
          options={[
            { value: "result", label: I.result },
            { value: "value", label: I.value },
            { value: "week", label: I.week },
          ]}
        />
        <button
          type="button"
          className={investmentButton}
          aria-pressed={state.split}
          onClick={() => state.setSplit(!state.split)}
        >
          {state.split ? I.perAccount : I.total}
        </button>
      </div>
      <div ref={ref} className="max-h-96 overflow-auto">
        <ul
          aria-label={I.positions}
          className="relative"
          style={large ? { height: virtual.totalSize } : undefined}
        >
          {items.map((item) => {
            const row = rows[item.index];
            return !row ? null : (
              <li
                key={row.id}
                aria-posinset={item.index + 1}
                aria-setsize={rows.length}
                data-index={item.index}
                ref={large ? virtual.measureElement : undefined}
                className={`${large ? "absolute left-0 top-0 " : ""}w-full border-b border-border py-3`}
                style={large ? { transform: `translateY(${item.start}px)` } : undefined}
              >
                <div className="grid grid-cols-4 items-center gap-2">
                  <span>
                    <button
                      type="button"
                      className="text-left text-accent"
                      onClick={() => state.setSelected(row.id)}
                    >
                      {state.privacy ? I.hidden : row.label}
                    </button>
                  </span>
                  <span>
                    <Money value={state.money(row.value, row.currency)} />
                  </span>
                  <span>
                    <Percent value={ratio(row.result)} />
                  </span>
                  <span>
                    <Sparkline
                      values={row.closes.map((point) => point.close.toFloat())}
                      label={I.week}
                    />
                  </span>
                </div>
                {!state.privacy && (
                  <div className="flex flex-wrap gap-2 text-caption text-fg-muted">
                    {row.marks.map((mark) => (
                      <span key={mark}>{mark}</span>
                    ))}
                  </div>
                )}
                {row.needs && (
                  <button
                    type="button"
                    className="text-caption text-tone-warning"
                    disabled={state.privacy}
                    onClick={() => state.openClassification(row.id)}
                  >
                    {I.classify}
                  </button>
                )}
                {state.split &&
                  row.accounts.map((account) => (
                    <div
                      key={account.account_id}
                      className="flex flex-wrap justify-between gap-2 pl-3 text-caption"
                    >
                      <span>{state.privacy ? I.hidden : account.account_name}</span>
                      <Amount value={account.quantity} />
                      <Money value={state.money(account.value)} />
                      <Percent value={ratio(account.unrealized_pct)} />
                    </div>
                  ))}
              </li>
            );
          })}
        </ul>
      </div>
      {rows.length === 0 && <p>{I.empty}</p>}
    </Card>
  );
}

function AllocationPanel({ state }: { state: PortfolioScreenState }) {
  if (state.portfolio.status !== "ready") return null;
  const data = state.portfolio;
  const rows =
    state.allocationMode === "buckets"
      ? data.allocation.buckets.map((row) => ({
          identity: row.bucket_id,
          key: state.allocationLabel("buckets", row.bucket_id),
          value: row.value,
          weight: row.weight,
          target: row.target,
          drift: row.drift_pp,
        }))
      : state.allocationMode === "accounts"
        ? data.accountViews.map((row) => ({
            identity: row.id,
            key: state.privacy ? I.hidden : row.name,
            value: row.value,
            weight: row.share,
            target: null,
            drift: null,
          }))
        : (state.allocationMode === "classes"
            ? data.allocation.by_asset_class
            : data.allocation.by_region
          ).map((row) => ({
            ...row,
            key: state.allocationLabel(
              state.allocationMode === "classes" ? "classes" : "regions",
              row.key,
            ),
            identity: row.key,
            target: null,
            drift: null,
          }));
  return (
    <Card>
      <h2>{I.allocation}</h2>
      <div className="flex flex-wrap gap-2 py-3">
        {(
          [
            ["buckets", I.buckets],
            ["classes", I.classes],
            ["regions", I.regions],
            ["accounts", I.accounts],
          ] as const
        ).map(([mode, label]) => (
          <button
            type="button"
            key={mode}
            className={investmentButton}
            aria-pressed={state.allocationMode === mode}
            onClick={() => state.setAllocationMode(mode)}
          >
            {label}
          </button>
        ))}
      </div>
      <Donut
        label={I.allocation}
        segments={rows.map((row, index) => ({
          name: row.key,
          value: row.value?.toFloat() ?? 0,
          color: ((index % 8) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
        }))}
        onSegmentSelected={(index) => {
          if (state.allocationMode === "accounts") {
            const row = data.accountViews[index];
            if (row) state.setAccount(row.id);
          }
        }}
      />
      <table className="w-full text-caption">
        <thead>
          <tr>
            <th>{I.name}</th>
            <th>{I.value}</th>
            <th>{I.weight}</th>
            <th>{I.target}</th>
            <th>{I.drift}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.identity}>
              <th>{row.key}</th>
              <td>
                <Money value={state.money(row.value)} />
              </td>
              <td>
                <Percent value={ratio(row.weight)} />
              </td>
              <td>
                <Percent value={ratio(row.target)} />
              </td>
              <td>
                <Amount value={ratio(row.drift)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function PerformanceTable({ state }: { state: PortfolioScreenState }) {
  const ref = useRef<HTMLDivElement>(null);
  const points = state.portfolio.status === "ready" ? state.portfolio.performance.points : [];
  const virtual = useVirtualRows({
    count: points.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 48,
    overscan: 5,
  });
  const large = points.length > 50;
  const items = large ? virtual.items : points.map((_, index) => ({ index, start: 0 }));
  return (
    <div ref={ref} className="max-h-72 overflow-auto">
      <table aria-label={I.performance} aria-rowcount={points.length + 1} className="grid w-full">
        <thead>
          <tr className="grid grid-cols-4">
            <th>{I.date}</th>
            <th>{I.value}</th>
            <th>{I.contributions}</th>
            <th>{I.twr}</th>
          </tr>
        </thead>
        <tbody className="relative block" style={large ? { height: virtual.totalSize } : undefined}>
          {items.map((item) => {
            const point = points[item.index];
            return !point ? null : (
              <tr
                key={point.date}
                aria-rowindex={item.index + 2}
                className={`${large ? "absolute left-0 top-0 " : ""}grid h-12 w-full grid-cols-4`}
                style={large ? { transform: `translateY(${item.start}px)` } : undefined}
              >
                <td>
                  <DateText value={point.date} />
                </td>
                <td>
                  <Money
                    value={
                      point.value === null
                        ? null
                        : new MoneyValue(D(String(point.value)), state.base)
                    }
                  />
                </td>
                <td>
                  <Money
                    value={
                      point.contributions === null
                        ? null
                        : new MoneyValue(D(String(point.contributions)), state.base)
                    }
                  />
                </td>
                <td>
                  <Percent value={ratio(point.twr)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatOptional(value: number | null | undefined, format: (value: number) => string) {
  return value == null ? "-" : format(value);
}
