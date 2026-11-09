// The investments widgets of Przegląd (ab24ab6 modules/investments/v2/Overview.tsx): the hero fact, the
// Inwestycje widget and the Nadwyżka -> wpłata card, from the old shapes of useOverviewInvestments.
import { C as CM } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/investments/v2/Overview.strings";
import type { FlowFact } from "@cashu/ui";
import { MONTH_NOM } from "@cashu/ui-logic/core/format";
import { addDays } from "@cashu/ui-logic/core/time";
import {
  bucketLabel,
  dm,
  isoDate,
  money0,
  parseNum,
  pct,
  pp,
  WEEKDAYS,
} from "@cashu/ui-logic/investments/labels";
import { nextDeposit } from "@cashu/ui-logic/investments/logic";
import {
  allocGeneric,
  benchmarkLabel,
  changeSince,
  contributionPp,
  isDigestDay,
  monthlyFlows,
  perfNotes,
  planForMonth,
  planMonthsSoFar,
  polarityOf,
  staleBenchmark,
  surplusFlow,
} from "@cashu/ui-logic/investments/v2/logic";
import type { Link, Rich, RichFact } from "./overviewModel.js";
import type { OverviewInvestments, PlanRow } from "./useOverviewInvestments.js";

const tone = (v: number) => (v >= 0 ? "positive" : "negative");

/** Hero fact: the portfolio value, the week's change and chances / risks (InvestmentsHeroFact). */
export function investmentsHeroFact(inv: OverviewInvestments): RichFact {
  const k = inv.ov.data?.kpis;
  if (!k || !inv.ov.data) return { label: S.investments, value: "-" };
  const c = inv.ov.data.base_currency;
  const p = inv.perf1m.data;
  const week = p ? changeSince(p.points, addDays(p.as_of, -7)).pct : null;
  const pol = k.polarity;
  const detail: Run[] = [];
  if (week != null)
    detail.push({ text: pct(week, true), tone: tone(week) }, { text: ` ${S.week} · ` });
  detail.push({
    text: pol
      ? `${S.chances(pol.positive)} · ${S.risks(pol.negative + pol.neutral)}`
      : S.signalsCount(k.signals.action + k.signals.info),
  });
  // The portfolio in the investments base currency (converted); net worth counts the same accounts per
  // currency without conversion, so the tooltip says why the figures do not add up.
  return {
    label: S.investments,
    value: money0(k.value.total, c),
    title: S.portfolioTitle(c),
    detail,
  };
}
type Run = Rich[number];

export interface InvestmentsSummaryModel {
  title: string;
  count: string | null;
  link: Link;
  facts: RichFact[];
  chart: { label: string; values: number[] } | null;
  review: Rich | null;
  rules: Rich;
}

/** Inwestycje widget: YTD vs benchmark, chances, risks, the 12-month value line. */
export function investmentsSummaryModel(
  inv: OverviewInvestments,
  today: string,
  open: () => void,
): InvestmentsSummaryModel {
  const open$ = (inv.sig.data ?? []).filter((s) => !s.snoozed);
  const chances = open$.filter((s) => polarityOf(s) === "positive");
  const risks = open$.filter((s) => polarityOf(s) !== "positive");
  const names = (l: typeof open$) =>
    [
      ...new Set(
        l
          .map((s) =>
            String(
              (s.payload.symbol as string) ||
                s.instrument_label ||
                bucketLabel(s.payload.bucket_id as string) ||
                "",
            ),
          )
          .filter(Boolean),
      ),
    ]
      .slice(0, 3)
      .join(", ");
  const s = inv.perfYtd.data?.summary;
  const b = inv.perfYtd.data?.benchmark;
  const triggered = inv.ov.data?.kpis.alerts?.triggered ?? 0;
  const last = inv.ov.data?.kpis.last_run;
  const vals = (inv.perf1y.data?.points ?? []).flatMap((p) => (p.value == null ? [] : [p.value]));
  const d = inv.dig.data;
  const review = !d
    ? null
    : d.review_due
      ? isDigestDay(isoDate(new Date(`${today}T12:00:00`)), d.digest_weekday)
        ? S.today
        : S.toDo
      : (WEEKDAYS[d.digest_weekday] ?? d.digest_weekday);
  const sigOk = inv.sig.data != null;
  return {
    title: S.investments,
    count: vals.length ? S.months12 : null,
    link: { label: S.investments, onPress: open },
    facts: [
      {
        label: "YTD",
        value: s?.twr != null ? pct(s.twr, true) : "-",
        ...(s?.twr != null ? { tone: tone(s.twr) } : {}),
        ...(perfNotes(inv.perfYtd.data).length
          ? { title: perfNotes(inv.perfYtd.data).join("\n") }
          : {}),
        detail:
          staleBenchmark(b)?.label ??
          (b?.status === "ok" && b.twr != null
            ? `${benchmarkLabel(b)} ${pct(b.twr, true)}`
            : S.noBenchmark),
      },
      {
        label: S.chancesLabel,
        value: sigOk ? String(chances.length) : "-",
        detail: names(chances) || null,
      },
      {
        label: S.risksLabel,
        value: sigOk ? String(risks.length) : "-",
        detail: triggered ? S.alertsMet(triggered) : names(risks) || null,
      },
    ],
    chart: vals.length > 2 ? { label: S.valueChart12m, values: vals } : null,
    review: review ? [{ text: `${S.weeklyReview} ` }, { text: review, bold: true }] : null,
    rules: last
      ? [
          {
            text: `${S.rules} ${last.status === "ok" ? S.runOk : last.status === "partial" ? S.runPartial : S.runError} · `,
          },
          { text: dm(last.finished_at ?? last.started_at), bold: true },
        ]
      : [{ text: S.rulesNeverRan }],
  };
}

