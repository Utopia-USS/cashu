// The pure parts of the ported decision journal (ab24ab6 v2/Journal.tsx): the record's rows (decisions with the
// signal they answer, signals as they appeared, signals that expired or resolved without a decision) and the
// signal history rows; links and the undo come in as callbacks.
import { S, STATUS_L } from "@cashu/i18n/investments/v2/Journal.strings";
import { DECISION_ACTION, dm, qty, unitPrice } from "@cashu/ui-logic/investments/labels";
import type { Decision } from "@cashu/ui-logic/investments/types";
import { type JournalEntry, polarityOf, signalText } from "@cashu/ui-logic/investments/v2/logic";
import type { SignalV2 } from "@cashu/ui-logic/investments/v2/types";
import { canUndo } from "./legacy/undo.js";

const STATUS: Record<string, string> = STATUS_L;

/** One piece of a record line: plain text, an instrument link, or the muted `portfel`. */
export type Part =
  | { kind: "text"; key: string; text: string }
  | { kind: "link"; key: string; label: string; onPress(): void }
  | { kind: "muted"; key: string; text: string };

export interface RecordRow {
  key: string;
  date: string;
  dot: "nw" | "pos" | "neg" | "";
  head: string;
  main: Part[] | null;
  tail: { text: string; undo: { label: string; onPress(): void } | null } | null;
}

export interface JournalCallbacks {
  names: Map<number, string>;
  onOpenAsset(id: number): void;
  onUndo(d: Decision): void;
}

const instLink = (key: string, id: number | null, cb: JournalCallbacks): Part =>
  id == null
    ? { kind: "muted", key, text: S.portfolio }
    : {
        kind: "link",
        key,
        label: cb.names.get(id) ?? S.instrument(id),
        onPress: () => cb.onOpenAsset(id),
      };

/** The signal's words for a record line / the history (`lead bold tail`, else the title). */
const sigWords = (s: SignalV2, names: Map<number, string>) => {
  const t = signalText(s, { names });
  return (
    [t.lead?.replace(/ ·$/, ""), t.bold, t.tail?.replace(/^· /, "")].filter(Boolean).join(" ") ||
    t.title
  );
};

export function recordRow(
  e: JournalEntry<SignalV2, Decision> & { date: string },
  k: number,
  cb: JournalCallbacks,
): RecordRow | null {
  const s = e.signal,
    d = e.decision;
  const key = `${e.type}:${d?.id ?? s?.id}:${k}`;
  const date = dm(e.at);
  if (d) {
    const id = d.instrument_id ?? s?.instrument_id ?? null;
    const trade =
      d.quantity != null && (d.action === "bought" || d.action === "sold")
        ? ` · ${qty(d.quantity)}${d.price != null ? ` @ ${unitPrice(d.price, d.currency ?? "PLN")}` : ""}`
        : "";
    return {
      key,
      date,
      dot: "nw",
      head: S.decisionHead(DECISION_ACTION[d.action] ?? d.action),
      main: [
        instLink("inst", id, cb),
        ...(trade ? [{ kind: "text" as const, key: "trade", text: trade }] : []),
      ],
      tail: {
        text: `${d.reason ? S.reason(d.reason) : ""}${s ? S.onSignal(signalText(s, { names: cb.names }).title) : ""}`,
        undo: canUndo(d) ? { label: S.undoLower, onPress: () => cb.onUndo(d) } : null,
      },
    };
  }
  if (s && e.type === "signal") {
    const pol = polarityOf(s);
    const words =
      s.instrument_id != null ? sigWords(s, cb.names) : signalText(s, { names: cb.names }).title;
    const tail = s.decisions.length ? S.withDecision : s.status === "active" ? S.open : null;
    return {
      key,
      date,
      dot: pol === "positive" ? "pos" : pol === "negative" ? "neg" : "",
      head: pol === "positive" ? S.opportunity : pol === "negative" ? S.risk : S.signal,
      main: [
        ...(s.instrument_id != null
          ? [
              instLink("inst", s.instrument_id, cb),
              { kind: "text" as const, key: "sep", text: " · " },
            ]
          : []),
        { kind: "text", key: "words", text: words },
      ],
      tail: tail ? { text: tail, undo: null } : null,
    };
  }
  if (s)
    return {
      key,
      date,
      dot: "",
      head: e.type === "expired" ? S.expiredNoDecision : S.resolvedNoDecision,
      main: [
        ...(s.instrument_id != null
          ? [
              instLink("inst", s.instrument_id, cb),
              { kind: "text" as const, key: "sep", text: " · " },
            ]
          : []),
        { kind: "text", key: "title", text: signalText(s, { names: cb.names }).title },
      ],
      tail: null,
    };
  return null;
}

export interface HistoryLine {
  id: number;
  since: string;
  polarity: string;
  link: Part | null;
  words: string;
  status: string;
  decision: string | null;
  account: string | null;
}

export function historyLine(
  s: SignalV2,
  cb: JournalCallbacks,
  accName: (id: number | null) => string | null,
): HistoryLine {
  const last = s.decisions[s.decisions.length - 1];
  return {
    id: s.id,
    since: dm(s.first_seen_at),
    polarity: polarityOf(s),
    link: s.instrument_id != null ? instLink("inst", s.instrument_id, cb) : null,
    words:
      s.instrument_id != null ? sigWords(s, cb.names) : signalText(s, { names: cb.names }).title,
    status: `${STATUS[s.status] ?? s.status}${s.closed_at ? ` ${dm(s.closed_at)}` : ""}`,
    decision: last ? (DECISION_ACTION[last.action] ?? last.action) : null,
    account: accName(s.account_id),
  };
}
