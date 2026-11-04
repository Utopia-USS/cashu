/** Journal view models: the yearly timeline of decisions and signals of one instrument or all. */
import type { ReadySignals } from "@cashu/store/investments/signals-screen";
import {
  decisionUndoOpen,
  type JournalEntry,
  journalTimeline,
  signalDisplayDay,
} from "./presentation.js";

export type JournalFilter = "all" | "decisions" | "signals";
/** One row of the journal timeline as the Journal page renders it. */
export type JournalLine =
  | Extract<JournalEntry, { kind: "year" | "month" }>
  | {
      readonly kind: "decision";
      readonly id: string;
      readonly day: string | null;
      readonly action: string;
      readonly reason: string;
      readonly linked: number;
      readonly instrument: string | null;
      /** Still inside the undo window. */
      readonly undoable: boolean;
    }
  | {
      readonly kind: "signal";
      readonly id: string;
      readonly day: string | null;
      readonly message: string;
      readonly status: string;
      /** The newest decision's action, or null when the signal has none. */
      readonly decision: string | null;
      readonly instrument: string | null;
    };
export interface JournalModel {
  readonly rows: readonly JournalLine[];
  readonly decisions: number;
  readonly signals: number;
}

function journalLine(entry: JournalEntry, asOf: string): JournalLine {
  if (entry.kind === "year" || entry.kind === "month") return entry;
  if (entry.kind === "decision")
    return {
      kind: "decision",
      id: entry.id,
      day: signalDisplayDay(entry.at),
      action: entry.row.action,
      reason: entry.row.reason ?? "",
      linked: entry.row.signals.length,
      instrument: entry.row.instrument,
      undoable: decisionUndoOpen(asOf, entry.row.createdAt),
    };
  return {
    kind: "signal",
    id: entry.id,
    day: signalDisplayDay(entry.at),
    message: entry.row.message,
    status: entry.row.status,
    decision: entry.row.decisions.length ? (entry.row.decisions.at(-1)?.action ?? "") : null,
    instrument: entry.row.instrument,
  };
}

/** The journal of one instrument (or all): timeline rows and counts. */
export function journalModel(
  data: ReadySignals,
  instrument: string,
  filter: JournalFilter,
): JournalModel {
  const matches = (row: { readonly instrument: string | null }) =>
    instrument === "" || row.instrument === instrument;
  const signals = data.signals.filter(matches);
  const decisions = data.decisions.filter(matches);
  const rows = journalTimeline(decisions, signals, filter).map((entry) =>
    journalLine(entry, data.asOf),
  );
  return { rows, decisions: decisions.length, signals: signals.length };
}
