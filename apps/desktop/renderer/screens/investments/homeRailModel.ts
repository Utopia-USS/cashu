import { parseServerTime } from "@cashu/ui-logic/core/time";
import { dm } from "@cashu/ui-logic/investments/labels";
import { type AlertLike, alertDistance, alertState } from "@cashu/ui-logic/investments/v2/logic";
import { alertTag, stripSubject } from "@cashu/ui-logic/investments/v2/railLogic";
import type { ReviewEntryState } from "../review/useReviewEntry.js";
import type { SignalsScreenState } from "../signals/useSignalsScreen.js";
import { H } from "./home-rail/HomeRail.strings.js";
import type { HomeRailViewProps, RailGroup } from "./home-rail/HomeRailView.js";

type Rail = Pick<HomeRailViewProps, "signals" | "alerts">;

/** Exact native gids and current read snapshots are projected into the compact Home rail. */
export function homeRailModel(
  state: SignalsScreenState,
  review: ReviewEntryState,
  onReview: () => void,
  onAlerts: () => void,
  onNewAlert: () => void,
  onOpenAsset?: (gid: string) => void,
  near: { pricePct?: number | null; pp?: number | null } | null = null,
): Rail {
  const data = state.data;
  const reviewData = review.data.status === "current" ? review.data : null;
  const openSignals = () => state.setDialogOpen(true);
  if (data === null)
    return {
      signals: {
        available: false,
        navigationAvailable: false,
        fresh: 0,
        left: 0,
        rows: [],
        unchanged: 0,
        total: 0,
        reviewDue: false,
        nextReviewDay: null,
        review: null,
        onAll: openSignals,
      },
      alerts: {
        available: false,
        rows: [],
        active: 0,
        onAll: onAlerts,
        onNew: onNewAlert,
      },
    };
  const now = parseServerTime(data.asOf);
  const reviewed = parseServerTime(data.lastReviewAt);
  const railItems = reviewData?.railDecide.items.filter((item) => item.kind === "subject") ?? [];
  const fresh = railItems.filter((item) => item.fresh);
  const left = railItems.filter(
    (item) =>
      !item.fresh &&
      (!!item.snoozedUntil || (Number.isFinite(reviewed) && (item.seenAt ?? Infinity) < reviewed)),
  );
  const railRow = (item: (typeof railItems)[number]) => ({
    id: item.key,
    tile:
      item.instrument === null
        ? "PF"
        : (data.instruments.find((instrument) => instrument.id === item.instrument)?.symbol ??
          item.lead?.instrumentLabel ??
          "?"),
    title: item.title || item.lead?.message || "",
    text: item.why,
    note: item.snoozedUntil
      ? H.snoozedTo(dm(item.snoozedUntil))
      : left.includes(item)
        ? H.undecided
        : null,
    group: (item.group === "fix" ? "mixed" : item.group) as RailGroup,
    onOpen: () => {
      if (item.instrument !== null && onOpenAsset) onOpenAsset(item.instrument);
      else {
        state.setCursor(item.signals[0] ?? null);
        openSignals();
      }
    },
  });
  const decision = reviewData?.decide.items.filter((item) => item.kind !== "rules") ?? [];
  const counts: Partial<Record<RailGroup | "fix" | "proposal", number>> = {};
  for (const item of decision) {
    const key = item.kind === "proposal" ? "proposal" : item.group;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const fix = reviewData?.decide.items.find((item) => item.kind === "rules");
  if (fix) counts.fix = fix.signals.length;

  const asLegacy = (row: (typeof data.alerts)[number]): AlertLike => ({
    kind: row.kind,
    scope: row.scope,
    params: { ...row.params },
    polarity: row.polarity,
    severity: row.severity,
    title: row.title,
    status: row.status,
    source: row.source,
    last_value:
      row.lastValue === null || !Number.isFinite(Number(row.lastValue))
        ? null
        : Number(row.lastValue),
    cooldown_days: row.cooldownDays,
    expires_at: row.expiresAt,
    snoozed_until: row.snoozedUntil,
    last_triggered_at: row.lastTriggeredAt,
    instrument: row.instrumentDetail
      ? {
          label: row.instrumentDetail.name,
          symbol: row.instrumentDetail.symbol,
          currency: row.instrumentDetail.currency,
        }
      : null,
    state: row.state,
  });
  const since = Math.max(
    Number.isFinite(reviewed) ? reviewed : Number.NEGATIVE_INFINITY,
    now - 14 * 86400000,
  );
  const met = data.alerts
    .filter((row) => row.status === "triggered" && parseServerTime(row.lastTriggeredAt) > since)
    .sort((a, b) => parseServerTime(b.lastTriggeredAt) - parseServerTime(a.lastTriggeredAt));
  const close = data.alerts
    .filter((row) => row.status === "active" && alertState(asLegacy(row), near) === "near")
    .sort(
      (a, b) => (alertDistance(asLegacy(b))?.fill ?? 0) - (alertDistance(asLegacy(a))?.fill ?? 0),
    );
  return {
    signals: {
      available: reviewData !== null,
      navigationAvailable: true,
      fresh: fresh.length,
      left: left.length,
      rows: [...fresh, ...left].slice(0, 6).map(railRow),
      unchanged: reviewData?.railDecide.rest.review ?? 0,
      total: reviewData?.railDecide.total ?? data.open.length,
      reviewDue: !!reviewData?.due && reviewData.decide.items.length > 0,
      nextReviewDay: reviewData?.next ?? null,
      review:
        reviewData?.due && reviewData.decide.items.length > 0
          ? { name: reviewData.name, items: decision.length, counts, onOpen: onReview }
          : null,
      onAll: openSignals,
    },
    alerts: {
      available: true,
      rows: [...met, ...close].map((row) => ({
        id: row.gid,
        tile: row.instrumentDetail?.symbol ?? row.instrumentDetail?.name ?? "?",
        title: stripSubject(row.title, row.instrumentDetail?.symbol),
        note:
          row.status === "triggered"
            ? H.firedOn(dm(row.lastTriggeredAt))
            : alertDistance(asLegacy(row))?.text
              ? H.missing(alertDistance(asLegacy(row))?.text ?? "")
              : null,
        tag: alertTag({ kind: row.kind, tag: row.tag }),
        state: row.status === "triggered" ? ("met" as const) : ("near" as const),
      })),
      active: data.alerts.filter((row) => row.status === "active" || row.status === "triggered")
        .length,
      onAll: onAlerts,
      onNew: onNewAlert,
    },
  };
}