type SurplusActions =
  | { kind: "tag"; text: string }
  | {
      kind: "buttons";
      primary: { label: string; disabled: boolean; onPress(): unknown } | null;
      other: Link;
    }
  | {
      kind: "input";
      label: string;
      value: string;
      onChange(v: string): void;
      onEnter(): void;
      onEscape(): void;
      plan: { label: string; disabled: boolean; onPress(): unknown };
      cancel: Link;
    };

/** A month of the year's contribution strip: deposited, missed, planned (this month, not yet deposited),
 * due (this month, nothing planned yet), ahead (later this year) or before the plan started. */
export type MonthState = "on" | "missed" | "planned" | "due" | "ahead" | "before";

/** The year's contributions against the monthly plan (the ring and the 12-month strip of the card). */
export interface SurplusYear {
  /** Accessible name of the ring and the strip ("2026 contributions against the plan"). */
  label: string;
  /** Months of the plan span with a deposit, of the months that count (the current one once deposited). */
  covered: number;
  due: number;
  /** covered / due as a whole percent; null before any month counts. */
  pct: number | null;
  /** "plan covered 9 of 11 mo". */
  text: string;
  months: { key: string; initial: string; state: MonthState; title: string }[];
}

export type SurplusModel =
  | { kind: "none"; title: string; text: string }
  | {
      kind: "card";
      title: string;
      highlight: boolean;
      tag: string;
      link: Link;
      flow: FlowFact[];
      checks: Rich;
      actions: SurplusActions;
      change: Link | null;
      foot: Rich[];
      footRight: string;
      /** The year's contributions against the plan; null without a monthly plan amount. */
      year: SurplusYear | null;
    };

/** The year's months against the monthly plan: deposits per calendar month from the 1-year portfolio flows,
 * the plan span from January or from the first deposit of this year (planMonthsSoFar), this month's planned
 * deposit. Pure. */
