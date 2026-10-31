// v2 investments payload shapes the shared UI logic reads (signals, alerts, calendar, instrument search; they
// mirror service/views.py). Types only.
import type { Num, Signal } from "../types.js";

export interface Alert {
  id: number;
  kind: string;
  scope: "instrument" | "portfolio" | "bucket" | string;
  instrument_id: number | null;
  instrument: {
    id: number | string;
    label: string;
    symbol: string | null;
    name: string;
    isin: string | null;
    currency: string;
    asset_class: string;
    valuation_mode: string | null;
  } | null;
  params: Record<string, unknown>;
  unit: "price" | "ratio" | "none" | string | null;
  polarity: Polarity | string;
  severity: "info" | "action" | string;
  title: string;
  note: string | null;
  source: "user" | "agent" | string;
  created_by: string | null;
  status: "active" | "triggered" | "snoozed" | "muted" | "expired" | string;
  cooldown_days: number | null;
  expires_at: string | null;
  snoozed_until: string | null;
  last_triggered_at: string | null;
  last_checked_at: string | null;
  last_value: Num;
  signal: { id: number; status: string; message: string; first_seen_at: string | null } | null;
  /** F8 BE (dynamic kinds): the last run's range (range_breakout) or the average volume (volume_spike). */
  state?: {
    range_low?: number | string | null;
    range_high?: number | string | null;
    range_pct?: number | null;
    close?: number | null;
    currency?: string | null;
    average_volume?: number | string | null;
    volume?: number | null;
    ratio?: number | null;
    window_days?: number | null;
  } | null;
  created_at: string | null;
  updated_at: string | null;
}

/** One dated event of the review's calendar card (`GET /investments/calendar`): a high-impact macro release
 * (public feed), earnings of a held / watched US instrument (public list, matched on the server) or a research
 * note's `details.event_date`. `time`: "HH:MM" local, "przed sesją" / "po sesji", or null. */
export interface CalendarEvent {
  date: string;
  time: string | null;
  kind: "macro" | "earnings" | "research" | string;
  title: string;
  country: string | null;
  country_label: string | null;
  instrument_id: number | null;
  label: string | null;
  held: boolean | null;
  note_id: number | null;
}

/** The profile's entry state of a hit: held (in holdings), watched (active watch row), saved (referenced, e.g. a
 * removed watch row or research notes), new (not in the profile). */
export type EntryState = "held" | "watched" | "saved" | "new";

export type Polarity = "positive" | "negative" | "neutral";

// ---- instrument search (F12 B4) -------------------------------------------------------------------
export interface SearchHit {
  /** Stable per hit: `i:<id>` (instrument), `y:<symbol>` (remote). */
  key: string;
  instrument_id: number | null;
  state: EntryState | string;
  symbol: string;
  yahoo_symbol: string | null;
  name: string;
  exchange: string | null;
  mic: string | null;
  asset_class: string;
  /** Remote hits: the market's currency hint, may be wrong (never shown). */
  currency: string | null;
  isin: string | null;
  source: "local" | "yahoo" | "openfigi" | string;
}

/** A search hit picked to watch (F12 B3): the backend verifies the Yahoo symbol and reads the currency from it. */
export interface SearchPick {
  yahoo_symbol: string;
  ticker?: string | null;
  name?: string | null;
  asset_class?: string | null;
  mic?: string | null;
  isin?: string | null;
}

export interface SearchResult {
  query: string;
  local: SearchHit[];
  remote: SearchHit[];
  remote_status: "ok" | "unavailable" | "skipped" | string;
}

export interface SignalV2 extends Signal {
  polarity?: Polarity | string;
  source?: "rule" | "alert" | string;
  alert_id?: number | null;
  snoozed_until?: string | null;
  snoozed?: boolean;
  /** Alert signals (F6 BE): `alert.<kind>` + params for the Polish fact (core/messages.ts); null for rules. */
  message_code?: string | null;
  message_params?: Record<string, unknown> | null;
  /** F8 BE: the profile's last non-failed rules run confirmed it (research signals: true); absent on older servers. */
  current?: boolean | null;
  /** F8 BE: the instrument is held in any account of the profile (null for portfolio-wide signals). */
  held?: boolean | null;
}

/** Exactly one of `pick`, `instrument_id`, `symbol_or_isin`. */
export interface WatchInput {
  symbol_or_isin?: string;
  instrument_id?: number;
  pick?: SearchPick;
  note?: string | null;
  currency?: string | null;
  tags?: string[] | null;
}
