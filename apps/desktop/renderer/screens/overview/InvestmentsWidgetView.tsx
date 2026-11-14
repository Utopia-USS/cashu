// The investments tiles of Przegląd (ab24ab6 modules/investments/v2/Overview.tsx) as layered tiles
// (design/desktop/overview/layered-tiles.html): Inwestycje (YTD vs the benchmark, chances, risks, the 12-month
// line) and Nadwyżka -> wpłata (the month's surplus, the plan, what stays, the cushion / bucket checks, the plan
// action, the year's contributions as a ring and a 12-month strip). Pure: the models come from investmentsModel.ts.
import {
  Button,
  Donut,
  Fact,
  FactFlow,
  LineChart,
  Skeleton,
  Tag,
  TextField,
  Widget,
} from "@cashu/ui";
import type {
  InvestmentsSummaryModel,
  MonthState,
  SurplusModel,
  SurplusYear,
} from "./investmentsModel.js";
import { FootFacts, RichText } from "./OverviewWidgetsView.js";

export function InvestmentsSummaryWidgetView({ m }: { m: InvestmentsSummaryModel }) {
  return (
    <Widget
      title={m.title}
      count={m.count ?? undefined}
      variant="quiet"
      layered
      controls={
        <Button variant="link" onPress={m.link.onPress}>
          {m.link.label}
        </Button>
      }
      tight
      footer={
        <>
          {m.review && (
            <span>
              <RichText runs={m.review} />
            </span>
          )}
          <span className="flex-1" />
          <span>
            <RichText runs={m.rules} />
          </span>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-x-4.5 gap-y-3">
        {m.facts.map((f) => (
          <Fact
            key={String(f.label)}
            {...f}
            detail={
              typeof f.detail === "object" && f.detail !== null ? (
                <RichText runs={f.detail} />
              ) : (
                f.detail
              )
            }
          />
        ))}
      </div>
      {m.chart && (
        <div className="mt-2">
          <LineChart
            label={m.chart.label}
            height={96}
            yFormat={false}
            padR={8}
            yTicks={2}
            valueKind="amount"
            series={[{ values: m.chart.values, color: "accent", area: true }]}
          />
        </div>
      )}
    </Widget>
  );
}

export function SurplusWidgetView({ m, loading }: { m: SurplusModel; loading?: boolean }) {
  if (m.kind === "none")
    return (
      <Widget title={m.title} variant="quiet" layered tight>
        {loading ? <Skeleton height={70} /> : <div className="text-sm text-fg-muted">{m.text}</div>}
      </Widget>
    );
  const a = m.actions;
  return (
    <Widget
      title={m.title}
      variant="quiet"
      layered
      highlight={m.highlight}
      tags={<Tag>{m.tag}</Tag>}
      controls={
        <Button variant="link" onPress={m.link.onPress}>
          {m.link.label}
        </Button>
      }
      tight
      footer={
        <>
          <FootFacts items={m.foot} />
          <span className="flex-1" />
          <span>{m.footRight}</span>
        </>
      }
    >
      <FactFlow items={m.flow} />
      <div className="mt-3 text-xs-plus text-fg-muted">
        <RichText runs={m.checks} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {a.kind === "tag" ? (
          <Tag solid tone="positive">
            {a.text}
          </Tag>
        ) : a.kind === "buttons" ? (
          <>
            {a.primary && (
              <Button variant="primary" disabled={a.primary.disabled} onPress={a.primary.onPress}>
                {a.primary.label}
              </Button>
            )}
            <Button onPress={a.other.onPress}>{a.other.label}</Button>
          </>
        ) : (
          <>
            <TextField
              label={a.label}
              labelHidden
              autoFocus
              inputMode="decimal"
              value={a.value}
              onChange={a.onChange}
              onKeyDown={(event) => {
                if (event.key === "Enter") a.onEnter();
                if (event.key === "Escape") a.onEscape();
              }}
              className="w-27.5"
            />
            <Button variant="primary" disabled={a.plan.disabled} onPress={a.plan.onPress}>
              {a.plan.label}
            </Button>
            <Button variant="link" size="lg" onPress={a.cancel.onPress}>
              {a.cancel.label}
            </Button>
          </>
        )}
        {m.change && (
          <Button variant="link" size="lg" onPress={m.change.onPress}>
            {m.change.label}
          </Button>
        )}
      </div>
      {m.year && <YearView y={m.year} />}
    </Widget>
  );
}

const monthCls: Record<MonthState, string> = {
  on: "bg-fg-secondary",
  missed: "ring-1 ring-inset ring-warning",
  planned: "bg-accent-muted ring-1 ring-inset ring-accent",
  due: "ring-1 ring-inset ring-border-strong",
  ahead: "bg-chip",
  before: "bg-chip opacity-50",
};

/** The year's contributions against the plan: the covered share as a ring, the months as a strip (deposited,
 * missed, planned this month, still ahead), each month's state in its tooltip. */
function YearView({ y }: { y: SurplusYear }) {
  return (
    <div className="mt-4 flex items-center gap-4">
      {y.pct != null && (
        <Donut
          label={`${y.label}: ${y.text}`}
          size={64}
          thickness={7}
          gap={0}
          center={{ title: `${y.pct}%` }}
          segments={[
            { value: y.covered, color: "accent", name: y.text },
            { value: Math.max(0, y.due - y.covered), color: "muted", name: y.label },
          ]}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 text-xs text-fg-muted">{y.text}</div>
        <ul aria-label={y.label} className="m-0 grid list-none grid-cols-12 gap-0.75 p-0">
          {y.months.map((mo) => (
            <li
              key={mo.key}
              aria-label={mo.title}
              title={mo.title}
              className={`h-3.5 rounded-2xs ${monthCls[mo.state]}`}
            />
          ))}
        </ul>
        <div
          aria-hidden
          className="mt-1 grid grid-cols-12 gap-0.75 text-center text-4xs-plus text-fg-muted"
        >
          {y.months.map((mo) => (
            <span key={mo.key}>{mo.initial}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
