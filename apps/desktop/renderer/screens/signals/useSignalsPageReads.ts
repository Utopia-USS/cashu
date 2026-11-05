// The reads of the ported alerts manager and journal pages (ab24ab6 v2/Home.tsx sub-routes `alerts` / `journal`:
// getAlerts("all"), getSignalsV2("all"), getDecisions, and the Home's instruments, buckets and digest weekday), in
// the old shapes, from the native signals and review queries (the same entries the Home holds).
import { lang } from "@cashu/i18n";
import { reviewScreenQueries } from "@cashu/store/investments/review-screen";
import { type ReadySignals, signalsQueries } from "@cashu/store/investments/signals-screen";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { isGenericBucket } from "@cashu/ui-logic/investments/labels";
import type { AccountRow, Decision } from "@cashu/ui-logic/investments/types";
import { instName } from "@cashu/ui-logic/investments/v2/logic";
import type { OverviewV2, PositionsV2, WatchItem } from "@cashu/ui-logic/investments/v2/types";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { alertsOf, digestOf, openSignalsOf } from "../investments/home/homeAdapters.js";
import { legacyId, legacyIdOf, wire } from "../investments/home/legacyWire.js";
import type { InstrumentChoice } from "./alertsModel.js";
import { dayReadInstant } from "./signalModels.js";

const signalsQuery = signalsQueries().screen;
const reviewQuery = reviewScreenQueries().screen;

type DecisionRow = ReadySignals["decisions"][number];
const decisionOf = (d: DecisionRow): Decision => ({
  id: legacyId(d.gid),
  signal_id: legacyIdOf(d.signal),
  instrument_id: legacyIdOf(d.instrument),
  account_id: legacyIdOf(d.account),
  action: d.action,
  quantity: d.quantity === null ? null : Number(d.quantity),
  price: d.price === null ? null : Number(d.price),
  currency: d.currency,
  reason: d.reason,
  created_at: d.createdAt,
  signal_ids: d.signals.map(legacyId),
});

export function useSignalsPageReads() {
  const today = useCalendarDay();
  const { privacy } = useUiEnv();
  const language = lang();
  const snapshot = useQuery(signalsQuery, {
    now: dayReadInstant(today),
    today,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: language,
    privacy,
  });
  const review = useQuery(reviewQuery, {
    today,
    lang: language,
    account: null,
    open: false,
    privacy,
  });
  // Signals first: their legacy numbers follow creation order (openSignalsOf) before any other read names one.
  const signals =
    snapshot.status === "ready"
      ? openSignalsOf({ ...snapshot, open: snapshot.signals })
      : openSignalsOf(snapshot);
  const alerts = alertsOf(snapshot);
  const ready = snapshot.status === "ready" ? snapshot : null;
  const context = ready?.context.status === "ready" ? ready.context : null;
  const positions = context ? wire<PositionsV2>(context.positions).positions : [];
  const watch = context ? wire<WatchItem[]>(context.watchlist) : [];
  const overview = context ? wire<OverviewV2>(context.overview) : null;
  const instruments: InstrumentChoice[] = positions.map((p) => ({
    id: Number(p.instrument.id),
    label: instName(p.instrument),
    symbol: p.instrument.symbol,
    venue: p.instrument.mic,
    currency: p.price_currency ?? p.instrument.currency,
    price: p.price,
    held: true,
  }));
  for (const w of watch)
    if (!instruments.some((o) => o.id === w.instrument_id) && w.instrument)
      instruments.push({
        id: w.instrument_id,
        label: instName(w.instrument),
        symbol: w.instrument.symbol,
        venue: w.instrument.mic,
        currency: w.price?.currency ?? w.instrument.currency,
        price: w.price?.close ?? null,
        held: false,
      });
  const digest = digestOf(review).data;
  return {
    today,
    privacy,
    /** `GET /signals?status=all` (isShownSignal). */
    signals,
    /** `GET /alerts?status=all`. */
    alerts,
    /** `GET /decisions`. */
    decisions: ready ? ready.decisions.map(decisionOf) : null,
    instruments,
    accounts: (overview?.accounts ?? []) as AccountRow[],
    /** The generic buckets of the strategy (old `strategy.facts.buckets`, else the allocation's). */
    buckets: (overview?.allocation.buckets.map((b) => b.bucket_id) ?? []).filter(isGenericBucket),
    digestWeekday: digest?.digest_weekday ?? "sunday",
    /** Kind -> scopes of the host's alert catalog. */
    catalog: ready
      ? Object.fromEntries(ready.catalog.map((k) => [k.kind, k.scopes as readonly string[]]))
      : null,
  };
}
