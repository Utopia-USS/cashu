// Python investments_proposals.backtest: sampled raw rule evaluations, never lifecycle/cooldown.
import { addDays, daysBetween, type IsoDate } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import type { ProfileId } from "@cashu/domain/investments";
import {
  buildRuleContext,
  Fired,
  type RuleSpec,
  RulesEngine,
  Skipped,
} from "@cashu/domain/investments/rules";
import type { Read } from "../../query.js";
import type { MarketInput } from "../marketInput.js";
import { transactions } from "../queries/transactions.js";
import { ownerNamed } from "../research/queries.js";
import { portfolioAt } from "../views/portfolio.js";
import type { StrategyState } from "./strategy.js";

export type RuleBacktestRequest = MarketInput & {
  readonly vault: ProfileId;
  readonly today: IsoDate;
  readonly strategy: StrategyState;
  readonly rule: RuleSpec;
  readonly lang: UiLang;
};

export type RuleBacktestReport =
  | { readonly evaluated: 0; readonly note: "no transaction history yet" }
  | {
      readonly evaluated: number;
      readonly step_days: number;
      readonly from: IsoDate;
      readonly to: IsoDate;
      readonly points_fired: number;
      readonly fired_outcomes: number;
      readonly episodes: number;
      readonly scopes_fired: number;
      readonly instruments: readonly string[];
      readonly first_fired: IsoDate | null;
      readonly last_fired: IsoDate | null;
      readonly fired_dates: readonly IsoDate[];
      readonly points_skipped: number;
      readonly skip_reasons: readonly string[];
      readonly note: "raw evaluations: cooldown_days is not applied; a rule never fires on missing data";
    };

function compareText(a: string, b: string): number {
  const left = [...a],
    right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const d = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return left.length - right.length;
}

/** Native portfolio construction uses only the caller's real cache/snapshot, with no network. */
export function backtestProposalRule(read: Read, request: RuleBacktestRequest): RuleBacktestReport {
  const txns = transactions(read);
  if (txns.length === 0) return { evaluated: 0, note: "no transaction history yet" };
  const config = request.strategy.config;
  if (config === null) throw new Error("strategy_unusable");
  let start = txns[0]?.tradeDate ?? request.today;
  for (const txn of txns) if (txn.tradeDate < start) start = txn.tradeDate;
  const days = Math.max(0, daysBetween(start, request.today));
  const step = days === 0 ? 7 : Math.max(7, Math.ceil(days / 260));
  const dates: IsoDate[] = [];
  for (let k = Math.floor(days / step); k >= 0; k--) dates.push(addDays(request.today, -k * step));
  const engine = new RulesEngine([request.rule]);
  const firedDates: IsoDate[] = [];
  const scopes = new Map<string, number>();
  const symbols = new Map<string, string>();
  const skipped = new Map<string, number>();
  let previous = new Set<string>(),
    firedOutcomes = 0,
    episodes = 0,
    skippedPoints = 0;
  for (const day of dates) {
    const market =
      request.marketData === undefined
        ? { prices: request.prices }
        : { marketData: request.marketData };
    const loaded = portfolioAt(read, {
      vault: request.vault,
      asOf: day,
      strategy: request.strategy,
      lang: request.lang,
      ...market,
    });
    if (!loaded.ok) throw new Error(`backtest_${loaded.reason}`);
    const state = loaded.value;
    const outcomes = engine.evaluate(
      buildRuleContext({
        profileId: request.vault,
        asOf: day,
        portfolio: state.valued,
        market: state.market,
        allocation: state.allocation,
        data: config.data,
        contributions: config.contributions,
        lang: request.lang,
      }),
    );
    const now = new Set<string>();
    let anySkipped = false;
    for (const outcome of outcomes) {
      if (outcome instanceof Fired) {
        const key = outcome.candidate.dedupKey;
        now.add(key);
        firedOutcomes += 1;
        scopes.set(key, (scopes.get(key) ?? 0) + 1);
        const instrument =
          outcome.candidate.instrumentId === null
            ? undefined
            : state.instruments.get(outcome.candidate.instrumentId);
        if (instrument?.symbol && !ownerNamed(instrument)) symbols.set(key, instrument.symbol);
      } else if (outcome instanceof Skipped) {
        anySkipped = true;
        const reason = [...outcome.reason.replace(/\p{Nd}/gu, "#")].slice(0, 120).join("");
        skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
      }
    }
    for (const key of now) if (!previous.has(key)) episodes += 1;
    previous = now;
    if (now.size !== 0) firedDates.push(day);
    if (anySkipped && now.size === 0) skippedPoints += 1;
  }
  return {
    evaluated: dates.length,
    step_days: step,
    from: start,
    to: request.today,
    points_fired: firedDates.length,
    fired_outcomes: firedOutcomes,
    episodes,
    scopes_fired: scopes.size,
    instruments: [...new Set(symbols.values())].sort(compareText).slice(0, 20),
    first_fired: firedDates[0] ?? null,
    last_fired: firedDates.at(-1) ?? null,
    fired_dates: firedDates.slice(-20),
    points_skipped: skippedPoints,
    skip_reasons: [...skipped]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason]) => reason),
    note: "raw evaluations: cooldown_days is not applied; a rule never fires on missing data",
  };
}
