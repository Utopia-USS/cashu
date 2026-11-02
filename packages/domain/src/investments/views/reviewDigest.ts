/** Read-only review aggregation. Every input is native typed facts, never a persisted result tree. */

import type { UiLang } from "../../core/i18n.js";
import { addDays, type DateTime, type IsoDate, toStorage, utcIso } from "../../dates.js";
import { D, type Decimal, roundFloat } from "../../decimal.js";
import { alertMessage } from "../alerts/index.js";
import {
  allWarnings,
  type InstrumentId,
  instrumentLabel,
  type PriceBar,
  warningMessage,
} from "../domain/index.js";
import { canonicalImporterId } from "../importing/index.js";
import { driftBucketGeneric, withBucketGeneric } from "../rules/index.js";
import type { LastReviewFact, ReviewClock } from "./reviewSchedule.js";
import { reviewPolicyView } from "./reviewSchedule.js";
import type { PortfolioViewState, ViewSignal } from "./types.js";

export interface DigestDecision {
  readonly id: string;
  readonly signal: string | null;
  readonly signals: readonly string[];
  readonly instrument: string | null;
  readonly account: string | null;
  readonly action: string;
  readonly quantity: Decimal | null;
  readonly price: Decimal | null;
  readonly currency: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
}
export interface DigestImport {
  readonly id: string;
  readonly account: string;
  readonly importer: string;
  readonly broker: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly inserted: number;
  readonly duplicates: number;
  readonly positions: number;
  readonly renames: number;
  readonly statusChanges: number;
  readonly newInstruments: number;
  readonly corrections: number;
  readonly warnings: number;
  readonly createdAt: string;
}
export interface DigestRun {
  readonly id: string;
  readonly startedAt: string;
  readonly status: string;
  readonly errors: readonly unknown[];
  readonly escalated: readonly string[];
}
export interface DigestPeriod {
  readonly since: IsoDate;
  readonly sinceAt: string;
  readonly baseline: "since" | "review" | "default_7d";
}
export interface DigestFlows {
  readonly contributions: Decimal | null;
  readonly transfers: Decimal | null;
  readonly implied: Decimal;
}
export interface ReviewDigestInput {
  readonly current: PortfolioViewState;
  readonly previous: PortfolioViewState | null;
  readonly clock: ReviewClock;
  readonly lang: UiLang;
  readonly period: DigestPeriod;
  readonly lastReview: LastReviewFact | null;
  readonly signals: readonly ViewSignal[];
  readonly decisions: readonly DigestDecision[];
  readonly imports: readonly DigestImport[];
  readonly runs: readonly DigestRun[];
  readonly labels: ReadonlyMap<string, string>;
  readonly goodRun: string | null;
  readonly flows: DigestFlows;
  readonly strategyVersion: number | null; // float-ok: Python integer strategy version counter.
  readonly strategyState: string;
  readonly strategyVersionDates: readonly string[];
  readonly research: Readonly<Record<string, unknown>>;
  readonly priceMoveBars: ReadonlyMap<InstrumentId, readonly PriceBar[]>;
}

const after = (at: string | DateTime | null, since: string): boolean =>
  at !== null && toStorage(at) >= toStorage(since);
const percent = (a: Decimal | null, b: Decimal | null): number | null =>
  a === null || b === null || b.isZero() ? null : roundFloat(a.div(b).toFloat(), 6);
const moment = (at: DateTime | null): string | null => (at === null ? null : utcIso(at));
const source = (rule: string): string =>
  rule.startsWith("alert:")
    ? "alert"
    : rule.startsWith("plan:")
      ? "plan"
      : rule.startsWith("research:")
        ? "research"
        : "rule";
const alert = (rule: string): string | null => (rule.startsWith("alert:") ? rule.slice(6) : null);

export function decisionDigestView(d: DigestDecision) {
  return {
    id: d.id,
    signal_id: d.signal,
    signal_ids: [...d.signals],
    instrument_id: d.instrument,
    account_id: d.account,
    action: d.action,
    quantity: d.quantity,
    price: d.price,
    currency: d.currency,
    reason: d.reason,
    created_at: utcIso(d.createdAt),
  };
}
export function importDigestView(b: DigestImport) {
  return {
    id: b.id,
    account_id: b.account,
    importer: canonicalImporterId(b.importer),
    broker: b.broker,
    file_name: b.fileName,
    file_sha256: b.sha256,
    inserted: b.inserted,
    duplicates: b.duplicates,
    positions: b.positions,
    renames: b.renames,
    status_changes: b.statusChanges,
    new_instruments: b.newInstruments,
    corrections: b.corrections,
    warnings: b.warnings,
    created_at: utcIso(b.createdAt),
  };
}

