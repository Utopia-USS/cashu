// The pure parts of the ported alerts manager (ab24ab6 v2/Alerts.tsx): the edit form's cards and pauses, the
// manager table rows, the triggered history and its CSV, and the alert row of the Home / asset page (AlertRow).
import { CARD_LABEL, S } from "@cashu/i18n/investments/v2/Alerts.strings";
import { csvLine } from "@cashu/ui-logic/core/csv";
import { addDays, localDay, parseServerTime, todayLocal } from "@cashu/ui-logic/core/time";
import { bucketLabel, DECISION_ACTION, dm, pct } from "@cashu/ui-logic/investments/labels";
import {
  type AlertState,
  alertConditionText,
  alertDistance,
  alertFact,
  alertLevelText,
  alertNowText,
  alertState,
  alertWhenSuffix,
  instName,
  price,
  ratioX,
  unnameBuckets,
} from "@cashu/ui-logic/investments/v2/logic";
import type { Alert, SignalV2 } from "@cashu/ui-logic/investments/v2/types";

export interface InstrumentChoice {
  id: number;
  label: string;
  symbol: string | null;
  venue: string | null;
  currency: string;
  price: number | null;
  held: boolean;
}

export const isLive = (a: Alert) =>
  a.status === "active" || a.status === "triggered" || a.status === "snoozed";

export type StatusFilter = "active" | "triggered" | "snoozed" | "muted" | "all";
export type SourceFilter = "all" | "user" | "agent";
export type Scope = "instrument" | "portfolio" | "bucket";
export type KindCard =
  | "price_above"
  | "price_below"
  | "change_pct"
  | "drawdown_from_high"
  | "new_high"
  | "sma_cross"
  | "range_breakout"
  | "volume_spike"
  | "weight"
  | "custom";

export const CARDS: { card: KindCard; machine: string; kinds: string[] }[] = [
  { card: "price_above", machine: "price_above", kinds: ["price_above"] },
  { card: "price_below", machine: "price_below", kinds: ["price_below"] },
  { card: "change_pct", machine: "change_pct", kinds: ["change_pct"] },
  { card: "drawdown_from_high", machine: "drawdown_from_high", kinds: ["drawdown_from_high"] },
  { card: "new_high", machine: "new_high", kinds: ["new_high"] },
  { card: "sma_cross", machine: "sma_cross", kinds: ["sma_cross"] },
  { card: "range_breakout", machine: "range_breakout", kinds: ["range_breakout"] },
  { card: "volume_spike", machine: "volume_spike", kinds: ["volume_spike"] },
  {
    card: "weight",
    machine: "weight_above · weight_below",
    kinds: ["weight_above", "weight_below"],
  },
  { card: "custom", machine: "custom", kinds: ["custom"] },
];
export const cardLabel = (c: KindCard): string => (CARD_LABEL as Record<string, string>)[c] ?? c;
export const COOLDOWNS: (number | null)[] = [null, 7, 14, 30, 90];
export const cooldownLabel = (v: number | null) => (v == null ? S.noPause : S.days(v));
const endOfYear = (): string => `${new Date().getFullYear()}-12-31`;
/** Local calendar day `days` from today (never the UTC date). */
const inDays = (days: number): string => addDays(todayLocal(), days);
/** The expiry choices: 30 / 90 days, the year's end, a year (each once). */
export const expiryChoices = (): string[] =>
  [inDays(30), inDays(90), endOfYear(), inDays(365)].filter((d, i, a) => a.indexOf(d) === i);
export const choiceText = (i: InstrumentChoice) =>
  [i.label, i.symbol, i.venue].filter(Boolean).join(" · ");

// ---- the manager table ------------------------------------------------------------------------------------

export interface AlertTableRow {
  id: number;
  title: string;
  glyph: { kind: "icon"; state: AlertState; title: string } | { kind: "status"; status: string };
  name: string;
  cond: string;
  scope: { kind: "text"; text: string } | { kind: "inst"; name: string; sym: string | null };
  now: string;
  level: string;
  polarity: string;
  severity: string;
  agent: boolean;
  last: string;
  muted: boolean;
  expired: boolean;
}

