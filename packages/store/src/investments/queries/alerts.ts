// Alerts and watchlist rows (Python `store/alerts.py`, read side). Soft-deleted alerts are left out
// of every alert query except `deletedAlert`; removed watchlist rows are left out of every watchlist
// query except `watchRowFor`.
//
// Alert status: the view stores the clock-free fold status (S25 D-S1); expiry and the end of a snooze
// depend on the reader's clock. Every alert read here takes `now` and exposes ONLY the effective
// status (`effectiveAlertStatus`, R-S2), so no caller can show a stale `snoozed`.
import type { DateTime } from "@cashu/domain";
import * as domainAlerts from "@cashu/domain/investments/alerts";
import { gidOf, instrumentRoot, jsonObject, jsonStrings, type Read } from "./shared.js";

type EffectiveAlertStatus = domainAlerts.EffectiveAlertStatus;
type StoredAlertStatus = domainAlerts.StoredAlertStatus;

/** Statuses that count towards the agent cap: an alert that can still fire (Python `LIVE_STATUSES`). */
export const LIVE_ALERT_STATUSES: ReadonlySet<EffectiveAlertStatus> = new Set([
  "active",
  "triggered",
  "snoozed",
]);

export interface AlertView {
  readonly gid: string;
  readonly instrument: string | null;
  readonly scope: string;
  readonly kind: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly polarity: string;
  readonly severity: string;
  readonly title: string;
  readonly note: string | null;
  readonly tag: string | null;
  readonly source: string;
  readonly createdBy: string;
  /** The effective status at the reader's `now`. */
  readonly status: EffectiveAlertStatus;
  readonly cooldownDays: number | null;
  readonly expiresAt: string | null;
  /** Null once the snooze ended or the alert expired (as a reader sees it). */
  readonly snoozedUntil: string | null;
  readonly lastTriggeredAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastValue: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

interface AlertRow {
  gid: string;
  instrument: string | null;
  scope: string;
  kind: string;
  params: string;
  polarity: string;
  severity: string;
  title: string;
  note: string | null;
  tag: string | null;
  source: string;
  created_by: string;
  status: StoredAlertStatus;
  cooldown_days: number | null;
  expires_at: string | null;
  snoozed_until: string | null;
  last_triggered_at: string | null;
  last_checked_at: string | null;
  last_value: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const ALERT_SQL = `SELECT a.gid, ${gidOf("a.instrument_id")} AS instrument, a.scope, a.kind, a.params,
  a.polarity, a.severity, a.title, a.note, a.tag, a.source, a.created_by, a.status, a.cooldown_days,
  a.expires_at, a.snoozed_until, a.last_triggered_at, a.last_checked_at, a.last_value, a.created_at,
  a.updated_at, a.deleted_at FROM alerts a`;

function toAlert(r: AlertRow, now: DateTime | string): AlertView {
  const effective = domainAlerts.effectiveAlertStatus(r, now);
  return {
    gid: r.gid,
    instrument: r.instrument,
    scope: r.scope,
    kind: r.kind,
    params: jsonObject(r.params),
    polarity: r.polarity,
    severity: r.severity,
    title: r.title,
    note: r.note,
    tag: r.tag,
    source: r.source,
    createdBy: r.created_by,
    status: effective.status,
    cooldownDays: r.cooldown_days,
    expiresAt: r.expires_at,
    snoozedUntil: effective.snoozed_until,
    lastTriggeredAt: r.last_triggered_at,
    lastCheckedAt: r.last_checked_at,
    lastValue: r.last_value,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

/** Python `alerts`: the live (not deleted) alerts in fold order; `statuses` filters by effective status. */
export function alerts(
  read: Read,
  now: DateTime | string,
  statuses?: Iterable<EffectiveAlertStatus>,
): AlertView[] {
  const only = statuses === undefined ? undefined : new Set(statuses);
  return read<AlertRow>(`${ALERT_SQL} WHERE a.deleted_at IS NULL ORDER BY a.id`)
    .map((r) => toAlert(r, now))
    .filter((a) => only === undefined || only.has(a.status));
}

/** Python `alert`: a live alert of this vault, else undefined. */
export function alertByGid(read: Read, gid: string, now: DateTime | string): AlertView | undefined {
  const r = read<AlertRow>(`${ALERT_SQL} WHERE a.gid = ? AND a.deleted_at IS NULL`, gid)[0];
  return r === undefined ? undefined : toAlert(r, now);
}

/** Python `deleted_alert`: a soft-deleted alert of this vault (restore), else undefined. */
export function deletedAlert(
  read: Read,
  gid: string,
  now: DateTime | string,
): AlertView | undefined {
  const r = read<AlertRow>(`${ALERT_SQL} WHERE a.gid = ? AND a.deleted_at IS NOT NULL`, gid)[0];
  return r === undefined ? undefined : toAlert(r, now);
}

/** Python `live_agent_alerts`: agent alerts that can still fire (the agent cap counts these). */
export function liveAgentAlerts(read: Read, now: DateTime | string): number {
  return alerts(read, now).filter((a) => a.source === "agent" && LIVE_ALERT_STATUSES.has(a.status))
    .length;
}

export interface AlertCounts {
  readonly active: number;
  readonly triggered: number;
  readonly snoozed: number;
  readonly muted: number;
  readonly expired: number;
  readonly agentLive: number;
}

/** Python `alert_counts`: live alerts per effective status plus the agent alerts that can still fire. */
export function alertCounts(read: Read, now: DateTime | string): AlertCounts {
  const live = alerts(read, now);
  const n = (s: EffectiveAlertStatus) => live.filter((a) => a.status === s).length;
  return {
    active: n("active"),
    triggered: n("triggered"),
    snoozed: n("snoozed"),
    muted: n("muted"),
    expired: n("expired"),
    agentLive: live.filter((a) => a.source === "agent" && LIVE_ALERT_STATUSES.has(a.status)).length,
  };
}

// ------------------------------------------------------------------ watchlist

export interface WatchlistItem {
  readonly gid: string;
  readonly instrument: string;
  readonly note: string | null;
  readonly tags: readonly string[];
  readonly source: string;
  readonly addedAt: string;
  readonly removedAt: string | null;
}

type WatchRow = Omit<WatchlistItem, "tags"> & { tags: string };
const toItem = (r: WatchRow): WatchlistItem => ({ ...r, tags: jsonStrings(r.tags) ?? [] });

const WATCH_SQL = `SELECT w.gid, ${gidOf("w.instrument_id")} AS instrument, w.note, w.tags, w.source,
  w.added_at AS addedAt, w.removed_at AS removedAt FROM watchlist_items w`;

/** Python `watchlist`: the active rows, oldest first. */
export function watchlist(read: Read): WatchlistItem[] {
  return read<WatchRow>(`${WATCH_SQL} WHERE w.removed_at IS NULL ORDER BY w.added_at, w.id`).map(
    toItem,
  );
}

/** Python `watchlist_item`: an active row of this vault by its row gid, else undefined. */
export function watchlistItem(read: Read, gid: string): WatchlistItem | undefined {
  const item = read<WatchRow>(`${WATCH_SQL} WHERE w.gid = ?`, gid)[0];
  return item === undefined || item.removedAt !== null ? undefined : toItem(item);
}

/** Python `watch_row_for`: the one row of the instrument whatever its state. */
export function watchRowFor(read: Read, instrument: string): WatchlistItem | undefined {
  const r = read<WatchRow>(
    `${WATCH_SQL} WHERE w.instrument_id = (SELECT id FROM view_ids WHERE gid = ?)`,
    instrumentRoot(read, instrument),
  )[0];
  return r === undefined ? undefined : toItem(r);
}

/** Python `watched_item_for`: the active row of the instrument, else undefined. */
export function watchedItemFor(read: Read, instrument: string): WatchlistItem | undefined {
  const r = watchRowFor(read, instrument);
  return r === undefined || r.removedAt !== null ? undefined : r;
}

/** Python `watched_instrument_ids`: instruments on the active watchlist. */
export function watchedInstrumentGids(read: Read): Set<string> {
  return new Set(watchlist(read).map((w) => w.instrument));
}
