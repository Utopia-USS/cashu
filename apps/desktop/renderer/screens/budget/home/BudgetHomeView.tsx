// The budget as one screen (design/desktop/budget/one-screen.html): the period bar on top (Month / Quarter /
// Year / All, the stepper, the currency switch), then a main column (the surplus hero with its income /
// spending chart, the spending donut with its category rows, the drilled category's transactions) beside a
// rail that scrolls with the page (subscriptions, after the month, uncategorized merchants). Layered tiles as
// on the Overview. Pure.

import { S as H } from "@cashu/i18n/budget/BudgetHome.strings";
import { S as E } from "@cashu/i18n/budget/Expenses.strings";
import { S as MC } from "@cashu/i18n/budget/MonthClose.strings";
import {
  Button,
  MeterRows,
  Seg,
  Select,
  Skeleton,
  Spinner,
  StatementFigure,
  Tag,
  Widget,
} from "@cashu/ui";
import { type ReactNode, useState } from "react";
import { AfterMonthTile, SubscriptionsTile, UncategorizedTile } from "./BudgetRailView.js";
import type { PeriodMode } from "./budgetHomeModel.js";
import type {
  BudgetHomeState,
  CurrencyState,
  DrillState,
  HeroState,
  PeriodBarState,
  SliceState,
  SpendingState,
} from "./budgetHomeState.js";
import { CashflowBars } from "./CashflowBars.js";
import { useLingeringHover } from "./motion.js";
import { SpendingRing } from "./SpendingRing.js";
import { QuietLink, Rise, rowDelay, rowIn } from "./tileParts.js";

const PREV = "‹";
const NEXT = "›";
const CLOSE = "✕";
const CHEVRON = "›";

export interface BudgetHomeViewProps {
  state: BudgetHomeState;
  /** The other currencies' surplus links of the hero ("Też w EUR: ..."), one bound part per currency
   * (`OtherSurplusLink` each). */
  otherCurrencies?: ReactNode;
}

export function BudgetHomeView({ state, otherCurrencies = null }: BudgetHomeViewProps) {
  return (
    <div className="text-md leading-widget">
      <PeriodBar period={state.period} currency={state.currency} />
      <div className="grid grid-cols-[minmax(0,1fr)_--spacing(88)] items-start gap-3.5 max-wide:grid-cols-[minmax(0,1fr)_--spacing(75)] max-story:grid-cols-1">
        <div className="grid min-w-0 gap-3.5">
          <Rise i={0}>
            <HeroTile hero={state.hero} others={otherCurrencies} />
          </Rise>
          <Rise i={2}>
            <SpendingTile spending={state.spending} />
          </Rise>
          {state.drill && (
            <Rise i={3}>
              <DrillTile drill={state.drill} />
            </Rise>
          )}
        </div>
        <div className="grid min-w-0 gap-3.5">
          <Rise i={1}>
            <SubscriptionsTile subs={state.subscriptions} />
          </Rise>
          {state.afterMonth && (
            <Rise i={4}>
              <AfterMonthTile after={state.afterMonth} />
            </Rise>
          )}
          {state.uncategorized && (
            <Rise i={5}>
              <UncategorizedTile uncat={state.uncategorized} />
            </Rise>
          )}
        </div>
      </div>
    </div>
  );
}

function PeriodBar({ period, currency }: { period: PeriodBarState; currency: CurrencyState }) {
  return (
    <div className="mt-5 mb-4 flex min-h-8 flex-wrap items-center gap-2.5">
      <Seg<PeriodMode>
        quiet
        label={H.period}
        items={[
          [E.month, "month"],
          [E.quarter, "quarter"],
          [E.year, "year"],
          [E.all, "all"],
        ]}
        value={period.mode}
        onChange={period.setMode}
      />
      {period.stepHidden ? (
        <span className="px-2 text-base-plus font-heavy tracking-snug">{period.label}</span>
      ) : (
        <span className="inline-flex items-center gap-0.5">
          <Button
            variant="glyph"
            label={H.prevPeriod}
            disabled={period.prevDisabled}
            onPress={() => period.step(-1)}
          >
            <span className="px-1 text-lg leading-dense">{PREV}</span>
          </Button>
          <span className="min-w-29 text-center text-base-plus font-heavy tracking-snug">
            {period.label}
          </span>
          <Button
            variant="glyph"
            label={H.nextPeriod}
            disabled={period.nextDisabled}
            onPress={() => period.step(1)}
          >
            <span className="px-1 text-lg leading-dense">{NEXT}</span>
          </Button>
        </span>
      )}
      {period.inProgress && <Tag tone="info">{MC.inProgress}</Tag>}
      <span className="flex-1" />
      {currency.codes.length > 1 && (
        <Seg<string>
          quiet
          label={MC.currency}
          items={currency.codes.map((c) => [c, c] as const)}
          value={currency.value}
          onChange={currency.set}
        />
      )}
    </div>
  );
}

