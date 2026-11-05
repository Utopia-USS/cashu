// The investments widgets of Przegląd (ab24ab6 modules/investments/v2/Overview.tsx): Inwestycje (YTD vs the
// benchmark, chances, risks, the 12-month line) and Nadwyżka -> wpłata (the month's surplus, the plan, what stays,
// the cushion / bucket checks and the plan action). Pure: the models come from investmentsModel.ts.
import { Button, Fact, FactFlow, LineChart, Skeleton, Tag, TextField, Widget } from "@cashu/ui";
import type { InvestmentsSummaryModel, SurplusModel } from "./investmentsModel.js";
import { FootFacts, RichText } from "./OverviewWidgetsView.js";

export function InvestmentsSummaryWidgetView({ m }: { m: InvestmentsSummaryModel }) {
  return (
    <Widget
      title={m.title}
      count={m.count ?? undefined}
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
      <Widget title={m.title} tight>
        {loading ? <Skeleton height={70} /> : <div className="text-sm text-fg-muted">{m.text}</div>}
      </Widget>
    );
  const a = m.actions;
  return (
    <Widget
      title={m.title}
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
    </Widget>
  );
}
