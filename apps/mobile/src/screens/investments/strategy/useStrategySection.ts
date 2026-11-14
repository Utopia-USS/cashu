// The Investments tab's Strategy view: the synced strategy document (markdown, without its frontmatter)
// with the day it was saved, and what watches it: each rule in words with "fired" while one of its
// signals is open, and the count of live alerts. Read only: the strategy changes on the Mac.
import { Decimal, type IsoDate } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { parseMarkdown, stripFrontmatter } from "@cashu/ui-logic/core/markdown";
import { isShownSignal, unnameBuckets } from "@cashu/ui-logic/investments/buckets";
import { RULE_KIND } from "@cashu/ui-logic/investments/v2/logic.strings";
import { useServices } from "../../../services/ServicesProvider";
import { localToday } from "../../screenContext";
import { instantOf } from "../format";
import type { StrategyViewProps } from "../investments-contracts";
import { type InvestmentSignals, useInvestmentSignals } from "../useInvestmentSignals";
import { S } from "./Strategy.strings";

type Reader = ReturnType<
  ReturnType<typeof useServices>["moneyQueries"]["investments"]["strategy"]["run"]
>;
type Rule = Extract<Reader, { status: "current" }>["rules"][number];

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** A rule in words from its kind and its parameters. */
function ruleName(rule: Rule, locale: string): string {
  const pct = (ratio: number) =>
    formatDecimalValue(Decimal.fromFloat(ratio), locale, { percent: true, fractionDigits: 0 }).text;
  const p = rule.params;
  switch (rule.kind) {
    case "allocation_drift":
      return S.ruleBands;
    case "position_concentration": {
      const max = num(p.maxWeight);
      return max === null ? S.ruleOther : S.ruleConcentration(pct(max));
    }
    case "cash_level": {
      const max = num(p.maxWeight);
      const min = num(p.minWeight);
      return max !== null
        ? S.ruleCashMax(pct(max))
        : min !== null
          ? S.ruleCashMin(pct(min))
          : S.ruleOther;
    }
    case "drawdown_from_high": {
      const threshold = num(p.threshold);
      return threshold === null ? S.ruleOther : S.ruleDrawdown(pct(threshold));
    }
    case "loss_from_cost": {
      const threshold = num(p.threshold);
      return threshold === null ? S.ruleOther : S.ruleLoss(pct(threshold));
    }
    case "gain_from_cost": {
      const threshold = num(p.threshold);
      return threshold === null ? S.ruleOther : S.ruleGain(pct(threshold));
    }
    case "contribution_gap": {
      const days = num(p.periodDays);
      return days === null ? S.ruleOther : S.ruleDeposit(days);
    }
    case "custom":
      // The owner's message may name the owner's own bucket (F7).
      return typeof p.message === "string" && p.message !== ""
        ? unnameBuckets(p.message)
        : S.ruleCustom;
    default:
      return S.ruleOther;
  }
}

function kindLabel(kind: string): string {
  return (RULE_KIND as Record<string, string>)[kind] ?? kind;
}

function strategyProps(
  reader: Reader,
  signals: InvestmentSignals,
  locale: string,
): StrategyViewProps {
  if (reader.status !== "current") return { document: null, rules: [], alertsCount: 0 };
  // A signal that never shows (a drift of the owner's own bucket) does not mark its rule as fired.
  const firing = new Set(
    signals.status === "ready" ? signals.open.filter(isShownSignal).map((s) => s.ruleId) : [],
  );
  const md = reader.version.mdText;
  const counts = signals.status === "ready" ? signals.counts : null;
  return {
    document:
      md === null
        ? null
        : {
            blocks: parseMarkdown(stripFrontmatter(md)),
            updated: localToday(instantOf(reader.version.createdAt)) as IsoDate,
          },
    rules: reader.rules.map((rule) => ({
      id: rule.id,
      name: ruleName(rule, locale),
      kind: kindLabel(rule.kind),
      tag: firing.has(rule.id)
        ? { label: S.fired, tone: "warning" as const }
        : { label: S.ok, tone: "positive" as const },
    })),
    alertsCount: counts === null ? 0 : counts.active + counts.triggered + counts.snoozed,
  };
}

export function useStrategySection(): StrategyViewProps {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const reader = useQuery(moneyQueries.investments.strategy, undefined);
  const signals = useInvestmentSignals();
  return strategyProps(reader, signals, locale);
}