/** The surplus hero: label, the figure (currency code small, decimals dimmed), how it compares, the income /
 * spent / kept meters, the chart that picks the period, its legend and other currencies' surplus. */
function HeroTile({ hero, others }: { hero: HeroState; others: ReactNode }) {
  return (
    <Widget title={hero.label} variant="quiet" layered still tight>
      <div className="grid grid-cols-[minmax(0,1fr)_--spacing(75)] items-end gap-7 max-wide:grid-cols-1 max-wide:gap-4.5">
        <div className="min-w-0">
          <div className={`mt-1 ${hero.negative ? "[&>span>span]:text-negative" : ""}`}>
            <span data-testid="budget-surplus">
              <StatementFigure size="tile" value={hero.value} />
            </span>
          </div>
          {hero.sub && (
            <div className="mt-2.5 flex min-h-5 flex-wrap items-center gap-x-2.5 text-xs-plus text-fg-muted">
              {hero.sub.delta && (
                <span
                  className={`font-strong tabular-nums ${hero.sub.positive ? "text-positive" : "text-negative"}`}
                >
                  {hero.sub.delta}
                </span>
              )}
              <span>{hero.sub.text}</span>
            </div>
          )}
        </div>
        <MeterRows rows={hero.meters} />
      </div>
      {hero.chart && <CashflowBars chart={hero.chart} />}
      <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-2xs-plus text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="size-2 rounded-4xs bg-positive" />
          {hero.legend.income}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="size-2 rounded-4xs bg-negative" />
          {hero.legend.spent}
        </span>
        <span className="flex-1" />
        {others}
      </div>
    </Widget>
  );
}

/** The spending donut and its category rows (name, a short bar in the category colour, amount, share). A row
 * or a segment opens the category's transactions; the folded "Reszta" row opens its members. */
