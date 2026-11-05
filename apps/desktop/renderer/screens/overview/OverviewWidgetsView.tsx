// The core widgets of Przegląd (ab24ab6 core/overview/CoreWidgets.tsx, NetWorthWidget.tsx, loans LoansWidget):
// Budżet · <month>, Subskrypcje, Konta, a module that is not set up, Wartość netto w czasie and Kredyty.
// Pure: every string comes formatted from overviewModel.ts / netWorthModel.ts.
import {
  AreaChart,
  Button,
  ChartLegend,
  emptyCls,
  Facts,
  LineChart,
  MeterRows,
  Seg,
  Select,
  Tag,
  tableCls,
  tdCls,
  Widget,
} from "@cashu/ui";
import { Fragment, type ReactNode } from "react";
import type { NetWorthWidgetModel, Scope } from "./netWorthModel.js";
import type {
  AccountsModel,
  BudgetMonthModel,
  LoansModel,
  PendingModel,
  Rich,
  SubscriptionsModel,
} from "./overviewModel.js";

const runTone = { positive: "text-positive", negative: "text-negative", warning: "text-warning" };
const sym = "block -mt-px text-2xs-plus text-fg-muted";
const symInl = "ml-1 inline text-2xs-plus text-fg-muted";

/** Text runs with the old inline `<b>` / `.pos` / `.neg` / `.warn` spans. */
export function RichText({ runs }: { runs: Rich }) {
  return (
    <>
      {runs.map((r, i) => {
        const cls = r.tone ? runTone[r.tone] : undefined;
        const key = `${i}:${r.text}`;
        if (r.bold)
          return (
            <b key={key} className={cls} title={r.title}>
              {r.text}
            </b>
          );
        return cls || r.title ? (
          <span key={key} className={cls} title={r.title}>
            {r.text}
          </span>
        ) : (
          <Fragment key={key}>{r.text}</Fragment>
        );
      })}
    </>
  );
}

/** Footer facts (old FootFacts): one span per fact. */
export function FootFacts({ items }: { items: readonly Rich[] }) {
  return (
    <>
      {items.map((runs) => (
        <span key={runs.map((r) => r.text).join("")}>
          <RichText runs={runs} />
        </span>
      ))}
    </>
  );
}

const Spacer = () => <span className="flex-1" />;

export function BudgetMonthWidgetView({ m }: { m: BudgetMonthModel }) {
  return (
    <Widget
      title={m.title}
      tags={
        m.tag ? (
          <Tag solid tone={m.tag.tone === "positive" ? "positive" : "neutral"}>
            {m.tag.text}
          </Tag>
        ) : undefined
      }
      controls={
        <Button variant="link" onPress={m.link.onPress}>
          {m.link.label}
        </Button>
      }
      tight
      footer={
        <>
          <FootFacts items={m.foot} />
          <Spacer />
          {m.others && <span>{m.others}</span>}
        </>
      }
    >
      {m.rows ? <MeterRows rows={m.rows} /> : <div className={emptyCls}>{m.empty}</div>}
    </Widget>
  );
}

export function SubscriptionsWidgetView({ m }: { m: SubscriptionsModel }) {
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
      footer={m.warn ? <span className="text-warning">{m.warn}</span> : undefined}
    >
      <Facts items={m.facts} columns={2} />
    </Widget>
  );
}

export function AccountsWidgetView({ m }: { m: AccountsModel }) {
  return (
    <Widget
      title={m.title}
      count={m.count ?? undefined}
      controls={
        m.toggle ? (
          <Button variant="link" onPress={m.toggle.onPress}>
            {m.toggle.label}
          </Button>
        ) : undefined
      }
      tight
      flush
      footer={
        <>
          {m.wallet && (
            <span>
              <RichText runs={m.wallet} />
            </span>
          )}
          <Spacer />
          <Button variant="link" size="sm" onPress={m.cash.onPress}>
            {m.cash.label}
          </Button>
        </>
      }
    >
      {m.empty ? (
        <div className={emptyCls}>{m.empty}</div>
      ) : (
        <table className={tableCls(true)}>
          <tbody>
            {m.rows.map((a) => (
              <tr key={a.key}>
                <td className={tdCls()}>
                  {a.name} <span className={symInl}>{a.sub}</span>
                </td>
                <td
                  className={`${tdCls(true)} ${a.negative ? "text-negative" : ""} ${a.muted ? "text-fg-muted" : ""}`}
                >
                  {a.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Widget>
  );
}

export function PendingWidgetView({ m }: { m: PendingModel }) {
  return (
    <Widget
      title={m.title}
      ghost
      tags={<Tag tone={m.tag.tone}>{m.tag.text}</Tag>}
      controls={
        <Button variant="link" onPress={m.hide.onPress}>
          {m.hide.label}
        </Button>
      }
      footer={
        <>
          <span>{m.steps}</span>
          <Spacer />
          <Button variant="primary" size="sm" onPress={m.cont.onPress}>
            {m.cont.label}
          </Button>
        </>
      }
    >
      <div className="text-sm text-fg-muted">{m.next}</div>
    </Widget>
  );
}

export function NetWorthWidgetView({ m }: { m: NetWorthWidgetModel }) {
  const chart = m.chart;
  let body: ReactNode;
  if (chart === null) body = <div className={emptyCls}>{m.empty}</div>;
  else if (chart.kind === "line")
    body = (
      <LineChart
        label={chart.label}
        height={230}
        padL={60}
        padR={110}
        yFormat={chart.yFormat}
        xLabels={chart.xLabels}
        valueKind="amount"
        series={[{ values: chart.values, color: "accent", area: true, endLabel: chart.endLabel }]}
        tooltip={chart.tooltip}
      />
    );
  else
    body = (
      <>
        <AreaChart
          label={chart.label}
          layers={chart.layers}
          totals={chart.totals}
          xLabels={chart.xLabels}
          yFormat={chart.yFormat}
          valueKind="amount"
          tooltip={chart.tooltip}
        />
        <ChartLegend className="mt-1.5" items={chart.legend} />
      </>
    );
  return (
    <Widget
      title={m.title}
      controls={
        <>
          <Seg
            quiet
            label={m.mode.label}
            items={m.mode.items}
            value={m.mode.value}
            onChange={m.mode.onChange}
          />
          <Select
            label={m.scope.label}
            labelHidden
            value={m.scope.value}
            onChange={(v) => m.scope.onChange(v as Scope)}
            options={m.scope.options}
          />
          <Seg
            quiet
            label={m.range.label}
            items={m.range.items}
            value={m.range.value}
            onChange={m.range.onChange}
          />
        </>
      }
      tight
      footer={
        <>
          <FootFacts items={m.foot} />
          <Spacer />
          <Seg
            quiet
            label={m.step.label}
            items={m.step.items}
            value={m.step.value}
            onChange={m.step.onChange}
          />
        </>
      }
    >
      {body}
    </Widget>
  );
}

export function LoansWidgetView({ m }: { m: LoansModel }) {
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
      flush
      footer={
        m.foot ? (
          <span>
            <RichText runs={m.foot} />
          </span>
        ) : undefined
      }
    >
      {m.empty ? (
        <div className={emptyCls}>{m.empty}</div>
      ) : (
        <table className={tableCls(true)}>
          <tbody>
            {m.rows.map((l) => (
              <tr key={l.key}>
                <td className={tdCls()}>
                  <span className="font-strong">{l.name}</span>
                  <span className={sym}>{l.meta}</span>
                </td>
                <td className={`${tdCls(true)} text-negative`}>
                  {l.value}
                  {l.sub && <span className={sym}>{l.sub}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Widget>
  );
}
