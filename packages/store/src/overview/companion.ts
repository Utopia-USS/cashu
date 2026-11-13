// The phone companion's cross-module reads of one vault (`@cashu/store/overview/companion`): the
// charges of the coming days (recurring payments, loan installments, planned deposits) against the
// paying accounts' balances, the running month with those bills, the ranked attention list and the
// month close with the synced strategy's plan. Budget figures come from `budget/companion-queries.ts`;
// loans and investments are read here, where modules meet, as `./index.ts` does. Its own entry so the
// phone, whose bundler (Metro) does not tree-shake, carries it without the desktop widgets.
import {
  addDays,
  budget,
  type core,
  D,
  type Decimal,
  daysBetween,
  type IsoDate,
  loans,
  monthEnd,
  parseDateTime,
  utcIso,
} from "@cashu/domain";
import {
  type AttentionList,
  type AttentionPosition,
  type ResearchVerdict,
  rankAttention,
} from "@cashu/domain/core/attention";
import { asProfileId } from "@cashu/domain/investments";
import { strategyStatus, usableConfig } from "@cashu/domain/investments/strategy";
import { hiddenFromOwner } from "@cashu/domain/investments/views";
import { budgetCliCushionEnv, budgetCliSettings } from "../budget/cli-queries.js";
import {
  accountBalances,
  type CompanionMonth,
  type CompanionMonthArgs,
  type CompanionRecurringContext,
  companionMonth,
  companionMonthOf,
  payeeChargeHistories,
  recurringCharges,
} from "../budget/companion-queries.js";
import { dataFreshness } from "../budget/freshness.js";
import { budgetBook } from "../budget/read-models.js";
import { enabledModuleIds } from "../core/queries.js";
import {
  type CurrentStrategySource,
  combinedChanges,
  type InvestmentMarketSource,
  type InvestmentScreenClock,
} from "../investments/desktop/sources.js";
import { alertByGid } from "../investments/queries/alerts.js";
import { loadInstruments } from "../investments/queries/instruments.js";
import { decisionSignalGids, decisions } from "../investments/queries/journal.js";
import { openPlannedDeposits } from "../investments/queries/planned.js";
import { instrumentGid } from "../investments/queries/shared.js";
import { openSignals } from "../investments/queries/signals.js";
import { latestStrategyVersion } from "../investments/queries/strategy.js";
import { notes } from "../investments/research/queries.js";
import { eventInstant } from "../investments/research/rows.js";
import { readPositions } from "../investments/views/positions.js";
import { mcpLoanRows } from "../loans/mcp-queries.js";
import { loanPayingAccount } from "../loans/screen.js";
import { type ChangeSource, defineQuery, type Query, type Read } from "../query.js";
import { type OverviewSources, registryOf, vaultPaymentPatterns } from "./networth.js";

// --------------------------------------------------------------------------- upcoming

export type CompanionUpcomingArgs = {
  readonly today: IsoDate;
  /** Default `budget.UPCOMING_HORIZON_DAYS`. */
  readonly horizonDays?: number | null;
};

const HOUR_MS = 3_600_000;

