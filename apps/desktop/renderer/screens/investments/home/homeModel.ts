// The investments Home's head, hero and empty-state props (ab24ab6 v2/Home.tsx:435-511, Start :613-659), the
// formatting part: tags, figures, facts and the first-steps list, so HomeView stays pure.
import { S } from "@cashu/i18n/investments/v2/Home.strings";
import { localDay } from "@cashu/ui-logic/core/time";
import {
  accountLabel,
  dm,
  hm,
  money,
  money0,
  pct,
  pp,
  WEEKDAYS,
  wdm,
} from "@cashu/ui-logic/investments/labels";
import { runError } from "@cashu/ui-logic/investments/logic";
import type { StrategyStatus } from "@cashu/ui-logic/investments/types";
import { weekMove } from "@cashu/ui-logic/investments/v2/homeLogic";
import {
  benchmarkLabel,
  contributionFacts,
  daysSince,
  monthlyFlows,
  staleBenchmark,
} from "@cashu/ui-logic/investments/v2/logic";
import type { OverviewV2, Performance, PositionsV2 } from "@cashu/ui-logic/investments/v2/types";

type Tone = "positive" | "negative";

export interface HeadModel {
  /** The account Seg (only with more than one account). */
  accounts: { items: [string, number | null][]; value: number | null } | null;
  prices: { text: string; title?: string } | null;
  /** The stale-prices tag (a button to the Rachunki view). */
  stale: { text: string; title: string } | null;
  /** The daily check's tag: only when it runs or is not ok. */
  rules: { text: string; title?: string; warn: boolean } | null;
  /** `Dodaj transakcję` next to Import (empty portfolio only). */
  addTxn: boolean;
}

export function headModel(input: {
  overview: OverviewV2;
  filter: number | null;
  hasData: boolean;
  today: string;
  /** The host worker's quote refresh / daily check of this vault in flight. */
  running: { prices: boolean; rules: boolean };
}): HeadModel {
  const { overview, hasData, today } = input;
  const accounts = overview.accounts;
  const fr = overview.freshness;
  const stale = fr.prices.stale_count;
  const last = overview.kpis.last_run;
  const runAt = last ? (last.finished_at ?? last.started_at) : null;
  const runDay = runAt ? (localDay(runAt) === today ? S.today : dm(runAt)) : null;
  const when = runAt ? `${runDay} ${hm(runAt)}` : "";
  const why = last?.errors[0] ? ` · ${runError(last.errors[0])}` : "";
  return {
    accounts:
      accounts.length > 1
        ? {
            items: [
              [S.all, null],
              ...accounts.map((a) => [accountLabel(a, accounts), a.id] as [string, number]),
            ],
            value: input.filter,
          }
        : null,
    prices: hasData
      ? input.running.prices
        ? { text: S.refreshingPrices }
        : fr.prices.newest_bar
          ? { text: S.prices(wdm(fr.prices.newest_bar)), title: S.newestQuote }
          : { text: S.noQuotes }
      : null,
    stale:
      stale > 0
        ? {
            text: S.staleCount(stale),
            title: fr.prices.stale
              .map(
                (s) => `${s.label}: ${s.price_date ? S.lastQuote(dm(s.price_date)) : S.noQuotes}`,
              )
              .join("\n"),
          }
        : null,
    rules: !hasData
      ? null
      : input.running.rules
        ? { text: S.rulesRunning, title: S.runTitle, warn: false }
        : last?.status === "partial"
          ? { text: S.rulesPartial, title: `${when}${why}`, warn: true }
          : last?.status === "failed"
            ? { text: S.rulesFailed, title: `${when}${why}${S.previousRunSignals}`, warn: true }
            : !last
              ? { text: S.rulesNeverRan, warn: false }
              : null,
    addTxn: !hasData,
  };
}

export interface HeroFact {
  label: string;
  value: string;
  title?: string;
  /** Plain muted detail. */
  detail?: string;
  /** Detail with a toned excess in percentage points (`MSCI ACWI -0,5 % · -0,8 pp`). */
  bench?: { lead: string; pp: { text: string; tone: Tone } | null };
}