function SpendingTile({ spending }: { spending: SpendingState }) {
  const [hover, setHover] = useLingeringHover();
  const [restOpen, setRestOpen] = useState(false);
  const pick = (s: SliceState) => {
    if (s.members) setRestOpen((open) => !open);
    else spending.select(s.key);
  };
  return (
    <Widget title={spending.title} variant="quiet" layered tight>
      {spending.empty ? (
        <div className="py-6 text-sm text-fg-muted">{spending.empty}</div>
      ) : (
        <div className="mt-2.5 grid grid-cols-[--spacing(54)_minmax(0,1fr)] items-center gap-9 max-wide:gap-6 max-narrow:grid-cols-1 max-narrow:justify-items-center">
          <SpendingRing
            slices={spending.slices}
            total={spending.total}
            label={spending.label}
            hover={hover}
            onHover={setHover}
            selected={spending.selected}
            onPick={pick}
          />
          <div className="-mx-2.5 grid min-w-0">
            {spending.slices.map((s, k) => (
              <div key={s.key}>
                <CategoryRow
                  slice={s}
                  k={k}
                  on={spending.selected === s.key || (s.members !== undefined && restOpen)}
                  hovered={hover === s.key}
                  onHover={setHover}
                  onPress={() => pick(s)}
                  expandable={s.members !== undefined}
                />
                {s.members && restOpen && (
                  <div className="ml-3 border-l border-border pl-1">
                    {s.members.map((m, j) => (
                      <CategoryRow
                        key={m.key}
                        slice={m}
                        k={j}
                        on={spending.selected === m.key}
                        hovered={false}
                        onHover={() => setHover(s.key)}
                        onPress={() => spending.select(m.key)}
                        muted
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Widget>
  );
}

function CategoryRow({
  slice,
  k,
  on,
  hovered,
  onHover,
  onPress,
  expandable = false,
  muted = false,
}: {
  slice: SliceState;
  k: number;
  on: boolean;
  hovered: boolean;
  onHover(key: string | null): void;
  onPress(): void;
  expandable?: boolean;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={expandable ? undefined : on}
      aria-expanded={expandable ? on : undefined}
      onClick={onPress}
      onPointerEnter={() => onHover(slice.key)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover(slice.key)}
      onBlur={() => onHover(null)}
      className={`grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_--spacing(19)_--spacing(24)_--spacing(9)_--spacing(3.5)] items-center gap-3.5 rounded-button-lg border-0 px-2.5 py-2 text-left transition-colors max-wide:grid-cols-[minmax(0,1fr)_--spacing(14)_--spacing(22.5)_--spacing(8.5)_--spacing(3.5)] max-wide:gap-2.5 ${on ? "bg-fg/5" : hovered ? "bg-fg/3" : "bg-transparent hover:bg-fg/3"} ${rowIn}`}
      style={rowDelay(k)}
    >
      <span className={`truncate font-demi ${muted ? "text-fg-secondary" : "text-fg"}`}>
        {slice.label}
      </span>
      <span className="h-1.25 overflow-hidden rounded-2xs bg-chip">
        <i
          className="block h-full rounded-2xs"
          style={{ width: `${Math.max(2, slice.fill)}%`, background: slice.color }}
        />
      </span>
      <span className="whitespace-nowrap text-right font-heavy tabular-nums">{slice.amount}</span>
      <span className="text-right text-xs text-fg-muted tabular-nums">{slice.share}</span>
      <span
        aria-hidden
        className={`text-fg-muted transition-transform duration-200 ease-tile ${on ? "rotate-90 text-fg-secondary" : ""}`}
      >
        {CHEVRON}
      </span>
    </button>
  );
}

/** The drilled category's transactions: newest or largest first, the category select per row (a change toasts
 * "Wszystkie od ..."), the first 8 and "Pokaż wszystkie n". */
function DrillTile({ drill }: { drill: DrillState }) {
  return (
    <Widget
      title={
        <span className="inline-flex items-center gap-2 text-md font-strong text-fg">
          <i aria-hidden className="size-2.5 rounded-3xs" style={{ background: drill.color }} />
          {drill.label}
        </span>
      }
      label={drill.label}
      tags={
        <span className="inline-flex items-center gap-2 text-sm text-fg-muted">
          {drill.meta}
          {drill.busy && <Spinner />}
        </span>
      }
      controls={
        <>
          <Seg<"date" | "amount">
            quiet
            label={drill.sortLabel}
            items={drill.sortItems}
            value={drill.sort}
            onChange={drill.setSort}
          />
          <Button variant="glyph" label={drill.closeLabel} onPress={drill.close}>
            <span className="px-1">{CLOSE}</span>
          </Button>
        </>
      }
      variant="quiet"
      layered
      still
      tight
    >
      {drill.rows.length === 0 ? (
        <div className="py-4 text-sm text-fg-muted">{drill.empty}</div>
      ) : (
        <div className="grid">
          {drill.rows.map((r, k) => (
            <div
              key={r.key}
              className={`grid grid-cols-[--spacing(13.5)_minmax(0,1fr)_--spacing(29.5)_--spacing(25)_--spacing(36)] items-center gap-3.5 border-t border-border py-2.5 first:border-t-0 max-wide:grid-cols-[--spacing(13.5)_minmax(0,1fr)_--spacing(25)_--spacing(36)] ${rowIn}`}
              style={rowDelay(k)}
            >
              <span className="text-xs text-fg-muted tabular-nums">{r.date}</span>
              <span className="min-w-0">
                <b className="block truncate font-demi">{r.merchant}</b>
                {r.details && (
                  <span className="block truncate text-2xs-plus text-fg-muted">{r.details}</span>
                )}
              </span>
              <span className="truncate text-xs text-fg-muted max-wide:hidden">{r.account}</span>
              <span
                className={`whitespace-nowrap text-right font-heavy tabular-nums ${r.negative ? "" : "text-positive"}`}
              >
                {r.amount}
              </span>
              <Select
                compact
                label={drill.categoryLabel}
                labelHidden
                className="justify-self-end"
                value={r.category}
                disabled={drill.busy}
                options={drill.options}
                onChange={(category) => drill.markCategory(r.key, category)}
              />
            </div>
          ))}
        </div>
      )}
      {drill.more && (
        <div className="mt-2">
          <QuietLink onPress={drill.more.onPress}>{drill.more.label}</QuietLink>
        </div>
      )}
    </Widget>
  );
}

/** First load: the layout's tiles as skeletons (one reveal for the whole screen). */
export function BudgetHomeLoadingView() {
  return (
    <div className="text-md leading-widget">
      <div className="mt-5 mb-4 flex items-center gap-2.5">
        <Skeleton width={260} height={28} />
        <Skeleton width={150} height={28} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_--spacing(88)] items-start gap-3.5 max-wide:grid-cols-[minmax(0,1fr)_--spacing(75)] max-story:grid-cols-1">
        <div className="grid min-w-0 gap-3.5">
          <Widget title={null} variant="quiet" layered still>
            <Skeleton height={330} />
          </Widget>
          <Widget title={null} variant="quiet" layered still>
            <Skeleton height={260} />
          </Widget>
        </div>
        <div className="grid min-w-0 gap-3.5">
          <Widget title={null} variant="quiet" layered still>
            <Skeleton height={300} />
          </Widget>
          <Widget title={null} variant="quiet" layered still>
            <Skeleton height={200} />
          </Widget>
        </div>
      </div>
    </div>
  );
}