/** The upcoming charges, optionally over recurring charges the caller already has. */
function upcomingOf(
  read: Read,
  args: CompanionUpcomingArgs,
  recurring: readonly budget.RecurringCharge[] | null,
  ctx: CompanionRecurringContext,
): budget.Upcoming {
  const { today } = args;
  const horizonDays = args.horizonDays ?? budget.UPCOMING_HORIZON_DAYS;
  const from = addDays(today, -budget.UPCOMING_GRACE_DAYS);
  const to = addDays(today, horizonDays);
  // Loan installments only with the loans module, planned deposits only with investments.
  const modules = enabledModuleIds(read);
  const loanRows = modules.has("loans") ? mcpLoanRows(read) : [];
  const installments: budget.InstallmentDue[] = loanRows.flatMap(({ loan, account }) => {
    const due = loans
      .schedule(loan.principal, loan.annualRate, loan.termMonths, loan.startDate)
      .filter((row) => row.date >= from && row.date <= to);
    if (due.length === 0) return [];
    const payer = loanPayingAccount(read, loan);
    const paying = payer === null ? null : { id: payer.gid, name: payer.name };
    return due.map((row) => ({
      key: `loan:${loan.id}:${row.n}`,
      loan: loan.id,
      name: account.name,
      date: row.date,
      amount: row.payment,
      currency: account.currency,
      account: paying,
    }));
  });
  const planned: budget.PlannedOutflow[] = (
    modules.has("investments") ? openPlannedDeposits(read) : []
  )
    .filter((p) => p.plannedDate >= from && p.plannedDate <= to)
    .map((p) => ({
      key: `planned:${p.gid}`,
      name: p.note ?? "",
      date: p.plannedDate,
      amount: p.amount,
      currency: p.currency,
      account: null,
    }));
  return budget.upcomingCharges({
    today,
    horizonDays,
    recurring: recurring ?? recurringCharges(read, today, ctx),
    installments,
    planned,
    balances: accountBalances(read, today),
  });
}

/** The recurring-detection context of the overview: its modules' payment patterns and registry. */
const recurringContext = (
  read: Read,
  sources: OverviewSources,
  book?: budget.BudgetBook,
): CompanionRecurringContext => ({
  ...(book === undefined ? {} : { book }),
  patterns: vaultPaymentPatterns(read, sources),
  registry: registryOf(sources),
});

/** The charges of the coming days (`budget.upcomingCharges`) of this vault. */
export function companionUpcoming(
  read: Read,
  args: CompanionUpcomingArgs,
  sources: OverviewSources = {},
): budget.Upcoming {
  return upcomingOf(read, args, null, recurringContext(read, sources));
}

/**
 * The month's known bills: the upcoming rows in `currency` from today to the running month's end, as a
 * positive sum. A past or future month has none (a closed month has nothing left to pay; a coming one
 * is not projected yet).
 */
function billsDue(
  read: Read,
  args: CompanionMonthArgs,
  currency: string,
  ctx: CompanionRecurringContext,
): Decimal {
  const { label } = companionMonthOf(args);
  if (label !== args.today.slice(0, 7)) return D("0.00");
  const start = `${label}-01`;
  const upcoming = upcomingOf(
    read,
    { today: args.today, horizonDays: daysBetween(args.today, monthEnd(args.today)) },
    null,
    ctx,
  );
  let sum = D("0.00");
  // The grace day may reach into the month before on the 1st: only this month's rows count.
  for (const row of upcoming.rows)
    if (row.currency === currency && row.when >= start) sum = sum.add(row.amount.copyAbs());
  return sum;
}

/** `companionMonth` with the bills still due this month and the projection over them. */
export function companionMonthWithBills(
  read: Read,
  args: CompanionMonthArgs,
  sources: OverviewSources = {},
): CompanionMonth {
  const book = budgetBook(read);
  const currency = args.currency || book.baseCurrency;
  const bills = billsDue(read, args, currency, recurringContext(read, sources, book));
  return companionMonth(read, { ...args, currency }, { book, billsDue: bills });
}

// --------------------------------------------------------------------------- attention

export type CompanionAttentionArgs = {
  readonly today: IsoDate;
  readonly currency: string;
  /** The current moment (ISO datetime): the age of the bank data is measured to it. */
  readonly now: string;
};

/** Whole hours from the newest import to `now`; null when either is unknown. */
function ageHours(at: string | null, now: string): number | null {
  if (at === null) return null;
  const ms = Date.parse(now) - Date.parse(at);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / HOUR_MS)) : null;
}

/**
 * The investments sources the attention list reads its positions with (the phone binds its own: the
 * synced strategy, the device's price cache, the device clock). Without the strategy and the market
 * the positions carry no weight, so only a fired action alert can rank.
 */
export interface CompanionInvestmentSources {
  readonly strategy?: CurrentStrategySource;
  readonly market?: InvestmentMarketSource;
  readonly clock?: InvestmentScreenClock & { readonly changes?: ChangeSource };
}