export interface HeroModel {
  value: string;
  week: { text: string; tone: Tone } | null;
  facts: HeroFact[];
}

export function heroModel(input: {
  overview: OverviewV2;
  base: string;
  today: string;
  perf1y: Performance | null | undefined;
  perfYtd: Performance | null | undefined;
  perf1m: Performance | null | undefined;
  strategy: StrategyStatus | null | undefined;
  /** The light grid keeps its Wpłaty widget: no Obsunięcie / Wpłaty facts in the hero (Home.tsx:488). */
  light?: boolean;
}): HeroModel {
  const { overview, base, today } = input;
  const k = overview.kpis;
  const ytd = input.perfYtd;
  const ybStale = staleBenchmark(ytd?.benchmark);
  const yb = ytd?.benchmark?.status === "ok" && !ybStale ? ytd.benchmark : null;
  const week = input.perf1m ? weekMove(input.perf1m.points, input.perf1m.as_of) : null;
  const ddPts = input.perf1y?.points ?? [];
  const ddNow = ddPts.length ? (ddPts[ddPts.length - 1]?.drawdown ?? null) : null;
  const ddMax = input.perf1y?.summary?.max_drawdown?.depth ?? null;
  const contributions = input.strategy?.facts?.contributions;
  const planAmount = contributions?.monthly_amount ?? null;
  const plan =
    planAmount != null ? { amount: planAmount, day: contributions?.day_of_month ?? null } : null;
  const contrib = contributionFacts({
    months: monthlyFlows(ddPts, today, 12),
    deposits: ytd?.summary?.deposits ?? null,
    plan,
    firstDeposit: ddPts.find((p) => (p.flow ?? 0) > 0)?.date ?? null,
    today,
  });
  const facts: HeroFact[] = [];
  const ytdFact: HeroFact = {
    label: S.ytd,
    value: ytd?.summary?.twr != null ? pct(ytd.summary.twr, true) : "-",
  };
  if (ybStale) {
    ytdFact.title = ybStale.title;
    ytdFact.detail = ybStale.label;
  } else if (yb?.twr != null) {
    ytdFact.bench = {
      lead: `${benchmarkLabel(yb)} ${pct(yb.twr, true)}`,
      pp:
        yb.excess_twr != null
          ? { text: pp(yb.excess_twr * 100), tone: yb.excess_twr >= 0 ? "positive" : "negative" }
          : null,
    };
  } else if (ytd === null) ytdFact.detail = S.noHistory;
  facts.push(ytdFact);
  facts.push({
    label: S.unrealized,
    value: money0(k.unrealized.amount, base, true),
    detail: k.unrealized.pct != null ? S.vsCost(pct(k.unrealized.pct, true)) : S.costUnknown,
  });
  // The light grid keeps its Wpłaty widget: no duplicate facts there.
  if (!input.light && ddNow != null)
    facts.push({
      label: S.drawdown,
      value: pct(ddNow),
      title: S.drawdownTitle,
      ...(ddMax != null ? { detail: S.max(pct(ddMax)) } : {}),
    });
  if (!input.light && input.perf1y !== undefined)
    facts.push({
      label: S.contributions,
      value: contrib.deposits != null ? money0(contrib.deposits, base) : "-",
      title: S.thisYear,
      detail:
        contrib.planYtd != null
          ? `${S.plan(money0(contrib.planYtd, base))}${contrib.missed ? S.missedMonths(contrib.missed) : ""}`
          : S.noPlan,
    });
  return {
    value: money(k.value.total, base),
    week: week
      ? {
          text: `${money(week.money, base, true)}${week.pct != null ? ` (${pct(week.pct, true)})` : ""}`,
          tone: week.money >= 0 ? "positive" : "negative",
        }
      : null,
    facts,
  };
}

