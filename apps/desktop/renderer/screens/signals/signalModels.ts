/** Signal group view models: the Home rail, the full dialog, the keyboard cursor and the decision dialog. */
import { D, Money } from "@cashu/domain";
import type { views } from "@cashu/domain/investments";
import type { ReadySignals, SignalRow } from "@cashu/store/investments/signals-screen";
import { type SignalGroup, signalDisplayDay } from "./presentation.js";

/** Display currency when the valuation context is unavailable. */
export const FALLBACK_BASE_CURRENCY = "PLN";
export const groupLabel = (group: SignalGroup): string =>
  group.primary?.instrumentLabel ?? group.primary?.message ?? group.key;

export interface RailRow {
  readonly key: string;
  readonly label: string;
  readonly live: number;
  readonly tone: SignalGroup["state"];
  /** The signal the full dialog focuses when this row is opened. */
  readonly focus: string | null;
}
export interface RailSummary {
  readonly lastRun: { readonly day: string | null; readonly status: string } | null;
  readonly expired: number;
  readonly recent: readonly {
    readonly gid: string;
    readonly day: string | null;
    readonly action: string;
    readonly reason: string;
  }[];
}

export function railRows(groups: readonly SignalGroup[]): RailRow[] {
  return groups
    .filter((group) => !group.settled)
    .slice(0, 4)
    .map((group) => ({
      key: group.key,
      label: groupLabel(group),
      live: group.live.length,
      tone: group.state,
      focus: group.primary?.gid ?? null,
    }));
}

export function railSummary(data: ReadySignals): RailSummary {
  const run = data.lastRun;
  return {
    lastRun:
      run === null
        ? null
        : { day: signalDisplayDay(run.finishedAt ?? run.startedAt), status: run.status },
    expired: data.signals.filter((row) => row.status === "expired").length,
    recent: data.decisions.slice(0, 2).map((row) => ({
      gid: row.gid,
      day: signalDisplayDay(row.createdAt),
      action: row.action,
      reason: row.reason ?? "",
    })),
  };
}

export type GroupListRow =
  | { readonly key: string; readonly kind: "group"; readonly group: SignalGroup }
  | { readonly key: string; readonly kind: "signal"; readonly signal: SignalLine };

/** One signal line as the dialog renders it. */
export interface SignalLine {
  readonly gid: string;
  readonly polarity: string;
  readonly message: string;
  readonly day: string | null;
  readonly current: boolean;
  readonly snoozed: boolean;
  readonly instrument: string | null;
  readonly note: string | null;
  readonly segment: string | null;
  /** Deferring to the next deposit needs an undecided, unsnoozed signal and a contribution plan. */
  readonly deferUntil: string | null;
  /** The newest decision on this signal, which "Undo" reverts. */
  readonly lastDecision: string | null;
}

export function signalLine(row: SignalRow, nextDeposit: string | null): SignalLine {
  const lastDecision = row.decisions.at(-1)?.gid ?? null;
  return {
    gid: row.gid,
    polarity: row.polarity,
    message: row.message,
    day: signalDisplayDay(row.firstSeenAt),
    current: row.current,
    snoozed: row.snoozed,
    instrument: row.instrument,
    note: row.note,
    segment: typeof row.payload.segment === "string" ? row.payload.segment : null,
    deferUntil: row.decisions.length === 0 && !row.snoozed ? nextDeposit : null,
    lastDecision,
  };
}

function groupListRows(
  groups: readonly SignalGroup[],
  scope: SignalGroup["scope"],
  nextDeposit: string | null,
): GroupListRow[] {
  return groups
    .filter((group) => group.scope === scope)
    .flatMap((group): GroupListRow[] => [
      { key: group.key, kind: "group", group },
      ...group.signals.map(
        (row): GroupListRow => ({
          key: row.gid,
          kind: "signal",
          signal: signalLine(row, nextDeposit),
        }),
      ),
    ]);
}

export interface GroupSection {
  readonly rows: readonly GroupListRow[];
  readonly signals: number;
}
/** One column of the full dialog: its group headers and signal lines, and the signal count. */
export function groupSection(
  groups: readonly SignalGroup[],
  scope: SignalGroup["scope"],
  nextDeposit: string | null,
): GroupSection {
  const rows = groupListRows(groups, scope, nextDeposit);
  return { rows, signals: rows.filter((row) => row.kind === "signal").length };
}

/** Keyboard cursor over every listed signal, clamped to the ends. */
export function movedCursor(
  groups: readonly SignalGroup[],
  cursor: string | null,
  delta: number,
): string | null {
  const rows = groups.flatMap((group) => group.signals);
  const index = rows.findIndex((row) => row.gid === cursor);
  return rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.gid ?? null;
}

export function groupOfSignal(groups: readonly SignalGroup[], signal: string): string | null {
  return groups.find((group) => group.signals.some((row) => row.gid === signal))?.key ?? null;
}

/** "Until next deposit" snoozes to the end of that local day. */
export const snoozeInstant = (day: string): string => new Date(`${day}T23:59:00`).toISOString();

/** The decision dialog lists this many live signals of the group as context and counts the rest. */
const CONTEXT_ROWS = 5;

/** Title and context lines of the decision dialog for one group. */
export function decisionHeader(group: SignalGroup | null) {
  const live = group?.live ?? [];
  return {
    /** The group's instrument or, without one, its newest message. */
    title: group?.primary?.instrumentLabel ?? group?.primary?.message ?? "",
    context: live.slice(0, CONTEXT_ROWS).map((row) => ({
      gid: row.gid,
      message: row.message,
      day: signalDisplayDay(row.firstSeenAt),
    })),
    more: Math.max(0, live.length - CONTEXT_ROWS),
  };
}

type DecisionEstimate = NonNullable<ReturnType<typeof views.decisionEstimate>>;
/** The estimated trade value and, for a generic bucket, the weight it would leave. */
export function estimateView(estimate: DecisionEstimate) {
  return {
    value: new Money(estimate.amount, estimate.currency),
    allocation:
      estimate.allocation === null
        ? null
        : {
            afterWeight: D(String(estimate.allocation.afterWeight)),
            target: D(String(estimate.allocation.target)),
            driftPp: D(String(estimate.allocation.driftPp)),
          },
  };
}

export function suggestedAction(choice: string): "held" | "bought" | "sold" | "other" {
  return choice === "buy"
    ? "bought"
    : choice === "sell"
      ? "sold"
      : choice === "later"
        ? "other"
        : "held";
}

/** The display clock: the current minute, for display-only values (ages, "x minutes ago"). */
export function minuteInstant(date: Date): string {
  const minute = new Date(date.getTime());
  minute.setUTCSeconds(0, 0);
  return minute.toISOString();
}

/** The Signals query's read instant: the start of the local calendar day. A pure function of the day, so
 * every Signals surface (rail, pages, dialogs) asks for the same query key all day and switching pages
 * never reloads; the host's live clock replaces it where it is bound (always on the desktop host). */
export function dayReadInstant(today: string): string {
  return new Date(`${today}T00:00:00`).toISOString();
}
