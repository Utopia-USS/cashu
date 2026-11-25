// The signals screen query as every investments surface reads it (the tab dot, the Signals count, the
// Signals list, the Portfolio risk rings): one set of arguments, so they share one live read. The clock
// source overrides `now` and the time zone; `today` is the shell's day.
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { isShownSignal } from "@cashu/ui-logic/investments/buckets";
import { deviceTimeZone } from "../../services/investments";
import { useServices } from "../../services/ServicesProvider";
import { useNow } from "../../shell/useNow";
import { uiLang } from "./format";

export function useInvestmentSignals() {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const { today, now } = useNow();
  return useQuery(moneyQueries.investments.signals, {
    now,
    today,
    timeZone: deviceTimeZone(),
    lang: uiLang(locale),
    privacy: false,
  });
}

export type InvestmentSignals = ReturnType<typeof useInvestmentSignals>;
export type ReadySignals = Extract<InvestmentSignals, { status: "ready" }>;
export type OpenSignal = ReadySignals["open"][number];

/**
 * An open signal waiting for the owner's decision: an action signal (the strategy's immediate severity)
 * with no decision covering it, not snoozed, and not research (research that weakens a thesis shows in
 * the list but never counts: the count means "waiting for your decision"). A signal that never shows
 * (an allocation drift of the owner's own bucket) never counts either.
 */
export function waitsForDecision(signal: OpenSignal): boolean {
  return (
    signal.severity === "action" &&
    signal.decisions.length === 0 &&
    !signal.snoozed &&
    signal.source !== "research" &&
    isShownSignal(signal)
  );
}

/** The tab dot's and the Signals segment's count. */
export function decisionsWaiting(signals: InvestmentSignals): number {
  return signals.status === "ready" ? signals.open.filter(waitsForDecision).length : 0;
}