export function reviewDigestView(input: ReviewDigestInput) {
  const { current, clock, period } = input;
  const since = period.since,
    sinceAt = period.sinceAt;
  const rows = input.signals.filter(
    (s) => s.kind !== "allocation_drift" || driftBucketGeneric(s.payload),
  );
  const newRows = rows.filter((s) => after(s.firstSeenAt, sinceAt));
  const newIds = new Set(newRows.map((s) => s.id));
  const runs = input.runs.filter((r) => after(r.startedAt, sinceAt));
  const escalatedAt = new Map<string, string>();
  for (const run of runs)
    for (const id of run.escalated) {
      const old = escalatedAt.get(id);
      if (old === undefined || toStorage(old) < toStorage(run.startedAt))
        escalatedAt.set(id, run.startedAt);
    }
  const escalated = rows.filter((s) => escalatedAt.has(s.id) && !newIds.has(s.id));
  const resolved = rows.filter(
    (s) => (s.status === "resolved" || s.status === "expired") && after(s.closedAt, sinceAt),
  );
  const open = rows.filter((s) => s.status === "active" || s.status === "acknowledged");
  const bySignal = new Map<string, DigestDecision[]>();
  for (const d of input.decisions)
    for (const sid of d.signals.length ? d.signals : d.signal === null ? [] : [d.signal])
      bySignal.set(sid, [...(bySignal.get(sid) ?? []), d]);
  const signalView = (s: ViewSignal) => {
    const label = s.instrumentId === null ? null : (input.labels.get(s.instrumentId) ?? null);
    const [code, params] = alertMessage(s.kind, s.payload, s.message, label);
    const note = source(s.ruleId) === "research" ? s.payload.note_id : null;
    return {
      id: s.id,
      rule_id: s.ruleId,
      kind: s.kind,
      dedup_key: s.dedupKey,
      severity: s.severity,
      polarity: s.polarity,
      source: source(s.ruleId),
      alert_id: alert(s.ruleId),
      note_id:
        typeof note === "string" || typeof note === "bigint" || typeof note === "boolean"
          ? note
          : null,
      status: s.status,
      message: s.message,
      message_code: code,
      message_params: params,
      instrument_id: s.instrumentId,
      instrument_label: label,
      account_id: s.accountId,
      payload: withBucketGeneric(s.kind, s.payload),
      first_seen_at: moment(s.firstSeenAt),
      last_seen_at: moment(s.lastSeenAt),
      acknowledged_at: moment(s.acknowledgedAt),
      closed_at: moment(s.closedAt),
      snoozed_until: moment(s.snoozedUntil),
      snoozed: s.snoozedUntil !== null && toStorage(s.snoozedUntil) > toStorage(clock.now),
      current: input.goodRun === null || s.lastRun === null || s.lastRun === input.goodRun,
      decisions: (bySignal.get(s.id) ?? []).map(decisionDigestView),
    };
  };
  const fields = (s: ViewSignal) => {
    const view = signalView(s);
    return {
      signal_id: s.id,
      alert_id: view.alert_id,
      kind: s.kind,
      rule_id: s.ruleId,
      severity: s.severity,
      polarity: s.polarity,
      status: s.status,
      message: s.message,
      message_code: view.message_code,
      message_params: view.message_params,
      instrument_id: s.instrumentId,
      instrument_label: view.instrument_label,
      bucket_id: s.payload.bucket_id ?? null,
    };
  };
  const batches = input.imports.filter((b) => after(b.createdAt, sinceAt));
  const decisions = input.decisions.filter((d) => after(d.createdAt, sinceAt));
  const events: { order: string; value: Readonly<Record<string, unknown>> }[] = [];
  const add = (
    type: string,
    at: string | DateTime,
    data: Readonly<Record<string, unknown>>,
    dateOnly = false,
  ) => {
    const instant = dateOnly ? clock.midnight(String(at)) : at;
    events.push({
      order: toStorage(instant),
      value: {
        type,
        at: dateOnly ? String(at) : utcIso(at),
        date: dateOnly ? String(at) : clock.localDate(at),
        ...data,
      },
    });
  };
  for (const s of newRows)
    add(
      source(s.ruleId) === "alert" ? "alert_triggered" : "signal_created",
      s.firstSeenAt,
      fields(s),
    );
  for (const s of escalated)
    add("signal_escalated", escalatedAt.get(s.id) ?? s.lastSeenAt, fields(s));
  for (const s of resolved) if (s.closedAt !== null) add("signal_resolved", s.closedAt, fields(s));
  for (const b of batches)
    add("import", b.createdAt, {
      batch_id: b.id,
      account_id: b.account,
      file_name: b.fileName,
      inserted: b.inserted,
      duplicates: b.duplicates,
    });
  for (const d of decisions)
    add("decision", d.createdAt, {
      decision_id: d.id,
      signal_id: d.signal,
      action: d.action,
      instrument_id: d.instrument,
      instrument_label: d.instrument === null ? null : (input.labels.get(d.instrument) ?? null),
      reason: d.reason,
    });
  const periodTxns = current.txns.filter((t) => since < t.tradeDate && t.tradeDate <= current.asOf);
  for (const t of periodTxns)
    if (t.type === "deposit" || t.type === "withdrawal")
      add(
        t.type,
        t.tradeDate,
        { account_id: t.accountId, amount: t.cashAmount, currency: t.cashCurrency },
        true,
      );
  for (const r of runs)
    if ((r.status === "failed" || r.status === "partial") && r.errors.length)
      add("data_warning", r.startedAt, {
        run_id: r.id,
        status: r.status,
        message: r.errors[0],
        count: r.errors.length,
      });
  events.sort((a, b) => (a.order < b.order ? 1 : a.order > b.order ? -1 : 0));
  const created = current.txns.filter((t) => after(t.createdAt, sinceAt));
  const byType = new Map<string, number>();
  for (const t of created) byType.set(t.type, (byType.get(t.type) ?? 0) + 1);
  const dividends = new Map<string, Decimal>();
  for (const t of current.txns)
    if (t.type === "dividend" && t.tradeDate >= since)
      dividends.set(t.cashCurrency, (dividends.get(t.cashCurrency) ?? D("0")).add(t.cashAmount));
  const then = input.previous?.valued.totalBase ?? null;
  const now = current.valued.totalBase;
  const change = then === null ? null : now.sub(then);
  const { contributions, transfers, implied } = input.flows;
  const marketChange =
    change === null || contributions === null || transfers === null
      ? null
      : change.sub(contributions).sub(transfers).sub(implied);
  const policy = reviewPolicyView(current.config, clock, input.lastReview, input.lang);
  const moves = [
    ...new Map(
      current.valued.valued
        .filter((v) => v.valuationMode === "market")
        .map((v) => [v.instrument.id, v.instrument]),
    ).values(),
  ]
    .flatMap((inst) => {
      const bars = (input.priceMoveBars.get(inst.id) ?? []).filter(
        (b) => addDays(since, -31) <= b.date && b.date <= current.asOf,
      );
      const start = [...bars].reverse().find((b) => b.date <= since),
        end = bars.at(-1);
      if (start === undefined || end === undefined || start.close.lte(D("0"))) return [];
      const fraction = end.close.sub(start.close).div(start.close).toFloat();
      if (Math.abs(fraction) < 0.05) return [];
      return [
        {
          instrument_id: inst.id,
          label: instrumentLabel(inst),
          currency: end.currency ?? inst.currency,
          from_date: start.date,
          from: start.close,
          to_date: end.date,
          to: end.close,
          change_pct: roundFloat(fraction, 6),
        },
      ];
    })
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
  return {
    as_of: current.asOf,
    since,
    since_at: utcIso(sinceAt),
    until_at: utcIso(clock.now),
    baseline: period.baseline,
    events: events.slice(0, 200).map((e) => e.value),
    events_total: events.length,
    last_review:
      input.lastReview === null
        ? null
        : {
            done_at: utcIso(input.lastReview.doneAt),
            notes: input.lastReview.notes,
            stats: input.lastReview.stats,
          },
    digest_weekday: policy.day,
    review_due: policy.due,
    review: {
      name: policy.name,
      every: policy.every,
      day: policy.day,
      cards: policy.cards,
      next_on: policy.next_on,
    },
    value: {
      currency: current.base,
      then,
      now,
      change,
      change_pct: percent(change, then),
      contributions,
      transfers,
      implied_funding: then === null ? null : implied,
      market_change: marketChange,
      market_change_pct: percent(marketChange, then),
    },
    signals: {
      new: newRows.map(signalView),
      escalated: escalated.map(signalView),
      resolved: resolved.map(signalView),
      open: open.length,
      undecided: open.filter((s) => !bySignal.has(s.id)).length,
    },
    imports: batches.map((b) => ({
      ...importDigestView(b),
      account_name: current.accounts.find((a) => a.id === b.account)?.name ?? null,
    })),
    transactions: {
      count: created.length,
      by_type: Object.fromEntries([...byType].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      manual: created.filter((t) => t.source === "manual").length,
    },
    decisions: decisions.map(decisionDigestView),
    dividends: Object.fromEntries([...dividends].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    price_moves: moves,
    warnings: allWarnings(current.valued).map((w) => ({
      kind: w.kind,
      message: warningMessage(w),
      account_id: "accountId" in w ? w.accountId : null,
      instrument_id: "instrumentId" in w ? w.instrumentId : null,
    })),
    stale_count: current.valued.valued.filter((v) => v.isStale).length,
    strategy: {
      version: input.strategyVersion,
      state: input.strategyState,
      changed_since: input.strategyVersionDates.some((at) => after(at, sinceAt)),
    },
    research: input.research,
  };
}