export function alertTableRow(a: Alert): AlertTableRow {
  const dist = a.status === "triggered" ? null : alertDistance(a);
  const suffix = alertWhenSuffix(a);
  const name = a.instrument ? instName(a.instrument) : "";
  return {
    id: a.id,
    title: a.title,
    glyph:
      a.status === "active" || a.status === "triggered"
        ? { kind: "icon", state: alertState(a), title: alertFact(a) }
        : { kind: "status", status: a.status },
    name: unnameBuckets(a.title),
    cond: `${alertConditionText(a)}${a.note ? ` · ${a.note.length > 48 ? `${a.note.slice(0, 46)}…` : a.note}` : ""}${suffix ? ` · ${suffix}` : ""}${a.status === "triggered" && a.cooldown_days ? S.pause(a.cooldown_days) : ""}`,
    scope:
      a.scope === "portfolio"
        ? { kind: "text", text: S.portfolio }
        : a.scope === "bucket"
          ? {
              kind: "text",
              text: [S.bucket, bucketLabel(String(a.params.bucket ?? ""))]
                .filter(Boolean)
                .join(" "),
            }
          : a.instrument
            ? {
                kind: "inst",
                name,
                sym:
                  a.instrument.symbol && a.instrument.symbol !== name ? a.instrument.symbol : null,
              }
            : { kind: "text", text: "-" },
    now: alertNowText(a) ?? "-",
    level: `${alertLevelText(a) ?? ""}${dist ? ` · ${a.kind.startsWith("price") ? (a.kind === "price_below" ? "-" : "+") : ""}${dist.text}` : ""}`,
    polarity: a.polarity,
    severity: a.severity === "action" ? S.severityAction : S.severityInfo,
    agent: a.source === "agent",
    last: a.last_triggered_at ? dm(a.last_triggered_at) : "-",
    muted: a.status === "muted",
    expired: a.status === "expired",
  };
}

// ---- triggered history ------------------------------------------------------------------------------------

export interface HistoryRow {
  id: number;
  date: string;
  title: string;
  value: string;
  polarity: string;
  source: "agent" | "you" | "deleted";
  next: string;
  decision: string;
  decided: boolean;
}

/** Alert signals of the last 12 months, newest first. */
export function historySignals(signals: SignalV2[], now: number): SignalV2[] {
  const since = now - 365 * 86400000;
  return signals
    .filter(
      (s) =>
        (s.source === "alert" || s.rule_id.startsWith("alert:")) &&
        parseServerTime(s.first_seen_at) >= since,
    )
    .sort((a, b) => (b.first_seen_at ?? "").localeCompare(a.first_seen_at ?? ""));
}

function historyValue(s: SignalV2): string {
  const p = s.payload,
    c = typeof p.currency === "string" ? p.currency : undefined;
  if (typeof p.ratio === "number" || (typeof p.ratio === "string" && p.ratio))
    return ratioX(Number(p.ratio));
  if (typeof p.breakout_pct === "number") return pct(p.breakout_pct, true);
  if (typeof p.change === "number") return pct(p.change, true);
  if (typeof p.drawdown === "number") return pct(-p.drawdown);
  if (typeof p.weight === "number") return pct(p.weight);
  if (p.close != null) return price(Number(p.close), c);
  return "-";
}
function historyNext(s: SignalV2): string {
  if (s.status === "active") return S.signalOpen;
  if (s.status === "acknowledged") return S.acknowledged(dm(s.acknowledged_at));
  if (s.status === "resolved") return S.resolved(dm(s.closed_at));
  if (s.status === "expired") return S.expired(dm(s.closed_at));
  return s.status;
}
function historyDecision(s: SignalV2): string {
  const d = s.decisions[s.decisions.length - 1];
  if (!d) return "-";
  const verb = DECISION_ACTION[d.action] ?? d.action;
  const q =
    d.quantity != null && (d.action === "bought" || d.action === "sold")
      ? ` ${d.quantity}${d.price != null ? ` @ ${price(d.price, d.currency)}` : ""}`
      : "";
  return `${verb}${q}${d.reason ? S.reasonQuoted(d.reason.length > 40 ? `${d.reason.slice(0, 38)}…` : d.reason) : ""}`;
}
const historyTitle = (s: SignalV2, byId: Map<number, Alert>) =>
  byId.get(s.alert_id ?? -1)?.title ??
  (typeof s.payload.title === "string" ? s.payload.title : (s.instrument_label ?? S.alert));

