// The home rail next to the review deck (pure logic of HomeRail.tsx). The deck's "Do decyzji" card is where the
// owner decides; the rail tells what happens between reviews: Sygnały = subjects new since the last review and the
// ones the review put off (snoozed, or left without a decision), Alerty = only the alerts close to their level or
// fired since the last review (at most two weeks back), each as a ticker, its title and a tag.
import { dm } from "../labels.ts";
import type { Alert } from "./api.ts";
import { alertDistance, alertState, type InstLike } from "./logic.ts";
import { type DecideItem, newSinceMs } from "./reviewDeckLogic.ts";
import { DEFAULT_TAG, S } from "./railLogic.strings.ts";
import { parseServerTime } from "../../../time.ts";

export interface RailSignals { fresh: DecideItem[]; left: DecideItem[] }

/** Subjects of `decideItems(..., { includeSnoozed: true })` for the rail: new since the last review, and the ones
 * the last review put off (snoozed, or with signals older than the review and still undecided). Subjects that only
 * wait for the next review stay in the deck. */
export function railSignals(items: DecideItem[], lastReviewAt: string | null | undefined): RailSignals {
  const reviewed = parseServerTime(lastReviewAt ?? null);
  const subjects = items.filter((d) => d.kind === "subject");
  return {
    fresh: subjects.filter((d) => d.fresh),
    left: subjects.filter((d) => !d.fresh && (!!d.snoozedUntil || (Number.isFinite(reviewed) && (d.seenAt ?? Infinity) < reviewed))),
  };
}

export type RailAlertState = "near" | "met";
export interface RailAlert { id: number; inst: InstLike | null; title: string; extra: string | null; tag: string; state: RailAlertState }

const KIND_TAG: Record<string, keyof typeof DEFAULT_TAG> = {
  price_above: "price", price_below: "price", change_pct: "price", drawdown_from_high: "price", new_high: "price",
  sma_cross: "average", volume_spike: "volume", range_breakout: "breakout", weight_above: "weight", weight_below: "weight", custom: "custom",
};

/** The tag shown on an alert: its own, else one from its kind. */
export const alertTag = (a: Pick<Alert, "kind" | "tag">) => a.tag?.trim() || DEFAULT_TAG[KIND_TAG[a.kind] ?? "custom"];

/** The title without a leading `TICKER:` (the tile shows the ticker next to it). */
export function stripSubject(title: string, symbol: string | null | undefined): string {
  const sym = symbol?.trim();
  if (!sym) return title;
  // `TICKER: ...` or a spaced separator (`TICKER - ...`, `TICKER · ...`, en / em dash); never inside a name like `PKO-BP`.
  const rest = title.replace(new RegExp(`^${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?::\\s*|\\s[·\\-\u2013\u2014]\\s+)`, "i"), "");
  return rest || title;
}

/** The alerts worth a row: fired since the last review (two weeks at most), then the ones close to their level,
 * nearest first. Alerts without a measurable distance never count as close. */
export function railAlerts(alerts: Alert[], near: { pricePct?: number | null; pp?: number | null } | null,
  sinceAt: string | null | undefined, now = Date.now()): RailAlert[] {
  const since = newSinceMs(sinceAt, now);
  const row = (a: Alert, state: RailAlertState, extra: string | null): RailAlert => ({
    id: a.id, state, extra, tag: alertTag(a), title: stripSubject(a.title, a.instrument?.symbol),
    inst: a.instrument ? { id: a.instrument.id, label: a.instrument.label, name: a.instrument.name, symbol: a.instrument.symbol } : null,
  });
  const met = alerts.filter((a) => a.status === "triggered" && parseServerTime(a.last_triggered_at) > since)
    .sort((a, b) => parseServerTime(b.last_triggered_at) - parseServerTime(a.last_triggered_at))
    .map((a) => row(a, "met", S.firedOn(dm(a.last_triggered_at))));
  const close = alerts.filter((a) => a.status === "active" && alertState(a, near) === "near")
    .map((a) => ({ a, d: alertDistance(a) }))
    .sort((x, y) => (y.d?.fill ?? 0) - (x.d?.fill ?? 0))
    .map(({ a, d }) => row(a, "near", d ? S.missing(d.text) : null));
  return [...met, ...close];
}