/** What Today's tier-2 row says and opens beyond the ranked reason, per instrument gid. */
export interface CompanionAttentionPosition {
  /** The newest open action signal without a decision (the alert sheet opens on it); null without one. */
  readonly signal: string | null;
  /** The week's move as a share (-0.094 = -9.4 %): the last close against the close a week before. */
  readonly week: number | null;
}

export type CompanionAttention = AttentionList & {
  readonly positions: Readonly<Record<string, CompanionAttentionPosition>>;
};

/** Research of the last this-many days counts as a fresh verdict on a position. */
const RESEARCH_DAYS = 14;
const DAY_MS = 86_400_000;
const VERDICT_RANK: Readonly<Record<string, number>> = { invalidates: 2, weakens: 1 };

/** The day's and the week's move from a position's recent closes (oldest first); null when too short. */
function movesOf(closes: readonly { readonly date: string; readonly close: Decimal }[]): {
  readonly day: number | null;
  readonly week: number | null;
} {
  const last = closes.at(-1);
  if (last === undefined || last.close.isZero()) return { day: null, week: null };
  const change = (from: Decimal | undefined) =>
    from === undefined || from.isZero() ? null : last.close.div(from).toFloat() - 1;
  const weekAgo = addDays(last.date as IsoDate, -7);
  const base = closes.filter((c) => c.date <= weekAgo).at(-1);
  return { day: change(closes.at(-2)?.close), week: change(base?.close) };
}

/**
 * The attention list's positions: every open action signal without a decision (not snoozed) per
 * instrument, a research verdict that weakens or breaks the thesis in the last `RESEARCH_DAYS` days,
 * and, when the strategy and the market are bound, each holding's portfolio weight and day move. The
 * domain list decides which of them rank (a fired alert always; otherwise weight and verdict or move).
 */