export function historyRows(rows: SignalV2[], alerts: Alert[]): HistoryRow[] {
  const byId = new Map(alerts.map((a) => [a.id, a]));
  return rows.map((s) => {
    const a = byId.get(s.alert_id ?? -1);
    return {
      id: s.id,
      date: localDay(s.first_seen_at) ?? "",
      title: historyTitle(s, byId),
      value: historyValue(s),
      polarity: s.polarity ?? "neutral",
      source: a?.source === "agent" ? "agent" : a ? "you" : "deleted",
      next: historyNext(s),
      decision: historyDecision(s),
      decided: s.decisions.length > 0,
    };
  });
}

/** The history as CSV (formula prefixes in agent-written titles / reasons are neutralised by csvLine). */
export function historyCsv(rows: SignalV2[], alerts: Alert[]): string {
  const byId = new Map(alerts.map((a) => [a.id, a]));
  const lines = [
    csvLine(S.csvHeader),
    ...rows.map((s) =>
      csvLine([
        localDay(s.first_seen_at) ?? "",
        historyTitle(s, byId),
        historyValue(s),
        s.polarity ?? "",
        byId.get(s.alert_id ?? -1)?.source ?? "",
        historyNext(s),
        historyDecision(s),
      ]),
    ),
  ];
  return `﻿${lines.join("\n")}`;
}

// ---- the alert row (Home / asset page) --------------------------------------------------------------------

export interface AlertRowProps {
  trig: boolean;
  icon: { state: AlertState; title: string } | null;
  cond: string;
  agent: boolean;
  /** The condition line: plain text with bold values. */
  line: { key: string; text: string; bold: boolean }[];
  /** Right column: the distance with its bar, or the status (compact, not live). */
  dist: { text: string; fill: number } | null;
  status: string | null;
  remove: { label: string; title: string; onPress(): void } | null;
}

/** Old AlertRow: the state icon + title (+ agent badge), `teraz <b>now</b>`, the distance to the level with its
 * bar (home); `compact` (the asset page): the condition, `od d.m · teraz now` when met, else the distance. */
export function alertRowProps(
  a: Alert,
  o: {
    compact?: boolean;
    near?: { pricePct?: number | null; pp?: number | null } | null;
    onRemove?: () => void;
  },
): AlertRowProps {
  const trig = a.status === "triggered";
  const liveA = trig || a.status === "active";
  const dist = trig ? null : alertDistance(a);
  const level = dist?.level ?? alertLevelText(a);
  const now = alertNowText(a);
  const cond =
    o.compact && level && (a.kind === "price_below" || a.kind === "price_above")
      ? `${a.kind === "price_below" ? S.below : S.above} ${level}`
      : unnameBuckets(a.title);
  const suffix = alertWhenSuffix(a);
  const line: { key: string; text: string; bold: boolean }[] = [];
  const add = (key: string, text: string, bold = false) => {
    if (text !== "") line.push({ key, text, bold });
  };
  const nowPart = () => {
    if (now) {
      add("now-label", `${S.now} `);
      add("now", now, true);
    }
  };
  if (trig) {
    add("since", `${S.since} ${dm(a.last_triggered_at)}`);
    if (now) {
      add("sep", " · ");
      nowPart();
    }
  } else if (o.compact) {
    if (now) nowPart();
    else add("cond", alertConditionText(a));
    if (dist && level) {
      add("sep", " · ");
      add("dist", dist.text, true);
      add("level", ` ${S.to} ${level}`);
    }
  } else {
    add(
      "scope",
      a.scope === "portfolio" ? S.portfolioPrefix : a.scope === "bucket" ? S.bucketPrefix : "",
    );
    if (now) nowPart();
    else add("cond", alertConditionText(a));
    add(
      "suffix",
      `${a.kind === "volume_spike" ? S.avgOfSessions(Number(a.params.window_days ?? 20)) : ""}${suffix ? ` · ${suffix}` : ""}`,
    );
  }
  return {
    trig,
    icon: liveA ? { state: alertState(a, o.near), title: alertFact(a) } : null,
    cond,
    agent: a.source === "agent",
    line,
    dist:
      !o.compact && dist && level
        ? { text: `${dist.text} ${S.to} ${level}`, fill: Math.round(dist.fill * 100) }
        : null,
    status: o.compact && !liveA ? a.status : null,
    remove: o.onRemove
      ? { label: S.removeAria(a.title), title: S.removeAgentAlert, onPress: o.onRemove }
      : null,
  };
}