/** Minimal profile density (Home.tsx:204-205, ia-v2.md 9): at most one position, no signals, no alerts, under six
 * months of history and no allocation buckets; widgets appear when their data does. */
export function lightOf(input: {
  positions: PositionsV2 | undefined;
  signals: number;
  alerts: number;
  perf1y: Performance | null | undefined;
  overview: OverviewV2 | undefined;
  today: string;
}): boolean {
  const first = input.perf1y?.points[0]?.date;
  const historyMonths = first ? daysSince(first, input.today) / 30.4 : 0;
  return (
    !!input.positions &&
    input.positions.positions.length <= 1 &&
    !input.signals &&
    !input.alerts &&
    historyMonths < 6 &&
    !input.overview?.allocation.buckets.length
  );
}

/** Empty portfolio: no positions and no non-zero cash (Home.tsx:177). */
export const hasDataOf = (positions: PositionsV2 | undefined): boolean =>
  !!positions && (positions.positions.length > 0 || positions.cash.some((c) => c.amount !== 0));

interface StartAction {
  label: string;
  primary: boolean;
  disabled?: boolean;
  onPress(): void;
}
interface StartStep {
  key: string;
  status: "done" | "on" | "todo";
  title: string;
  hint?: string;
  /** The strategy hint (`strategy.yaml` or the interview `/investments-setup`), rendered with code spans. */
  strategyHint?: boolean;
  tag?: { text: string; tone: "positive" | "info" };
  actions: StartAction[];
}
export interface StartModel {
  steps: StartStep[];
  /** The `cashu ... accounts add` command line (no account yet). */
  command: string | null;
}

export function startModel(input: {
  slug: string;
  accounts: OverviewV2["accounts"];
  strategy: StrategyStatus | null;
  hasTxn: boolean;
  initBusy: boolean;
  onAddAccount(): void;
  onInitStrategy(): void;
  onGuide(): void;
  onAddTxn(): void;
}): StartModel {
  const { accounts, strategy } = input;
  const hasAccount = accounts.length > 0;
  const hasStrategy = !!strategy && strategy.state !== "missing";
  const weekday = strategy?.facts?.notifications.digest_weekday ?? "sunday";
  const day = (WEEKDAYS[weekday] ?? weekday).replace(/^./, (m) => m.toUpperCase());
  return {
    steps: [
      {
        key: "account",
        status: hasAccount ? "done" : "on",
        title: S.brokerageAccount,
        hint: hasAccount
          ? accounts.map((a) => `${accountLabel(a, accounts)} · ${a.currency}`).join(" · ")
          : S.brokerWrapper,
        actions: [
          {
            label: hasAccount ? S.addAnother : S.addAccount,
            primary: !hasAccount,
            onPress: input.onAddAccount,
          },
        ],
      },
      {
        key: "strategy",
        status: hasStrategy ? "done" : hasAccount ? "on" : "todo",
        title: S.strategy,
        tag: hasStrategy
          ? { text: strategy?.version != null ? `v${strategy.version}` : S.saved, tone: "positive" }
          : { text: S.recommended, tone: "info" },
        strategyHint: !hasStrategy,
        actions: hasStrategy
          ? []
          : [
              {
                label: input.initBusy ? S.creating : S.fromTemplate,
                primary: hasAccount,
                disabled: input.initBusy,
                onPress: input.onInitStrategy,
              },
              { label: S.claudeGuide, primary: false, onPress: input.onGuide },
            ],
      },
      {
        key: "txn",
        status: input.hasTxn ? "done" : hasStrategy ? "on" : "todo",
        title: S.firstTxn,
        hint: S.firstTxnHint,
        actions: hasAccount ? [{ label: S.addTxn, primary: false, onPress: input.onAddTxn }] : [],
      },
      { key: "review", status: "todo", title: S.firstReview, hint: S.weekly(day), actions: [] },
    ],
    command: hasAccount
      ? null
      : `cashu --profile ${input.slug} invest accounts add "XTB IKE" --broker xtb --wrapper ike`,
  };
}