export function surplusYear(args: {
  points: { date: string; flow: number | null }[];
  today: string;
  amount: number | null;
  currency: string;
  firstDeposit: string | null;
  planned: { amount: number; currency: string; planned_date: string; status: string } | null;
}): SurplusYear | null {
  const { today, amount } = args;
  if (amount == null || !(amount > 0)) return null;
  const year = today.slice(0, 4);
  const cur = Number(today.slice(5, 7)) - 1;
  const span = planMonthsSoFar(args.firstDeposit, today);
  const from = cur - span + 1;
  const flows = monthlyFlows(args.points, `${year}-12-15`, 12);
  const months = flows.map((m, k) => {
    const name = MONTH_NOM[k] ?? m.label;
    const state: MonthState =
      k > cur
        ? "ahead"
        : k < from
          ? "before"
          : m.value > 0
            ? "on"
            : k < cur
              ? "missed"
              : args.planned?.status === "planned"
                ? "planned"
                : "due";
    const title =
      state === "on"
        ? S.monthOn(name, money0(m.value, args.currency))
        : state === "missed"
          ? S.monthMissed(name)
          : state === "planned" && args.planned
            ? S.monthPlanned(
                name,
                money0(args.planned.amount, args.planned.currency),
                dm(args.planned.planned_date),
              )
            : state === "due"
              ? S.monthDue(name)
              : state === "ahead"
                ? S.monthAhead(name)
                : S.monthBefore(name);
    return { key: m.key, initial: m.label.charAt(0).toUpperCase(), state, title };
  });
  const counted = months.slice(Math.max(0, from), cur + 1).filter((m, i, all) => {
    // The current month counts only once it has a deposit (contributionFacts).
    return i < all.length - 1 || m.state === "on";
  });
  const covered = counted.filter((m) => m.state === "on").length;
  const due = counted.length;
  return {
    label: S.yearPlan(year),
    covered,
    due,
    pct: due > 0 ? Math.round((covered / due) * 100) : null,
    text: S.coveredOf(covered, due),
    months,
  };
}

/**
 * Whether Nadwyżka -> inwestycje has anything to say: a monthly contribution in the strategy, a monthly
 * plan amount or a deposit planned or booked for this month. Without any of them the card would only
 * repeat the month's surplus from the budget card next to "no plan in the strategy", so it stays away.
 */
export function surplusApplies(inv: OverviewInvestments, today: string): boolean {
  const planned = inv.monthClose.investing?.planned ?? null;
  if (planned !== null && planned.amount > 0) return true;
  if ((inv.plan?.monthly_amount ?? 0) > 0) return true;
  return planForMonth<PlanRow>(inv.plans, today.slice(0, 7)) != null;
}