function companionPositions(
  read: Read,
  args: CompanionAttentionArgs,
  investments: CompanionInvestmentSources,
): {
  readonly rows: AttentionPosition[];
  readonly details: Record<string, CompanionAttentionPosition>;
} {
  const empty = { rows: [], details: {} };
  if (!enabledModuleIds(read).has("investments")) return empty;
  const nowMs = Date.parse(args.now);
  if (!Number.isFinite(nowMs)) return empty;
  const canonical = (gid: string | null) => (gid === null ? undefined : instrumentGid(read, gid));

  // Open action signals the owner has not decided on, newest per instrument.
  const decided = new Set(
    [
      ...decisionSignalGids(
        read,
        decisions(read).map((row) => row.gid),
      ).values(),
    ].flat(),
  );
  const alerts = new Map<string, { gid: string; lastSeenAt: string; title: string | null }>();
  for (const signal of openSignals(read)) {
    if (signal.severity !== "action" || decided.has(signal.gid) || hiddenFromOwner(signal))
      continue;
    if (signal.snoozedUntil !== null && Date.parse(utcIso(signal.snoozedUntil)) > nowMs) continue;
    const id = canonical(signal.instrument);
    if (id === undefined) continue;
    const seen = alerts.get(id);
    if (seen !== undefined && seen.lastSeenAt >= signal.lastSeenAt) continue;
    const alertId = signal.ruleId.startsWith("alert:") ? signal.ruleId.slice(6) : null;
    const title = alertId === null ? null : (alertByGid(read, alertId, args.now)?.title ?? null);
    alerts.set(id, { gid: signal.gid, lastSeenAt: signal.lastSeenAt, title });
  }

  // The strongest fresh research verdict against the thesis per instrument.
  const verdicts = new Map<string, ResearchVerdict>();
  const since = eventInstant(new Date(nowMs - RESEARCH_DAYS * DAY_MS).toISOString());
  for (const note of notes(read, eventInstant(new Date(nowMs).toISOString()))) {
    const rank = VERDICT_RANK[note.thesisRelation] ?? 0;
    const id = canonical(note.instrument);
    if (rank === 0 || id === undefined || note.observedAt < since) continue;
    if ((VERDICT_RANK[verdicts.get(id) ?? ""] ?? 0) < rank)
      verdicts.set(id, note.thesisRelation as ResearchVerdict);
  }

  // Weights and moves of the holdings, when the strategy and the market are bound.
  const held = new Map<
    string,
    { name: string; weight: number; day: number | null; week: number | null }
  >();
  const strategy = investments.strategy?.current(read);
  const market = investments.market?.current(read);
  if (strategy?.status === "current" && market) {
    const positions = readPositions(read, {
      ...market,
      vault: asProfileId(strategy.vault),
      asOf: args.today,
      strategy: strategy.state,
      clock: {
        today: args.today,
        now: parseDateTime(args.now),
        timeZone: investments.clock?.current().timeZone ?? "UTC",
      },
      lang: "en",
      forOwner: true,
      accounts: null,
    });
    if (positions.ok)
      for (const row of positions.value.positions) {
        const moves = movesOf(row.closes_30d);
        held.set(row.instrument.id, {
          name: row.instrument.name || row.instrument.label,
          weight: row.weight ?? 0,
          ...moves,
        });
      }
  }

  const ids = new Set([...held.keys(), ...alerts.keys(), ...verdicts.keys()]);
  const others = loadInstruments(
    read,
    [...ids].filter((id) => !held.has(id)),
  );
  const rows: AttentionPosition[] = [];
  const details: Record<string, CompanionAttentionPosition> = {};
  for (const id of ids) {
    const position = held.get(id);
    const instrument = others.get(id);
    const name = position?.name ?? (instrument?.name || instrument?.symbol || id);
    const alert = alerts.get(id);
    const verdict = verdicts.get(id);
    rows.push({
      instrument: { id, name },
      weight: position?.weight ?? 0,
      alert: alert === undefined ? null : { severity: "action", title: alert.title },
      research: verdict === undefined ? null : { verdict },
      move: position === undefined ? null : { day: position.day, weekSigma: null },
    });
    details[id] = { signal: alert?.gid ?? null, week: position?.week ?? null };
  }
  return { rows, details };
}

/** The ranked attention list of the running month in one currency, with the positions' details. */
export function companionAttention(
  read: Read,
  args: CompanionAttentionArgs,
  sources: OverviewSources = {},
  investments: CompanionInvestmentSources = {},
): CompanionAttention {
  const book = budgetBook(read);
  const currency = args.currency || book.baseCurrency;
  const ctx = recurringContext(read, sources, book);
  const payees = payeeChargeHistories(read, args.today, ctx);
  const upcoming = upcomingOf(read, { today: args.today }, payees, ctx);
  const month = companionMonth(read, { today: args.today, currency, lang: "en" }, { book });
  const usualMonth = month.norm?.expense ?? null;
  const largest = month.uncategorized.largest;
  const freshness = dataFreshness.run(read, undefined);
  const positions = companionPositions(read, args, investments);
  const list = rankAttention({
    today: args.today,
    currency,
    month: { spentSoFar: month.spent, usualMonth },
    uncategorized: {
      count: month.uncategorized.count,
      sum: month.uncategorized.sum,
      largest:
        largest === null
          ? null
          : { payee: largest.payee, date: largest.date, amount: largest.amount },
    },
    bills: upcoming.rows,
    positions: positions.rows,
    // Every rise: whether it is worth a look against the usual month is the attention list's call.
    payeeChanges: budget.payeeChanges({ today: args.today, currency, payees }),
    freshness: {
      bankDataAgeHours: ageHours(freshness.bankDataAt, args.now),
      consentEndsInDays: null,
    },
  });
  // Only the ranked positions' details travel.
  const shown: Record<string, CompanionAttentionPosition> = {};
  for (const row of list.rows) {
    const detail = row.subject.kind === "position" ? positions.details[row.subject.id] : undefined;
    if (detail !== undefined) shown[row.subject.id] = detail;
  }
  return { ...list, positions: shown };
}

