// The macro regimes of the research layer (ab24ab6 research/MacroWidgets.tsx MacroRow / MacroStrip): the five rows'
// texts for packages/ui MacroRows, and the Home's macro widget before the first research run (the regimes come
// from the daily check, not from research runs). Pure formatting over ui-logic's macro.ts.
import { S } from "@cashu/i18n/investments/v2/research/MacroWidgets.strings";
import type { MacroRowData, MacroTone } from "@cashu/ui";
import { dm } from "@cashu/ui-logic/investments/labels";
import {
  explainHead,
  explainText,
  hasExplain,
  historyTitle,
  macroAsOf,
  macroHeadline,
  macroNoteKey,
  macroNumber,
  metricTitle,
  sinceMonth,
  staleText,
  stateParts,
  toneCls,
} from "@cashu/ui-logic/investments/v2/research/macro";
import type { MacroRegime, MacroRegimes } from "@cashu/ui-logic/investments/v2/research/types";

const TONE: Record<string, MacroTone> = { pos: "positive", neg: "negative", warn: "warning" };

/** A regime's state words: the first in the regime's tone, the rest (e.g. `odwrócona`) warning. */
export const macroStates = (r: Pick<MacroRegime, "state_label" | "tone">) =>
  stateParts(r.state_label).map((text, i) => ({
    text,
    tone: i === 0 ? (TONE[toneCls(r.tone)] ?? "neutral") : ("warning" as MacroTone),
  }));

/** Old MacroRow: one regime as the packages/ui row; `onOpen` gets the regime's note key (`macro_<key>`). */
function macroRowOf(r: MacroRegime, onOpen: (noteKey: string) => void): MacroRowData {
  const b = r.missing ? null : (r.brief ?? null);
  const stale = staleText(r);
  return {
    id: r.key,
    label: r.label,
    onOpen: () => onOpen(macroNoteKey(r.key)),
    missing: r.missing ? S.noData : null,
    states: macroStates(r),
    since: sinceMonth(r),
    sinceTitle: historyTitle(r) ?? undefined,
    stale: stale ? { text: stale, title: S.lastQuote } : null,
    number: macroNumber(r),
    unread: r.unread > 0 ? S.nNewNotes(r.unread) : null,
    headline: macroHeadline(r),
    briefId: b?.note_id ?? null,
    why: b?.why ?? null,
    supports: b?.supports.length ? { label: S.supports, items: b.supports } : null,
    risks: b?.risks.length ? { label: S.risks, items: b.risks } : null,
    explain: hasExplain(r)
      ? {
          head: explainHead(r),
          text: explainText(r) ?? "",
          metrics: (r.missing ? [] : r.metrics).map((m) => ({
            label: m.label,
            text: m.text,
            stale: !!m.stale,
            title: metricTitle(m),
          })),
        }
      : null,
  };
}

export interface MacroStripProps {
  kind: "macro";
  /** `stan d.m` (the last session in the data), null without a date. */
  asOf: { text: string; title: string } | null;
  label: string;
  rows: MacroRowData[];
}

/** Old MacroStrip: null without regimes. */
export function macroStripProps(
  macro: MacroRegimes | null,
  onOpen: (noteKey: string) => void,
): MacroStripProps | null {
  if (!macro?.regimes.length) return null;
  const asOf = macroAsOf(macro);
  return {
    kind: "macro",
    asOf: asOf ? { text: S.stateOn(dm(asOf)), title: S.lastSession } : null,
    label: S.macro,
    rows: macro.regimes.map((r) => macroRowOf(r, onOpen)),
  };
}
