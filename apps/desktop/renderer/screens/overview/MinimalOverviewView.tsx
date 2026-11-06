// The overview of an investments-only profile (ab24ab6 v2/Overview.tsx MinimalOverview, ia-v2.md 9) on the old
// grid: the `.w.hero` (portfolio of the month, the result since the first deposit, Wpłacono / Benchmark / Następna
// wpłata, the holdings tag and the quiet line), the six-month Wpłaty bars and Na ten miesiąc (`.steps-v`). Pure.
import { S as I } from "@cashu/i18n/investments/v2/Overview.strings";
import { BarChart, Button, Grid, Hero, Tag, Widget } from "@cashu/ui";
import { W } from "./OverviewWidgets.strings.js";
import type { MinimalOverviewState } from "./useMinimalOverview.js";

const tones = { positive: "text-positive", negative: "text-negative" } as const;
// Old `.step`: 22px | text | action, gap 10, centred, 13px; `b.n` 22px disc 11px (chip, done positive, on accent);
// `.h` muted 12px.
const step = "grid grid-cols-[--spacing(5.5)_minmax(0,1fr)_auto] items-center gap-2.5 text-sm";
const disc = {
  todo: "bg-chip text-chip-fg",
  on: "bg-accent text-on-accent",
  done: "bg-positive text-on-accent",
} as const;
const discCls = (state: keyof typeof disc) =>
  `inline-flex size-5.5 items-center justify-center rounded-full text-2xs font-strong ${disc[state]}`;
const hint = "text-xs text-fg-muted";

function Disc({ state, text, label }: { state: keyof typeof disc; text: string; label?: string }) {
  return (
    <span>
      <b className={discCls(state)} aria-hidden>
        {text}
      </b>
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

export function MinimalOverviewView({ state }: { state: MinimalOverviewState }) {
  if (state.kind === "unavailable")
    return (
      <Grid
        items={[
          {
            id: "hero",
            span: 3,
            node: (
              <Widget title={I.portfolio} tight>
                <div className="text-sm text-fg-muted">{W.investmentUnavailable}</div>
              </Widget>
            ),
          },
        ]}
      />
    );
  const t = state.text;
  const c = state.current;
  return (
    <Grid
      items={[
        {
          id: "hero",
          span: 3,
          node: (
            <Hero
              label={I.portfolio}
              caption={state.heroLabel}
              value={<span data-testid="minimal-portfolio-value">{t.value}</span>}
              delta={
                t.pnl ? (
                  <>
                    <span className={tones[t.pnl.tone]}>{t.pnl.text}</span> {I.sinceFirstDeposit}
                  </>
                ) : undefined
              }
              facts={[
                {
                  label: I.deposited,
                  value: t.deposited,
                  ...(state.depositedDetail ? { detail: state.depositedDetail } : {}),
                },
                {
                  label: W.benchmark,
                  value: t.benchmark,
                  ...(state.benchmarkTitle ? { title: state.benchmarkTitle } : {}),
                  ...(state.benchmarkDetail ? { detail: state.benchmarkDetail } : {}),
                },
                {
                  label: I.nextDeposit,
                  value: t.due,
                  ...(state.nextDepositDetail ? { detail: state.nextDepositDetail } : {}),
                },
              ]}
              right={state.holdings !== null ? <Tag>{state.holdings}</Tag> : undefined}
              meta={state.quiet}
            />
          ),
        },
        {
          id: "deposits",
          span: 2,
          node: (
            <Widget
              title={I.depositsTitle}
              count={I.months6}
              controls={
                state.planCaption !== null ? (
                  <span className="text-xs text-fg-muted">{state.planCaption}</span>
                ) : undefined
              }
              tight
              footer={
                state.regularity !== null ? (
                  <span>
                    {I.regularity} <b>{state.regularity}</b>
                  </span>
                ) : (
                  <span />
                )
              }
            >
              <BarChart
                label={I.depositsChart}
                height={150}
                values={state.chart.values}
                labels={state.chart.labels}
                kinds={state.chart.kinds}
                valueLabels={state.chart.valueLabels}
                plan={state.chart.plan}
                {...(state.chart.planLabel === undefined
                  ? {}
                  : { planLabel: state.chart.planLabel })}
                valueKind="amount"
              />
            </Widget>
          ),
        },
        {
          id: "month",
          span: 1,
          node: (
            <Widget
              title={I.thisMonth}
              tight
              footer={
                <span>
                  <Button variant="link" size="md" onPress={state.onAddAlert}>
                    {I.addAlert}
                  </Button>
                  {" · "}
                  <Button variant="link" size="md" onPress={state.onWatchInstrument}>
                    {I.watchInstrument}
                  </Button>
                </span>
              }
            >
              <div className="grid gap-2.5">
                {state.previous !== null && (
                  <div className={step}>
                    <Disc state="done" text="✓" label={I.done} />
                    <div>
                      {state.previous.label}
                      <div className={hint}>{state.previous.detail}</div>
                    </div>
                    <span />
                  </div>
                )}
                <div className={step}>
                  <Disc
                    state={c.done ? "done" : "on"}
                    text={c.done ? "✓" : "2"}
                    label={c.deposited ? I.done : I.step2}
                  />
                  <div>
                    {c.label}
                    <div className={hint}>{c.detail}</div>
                  </div>
                  {c.canPlan ? (
                    <Button size="sm" disabled={state.busy} onPress={state.onPlan}>
                      {I.plan}
                    </Button>
                  ) : (
                    <span />
                  )}
                </div>
                <div className={step}>
                  <Disc state="todo" text="3" />
                  <div className="text-fg-muted">
                    {I.nothingMore}
                    <div className={hint}>{I.monthlyReviewEnough}</div>
                  </div>
                  <span />
                </div>
              </div>
            </Widget>
          ),
        },
      ]}
    />
  );
}