// --------------------------------------------------------------------------- month close

export type CompanionMonthCloseArgs = {
  readonly today: IsoDate;
  /** "YYYY-MM"; default `budget.defaultMonth`. */
  readonly month?: string | null;
  readonly lang: core.UiLang;
};

export type CompanionMonthClose = budget.MonthCloseView & {
  /**
   * The open planned deposit of the month after the closed one (where its surplus is invested): the
   * latest-dated one when there are several; null without one or without the investments module.
   */
  readonly plannedDeposit: {
    readonly gid: string;
    readonly amount: Decimal;
    readonly currency: string;
  } | null;
};

/**
 * The synced strategy's planned contribution: the newest stored version loaded as the strategy
 * service loads files; null without a version or for an invalid one.
 */
function strategyPlan(read: Read): budget.PlannedContribution | null {
  const version = latestStrategyVersion(read);
  if (version === undefined) return null;
  const status = strategyStatus(
    { yaml: version.yamlText, md: version.mdText, readError: null },
    null,
  );
  if (status.state === "invalid" || status.state === "missing") return null;
  return budget.plannedContribution(status.state, usableConfig(status));
}

export function companionMonthClose(
  read: Read,
  args: CompanionMonthCloseArgs,
): CompanionMonthClose {
  const parsed = args.month ? budget.parseMonth(args.month) : null;
  if (parsed !== null && !parsed.ok) throw new RangeError("invalid budget month");
  const investmentsEnabled = enabledModuleIds(read).has("investments");
  const close = budget.monthClose(budgetBook(read), {
    today: args.today,
    settings: budgetCliSettings(read) ?? budget.defaultBudgetSettings(),
    env: budgetCliCushionEnv(read),
    investmentsEnabled,
    planned: investmentsEnabled ? strategyPlan(read) : null,
    ...(parsed?.ok ? { year: parsed.year, month: parsed.month } : {}),
  });
  const [year, month] = budget.shiftMonth(close.year, close.month, 1);
  const next = budget.monthLabel(year, month);
  const plan = investmentsEnabled
    ? openPlannedDeposits(read)
        .filter((p) => p.plannedDate.slice(0, 7) === next)
        .at(-1)
    : undefined;
  return {
    ...budget.monthCloseView(close, args.lang),
    plannedDeposit:
      plan === undefined ? null : { gid: plan.gid, amount: plan.amount, currency: plan.currency },
  };
}

// --------------------------------------------------------------------------- queries

export interface CompanionQueries {
  readonly upcoming: Query<CompanionUpcomingArgs, budget.Upcoming>;
  readonly month: Query<CompanionMonthArgs, CompanionMonth>;
  readonly attention: Query<CompanionAttentionArgs, CompanionAttention>;
  readonly monthClose: Query<CompanionMonthCloseArgs, CompanionMonthClose>;
}

/**
 * The companion's overview queries. Only the attention list values prices (its positions' weights and
 * moves), through the optional investments sources; it re-runs when they change.
 */
export function companionQueries(
  sources: OverviewSources = {},
  investments: CompanionInvestmentSources = {},
): CompanionQueries {
  return {
    upcoming: defineQuery({
      id: "core.companionUpcoming",
      run: (read, args: CompanionUpcomingArgs) => companionUpcoming(read, args, sources),
    }),
    month: defineQuery({
      id: "core.companionMonth",
      run: (read, args: CompanionMonthArgs) => companionMonthWithBills(read, args, sources),
    }),
    attention: defineQuery({
      id: "core.attention",
      changes: combinedChanges(
        ...[
          investments.strategy?.changes,
          investments.market?.changes,
          investments.clock?.changes,
        ].filter((source) => source !== undefined),
      ),
      run: (read, args: CompanionAttentionArgs) =>
        companionAttention(read, args, sources, investments),
    }),
    monthClose: defineQuery({
      id: "core.companionMonthClose",
      run: (read, args: CompanionMonthCloseArgs) => companionMonthClose(read, args),
    }),
  };
}