/** Nadwyżka -> wpłata (SurplusWidget). `other` is the "Inna kwota" draft (null = closed). */
export function surplusModel(args: {
  inv: OverviewInvestments;
  base: string;
  today: string;
  other: string | null;
  setOther(v: string | null): void;
  openFlows(): void;
}): SurplusModel {
  const { inv, today } = args;
  const d = inv.monthClose;
  const month = d.month;
  const curMonth = today.slice(0, 7);
  const plan = planForMonth<PlanRow>(inv.plans, curMonth);
  const close = d.currencies.find((c) => c.currency === args.base) ?? d.currencies[0] ?? null;
  if (!close) return { kind: "none", title: S.surplusTitle, text: S.noMonthClose };
  const planned = d.investing?.planned ?? null;
  const c = close.currency;
  const amount = planned && planned.currency === c ? planned.amount : null;
  const want = plan?.amount ?? amount;
  const flow = surplusFlow(close, want);
  const stays = flow.stays;
  const day = planned?.day_of_month ?? null;
  const due = nextDeposit(today, day);
  const cushion = d.cushion;
  const alloc = inv.ov.data?.allocation;
  const under =
    alloc && allocGeneric(alloc)
      ? alloc.buckets.filter((b) => b.drift_pp < 0).sort((a, b) => a.drift_pp - b.drift_pp)[0]
      : undefined;
  const closes =
    under && want && alloc?.total
      ? Math.min(
          Math.abs(under.drift_pp),
          contributionPp(
            want,
            alloc.total,
            Number(under.weight ?? under.target + under.drift_pp / 100),
          ),
        )
      : null;
  const monthIdx = Number(month.slice(5, 7)) - 1;
  const deposits = inv.perfYtd.data?.summary?.deposits ?? null;
  const firstDeposit = (inv.perf1y.data?.points ?? []).find((p) => (p.flow ?? 0) > 0)?.date ?? null;
  const ytdPlan = amount != null ? amount * planMonthsSoFar(firstDeposit, today) : null;
  const accounts = inv.ov.data?.accounts ?? [];
  const accountId = accounts.length === 1 ? (accounts[0]?.id ?? null) : null;
  const busy = inv.actions.busy;
  const save = (value: number) => {
    args.setOther(null);
    return inv.actions.save(value, c, due, accountId);
  };
  const otherNum = args.other != null ? parseNum(args.other) : null;
  const curName = MONTH_NOM[Number(curMonth.slice(5, 7)) - 1] ?? "";
  const foot: Rich[] = [];
  if (deposits != null && ytdPlan != null)
    foot.push([
      { text: `${S.depositsOfYear(curMonth.slice(0, 4))} ` },
      { text: money0(deposits, c), bold: true },
      { text: ` ${S.ofTotal} ${money0(ytdPlan, c)}` },
    ]);
  const mp = inv.plan;
  if (mp?.monthly_amount != null && mp.covered != null) {
    if (mp.covered) foot.push([{ text: `${curName}: ` }, { text: S.planCovered, bold: true }]);
    else if (mp.remaining != null)
      foot.push([
        { text: `${curName}: ${S.missing} ` },
        { text: money0(mp.remaining, mp.currency), bold: true },
      ]);
  }
  const checks: Run[] = [];
  if (cushion?.enabled) {
    if (cushion.reached)
      checks.push(
        { text: "✓", tone: "positive" },
        {
          text: ` ${S.cushion} ${cushion.target_months ? S.cushionMonths(cushion.target_months) : money0(cushion.target, cushion.currency)}`,
        },
      );
    else
      checks.push(
        { text: "!", tone: "warning" },
        { text: ` ${S.cushionMissing} ${money0(cushion.missing, cushion.currency)}` },
      );
  }
  if (cushion?.enabled && under && closes != null) checks.push({ text: " · " });
  if (under && closes != null)
    checks.push({
      text: S.belowTarget(bucketLabel(under.bucket_id) ?? "", pp(closes).replace(/^\+/, "")),
    });
  const actions: SurplusActions = plan
    ? {
        kind: "tag",
        text:
          plan.status === "booked"
            ? `${S.tagBooked(money0(plan.amount, plan.currency))}${plan.booked_at ? ` · ${dm(plan.booked_at)}` : ""}`
            : S.tagPlanned(money0(plan.amount, plan.currency), dm(plan.planned_date)),
      }
    : args.other == null
      ? {
          kind: "buttons",
          primary:
            flow.primary != null
              ? {
                  label: S.planAmount(money0(flow.primary, c)),
                  disabled: busy || inv.plans === null,
                  onPress: () => save(flow.primary as number),
                }
              : null,
          other: {
            label: S.otherAmount,
            onPress: () => args.setOther(want != null ? String(Math.round(want)) : ""),
          },
        }
      : {
          kind: "input",
          label: S.amountAria,
          value: args.other,
          onChange: args.setOther,
          onEnter: () => {
            if (otherNum && otherNum > 0) void save(otherNum);
          },
          onEscape: () => args.setOther(null),
          plan: {
            label: S.plan,
            disabled: !otherNum || otherNum <= 0 || busy,
            onPress: () => (otherNum ? save(otherNum) : undefined),
          },
          cancel: { label: CM.cancel, onPress: () => args.setOther(null) },
        };
  return {
    kind: "card",
    title: S.surplusTitle,
    highlight: !plan,
    tag: dm(due),
    link: { label: S.monthClose, onPress: args.openFlows },
    flow: [
      {
        id: "surplus",
        label: S.surplusOf(monthIdx),
        value: money0(close.surplus, c),
        ...(close.surplus < 0 ? { tone: "negative" as const } : {}),
        detail: flow.topUp > 0 ? S.forInvesting(money0(flow.available, c)) : null,
      },
      {
        id: "plan",
        label: S.depositPlan,
        value: want != null ? money0(want, c) : "-",
        detail: want == null ? S.noPlanInStrategy : day ? S.byDay(day) : null,
      },
      {
        id: "stays",
        label: stays != null && stays < 0 ? S.short : S.stays,
        value: stays != null ? money0(Math.abs(stays), c) : "-",
        ...(stays != null && stays < 0 ? { tone: "warning" as const } : {}),
        detail: stays != null && stays >= 0 ? S.inAccount : null,
      },
    ],
    checks,
    actions,
    change:
      plan?.status === "planned"
        ? { label: S.change, onPress: () => inv.actions.drop(plan) }
        : null,
    foot,
    footRight: plan?.status === "booked" ? S.bookedFromImport : S.toBookByImport,
    year: surplusYear({
      points: inv.perf1y.data?.points ?? [],
      today,
      amount,
      currency: c,
      firstDeposit,
      planned: plan,
    }),
  };
}
