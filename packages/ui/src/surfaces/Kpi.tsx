import type { ReactNode } from "react";

type KpiTone = "negative" | "warning";
type HintTone = "positive" | "negative" | "warning";

const VALUE_TONE: Record<KpiTone, string> = { negative: "text-negative", warning: "text-warning" };
const HINT_TONE: Record<HintTone, string> = {
  positive: "text-positive",
  negative: "text-negative",
  warning: "text-warning",
};

export interface KpiProps {
  /** Small uppercase caption. */
  label: string;
  value: ReactNode;
  /** Muted line under the value (an empty line keeps its place, as the old card always rendered it). */
  hint?: ReactNode;
  /** Colour of the value (old `.value.neg` / `.value.warn`). */
  tone?: KpiTone;
  /** Colour of the hint (old `.hint.pos` / `.neg` / `.warn`). */
  hintTone?: HintTone;
}

/** One figure card (old ui.tsx `Kpi`, `.card.kpi`): card fill, border, radius 12, padding 16px 18px; an 11px
 * uppercase .04em muted label, a 23px 650 -.02em tabular value 6px below, a 12px muted hint 4px below. */
export function Kpi({ label, value, hint, tone, hintTone }: KpiProps) {
  return (
    <div className="rounded-widget border border-border bg-surface-raised px-4.5 py-4">
      <div className="text-2xs uppercase tracking-caps text-fg-muted">{label}</div>
      <div
        className={`mt-1.5 text-kpi font-heavy tracking-heading tabular-nums ${tone ? VALUE_TONE[tone] : ""}`}
      >
        {value}
      </div>
      <div className={`mt-1 text-xs ${hintTone ? HINT_TONE[hintTone] : "text-fg-muted"}`}>
        {hint ?? ""}
      </div>
    </div>
  );
}

export interface KpisProps {
  /** `Kpi` cards. */
  children: ReactNode;
}

/** A row of figure cards (old `.kpis`): auto-fit columns of at least 180px, gap 12px, 20px below. */
export function Kpis({ children }: KpisProps) {
  return (
    <div
      className="mb-5 grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
    >
      {children}
    </div>
  );
}
