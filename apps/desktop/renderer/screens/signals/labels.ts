/** Code -> catalog copy for the Signals screen. Tables are built per call so they follow the language. */
import type { SignalsNotice } from "./outcomes.js";
import { G } from "./Signals.strings.js";

const lookup = (table: Readonly<Record<string, string>>, value: string): string =>
  table[value] ?? G.code(value);

export const toneLabel = (value: string): string =>
  lookup({ positive: G.positive, negative: G.negative, neutral: G.neutral, mixed: G.mixed }, value);

/** Alert, signal and search-hit states plus alert severities share one vocabulary. */
export const statusLabel = (value: string): string =>
  lookup(
    {
      active: G.active,
      triggered: G.triggered,
      snoozed: G.snoozed,
      muted: G.muted,
      expired: G.expired,
      open: G.open,
      decided: G.decided,
      acknowledged: G.acknowledged,
      closed: G.closed,
      held: G.heldInstrument,
      watched: G.watched,
      saved: G.savedInstrument,
      new: G.new,
      info: G.info,
      action: G.urgent,
    },
    value,
  );

export const scopeLabel = (value: string): string =>
  lookup({ instrument: G.instrument, portfolio: G.portfolio, bucket: G.bucket }, value);

export const decisionLabel = (value: string): string =>
  lookup(
    {
      held: G.held,
      bought: G.buy,
      sold: G.sell,
      other: G.later,
      acknowledged: G.acknowledged,
    },
    value,
  );

export const runStatusLabel = (value: string): string =>
  lookup({ ok: G.runOk, partial: G.runPartial, failed: G.runFailed, running: G.runRunning }, value);

/** Exhaustive, so a new notice cannot silently fall back to "Saved". */
export function noticeLabel(notice: SignalsNotice): string {
  switch (notice) {
    case "saved":
      return G.saved;
    case "removed":
      return G.removed;
    case "restored":
      return G.restored;
    case "unknown":
      return G.unknown;
    case "unavailable":
      return G.writeUnavailable;
    case "previous_completed":
      return G.previousCompleted;
    case "previous_refused":
      return G.previousRefused;
    case "partial":
      return G.savedPartial;
    case "skipped":
      return G.alreadySettled;
    case "cleanup":
      return G.savedCleanup;
    case "cache":
      return G.savedCache;
    case "watch_warning":
      return G.savedWatchWarning;
    case "failed":
      return G.failed;
  }
}

/** Known refusal codes of the Signals writes get owner copy; anything else keeps its code for support. */
export function refusalLabel(code: string): string {
  switch (code) {
    case "scope_changed":
      return G.refusedScopeChanged;
    case "undo_expired":
      return G.refusedUndoExpired;
    case "no_signal":
    case "signal_closed":
    case "not_open":
      return G.refusedSignalClosed;
    case "no_decision":
      return G.refusedNoDecision;
    case "no_alert":
      return G.refusedNoAlert;
    case "alert_invalid":
    case "unknown_field":
      return G.refusedAlertInvalid;
    case "alert_expired":
      return G.refusedAlertExpired;
    case "agent_alert_limit":
      return G.refusedAgentAlertLimit;
    case "no_item":
      return G.refusedNoItem;
    case "watchlist_full":
      return G.refusedWatchlistFull;
    case "unknown_market":
      return G.refusedUnknownMarket;
    case "module_disabled":
      return G.refusedModuleDisabled;
    case "no_account":
      return G.refusedNoAccount;
    case "no_instrument":
    case "other_instrument":
    case "mixed_instruments":
      return G.refusedInstrument;
    case "invalid_currency":
      return G.refusedCurrency;
    case "negative_quantity":
    case "negative_price":
      return G.refusedNegative;
    default:
      return G.refusedCode(code);
  }
}

export function polarityGlyph(polarity: string): string {
  return polarity === "positive"
    ? G.glyphPositive
    : polarity === "negative"
      ? G.glyphNegative
      : G.glyphNeutral;
}

/** Badge role of an alert's state; the View maps the role onto tokens. */
export function alertBadgeTone(status: string): "positive" | "info" | "muted" {
  return status === "triggered" ? "positive" : status === "active" ? "info" : "muted";
}

export const pageTitle = (page: "alerts" | "watchlist" | "journal"): string =>
  page === "alerts" ? G.alerts : page === "watchlist" ? G.watchlist : G.journal;
