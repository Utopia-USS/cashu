// The core tiles of Przegląd (ab24ab6 core/overview/CoreWidgets.tsx, loans LoansWidget) as layered tiles
// (design/desktop/overview/layered-tiles.html): Budżet · <month>, Subskrypcje, Konta, a module that is not set up
// (a ghost tile) and Kredyty. "Wartość netto w czasie" lives in the net worth tile (OverviewView.tsx).
// Pure: every string comes formatted from overviewModel.ts.
import { Button, emptyCls, Facts, MeterRows, Tag, tableCls, Widget } from "@cashu/ui";
import { Fragment } from "react";
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
/** A list table inside a layered tile: rows on the tile's own padding, 10px cells (the mockup's `.row`). */
export const tileTable = `${tableCls(false)} [&_td:first-child]:pl-0 [&_td:last-child]:pr-0`;
export const tileTd = "border-b border-border px-2 py-2.5 text-left align-middle";
export const tileNum =
  "border-b border-border px-2 py-2.5 text-right align-middle tabular-nums whitespace-nowrap";

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
      variant="quiet"
      layered
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
      {m.rows ? (
        <MeterRows rows={m.rows} className="mt-1" />
      ) : (
        <div className={emptyCls}>{m.empty}</div>
      )}
    </Widget>
  );
}

export function SubscriptionsWidgetView({ m }: { m: SubscriptionsModel }) {
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
        m.warn ? (
          <span className="inline-flex items-center gap-2 text-warning">
            <span aria-hidden className="size-1.5 rounded-full bg-warning" />
            {m.warn}
          </span>
        ) : undefined
      }
    >
      <Facts items={m.facts} columns={2} tile />
    </Widget>
  );
}

type AccountRow = AccountsModel["rows"][number];

/** One column of Konta: name over its bank line, the balance right. */
function AccountsTable({ rows }: { rows: readonly AccountRow[] }) {
  return (
    <table className={tileTable}>
      <tbody>
        {rows.map((a) => (
          <tr key={a.key}>
            <td className={tileTd}>
              <span className="font-demi">{a.name}</span>
              <span className={sym}>{a.sub}</span>
            </td>
            <td
              className={`${tileNum} font-heavy ${a.negative ? "text-negative" : ""} ${a.muted ? "text-fg-muted" : ""}`}
            >
              {a.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AccountsWidgetView({ m }: { m: AccountsModel }) {
  const half = Math.ceil(m.rows.length / 2);
  return (
    <Widget
      title={m.title}
      count={m.count ?? undefined}
      variant="quiet"
      layered
      controls={
        m.toggle ? (
          <Button variant="link" onPress={m.toggle.onPress}>
            {m.toggle.label}
          </Button>
        ) : undefined
      }
      tight
    >
      {m.empty ? (
        <div className={emptyCls}>{m.empty}</div>
      ) : (
        <div className="grid grid-cols-2 items-start gap-x-7 max-narrow:grid-cols-1">
          <AccountsTable rows={m.rows.slice(0, half)} />
          {m.rows.length > half && <AccountsTable rows={m.rows.slice(half)} />}
        </div>
      )}
      {m.wallet ? (
        <div className="tile-sub mt-3 flex flex-wrap items-center gap-2.5 px-3.5 py-2 text-xs-plus text-fg-secondary [&_b]:font-heavy [&_b]:text-fg [&_b]:tabular-nums">
          <span>
            <RichText runs={m.wallet} />
          </span>
          <Spacer />
          <Button size="sm" onPress={m.cash.onPress}>
            {m.cash.label}
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex justify-end">
          <Button size="sm" onPress={m.cash.onPress}>
            {m.cash.label}
          </Button>
        </div>
      )}
    </Widget>
  );
}

export function PendingWidgetView({ m }: { m: PendingModel }) {
  return (
    <Widget
      title={m.title}
      variant="quiet"
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

export function LoansWidgetView({ m }: { m: LoansModel }) {
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
        <table className={tileTable}>
          <tbody>
            {m.rows.map((l) => (
              <tr key={l.key}>
                <td className={tileTd}>
                  <span className="font-demi">{l.name}</span>
                  <span className={sym}>{l.meta}</span>
                </td>
                <td className={`${tileNum} font-heavy text-negative`}>
                  {l.value}
                  {l.sub && <span className={`${sym} font-regular`}>{l.sub}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Widget>
  );
}
