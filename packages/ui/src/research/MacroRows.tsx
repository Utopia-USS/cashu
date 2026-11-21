/// <reference lib="dom" />
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { RowMarks } from "../instruments/RowMarks.js";

const DOT = " · ";

export type MacroTone = "positive" | "negative" | "warning" | "neutral";

export interface MacroMetric {
  label: string;
  text: string;
  /** An old quote: the value muted. */
  stale?: boolean;
  title?: string;
}

export interface MacroRowData {
  /** The regime key (`data-macro`). */
  id: string;
  label: string;
  /** The title opens the regime's drawer. */
  onOpen(): void;
  /** No data for the regime: this word instead of the state, the row muted. */
  missing?: string | null;
  /** The state words (`hossa`, `odwrócona`): the first in the regime's tone, the rest warning. */
  states: readonly { text: string; tone: MacroTone }[];
  /** `od <miesiąc rok>`; its tooltip the state history. */
  since?: string | null;
  sinceTitle?: string;
  /** The last quote is old: `dane z d.m` in warning, titled. */
  stale?: { text: string; title: string } | null;
  /** One basic number. */
  number?: { text: string; title: string } | null;
  /** New agent notes: the page mark, titled. */
  unread?: string | null;
  /** The brief's bold headline (or the plain sentence). */
  headline: string;
  /** The brief's note id (`data-brief`). */
  briefId?: number | null;
  why?: string | null;
  supports?: { label: string; items: readonly string[] } | null;
  risks?: { label: string; items: readonly string[] } | null;
  /** The hover / focus explanation (head, paragraph, up to three metrics). */
  explain?: { head: string; text: string; metrics: readonly MacroMetric[] } | null;
}

const stateTone: Record<MacroTone, string> = {
  positive: "text-positive",
  negative: "text-negative",
  warning: "text-warning",
  neutral: "text-fg",
};

/** `Co sprzyja` / `Na co uważać` (old `.mrow .bl`): a small label and up to three short bullets, the bullet green
 * (`sup`) or amber (`rsk`). */
export function BriefList({
  label,
  items,
  tone,
}: {
  label: string;
  items: readonly string[];
  tone: "sup" | "rsk";
}) {
  return (
    <div className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-xs leading-cozy">
      <span className="whitespace-nowrap pt-px text-2xs font-strong text-fg-muted">{label}</span>
      <ul className="m-0 grid list-none gap-px p-0">
        {items.map((t) => (
          <li
            key={t}
            className={`relative pl-2.5 text-fg before:absolute before:top-[.6em] before:left-0 before:size-1 before:rounded-full before:content-[''] ${tone === "sup" ? "before:bg-positive" : "before:bg-warning"}`}
          >
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The label / value pairs of a regime (old `.xm`): a rule above, muted labels, bold tabular values. */
export function MacroMetrics({ metrics }: { metrics: readonly MacroMetric[] }) {
  return (
    <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-t border-border pt-1.5 text-xs">
      {metrics.map((m) => (
        <MetricPair key={m.label} m={m} />
      ))}
    </div>
  );
}

function MetricPair({ m }: { m: MacroMetric }) {
  return (
    <>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap text-fg-muted">
        {m.label}
      </span>
      <b
        title={m.title}
        className={`whitespace-nowrap font-strong tabular-nums ${m.stale ? "text-fg-muted" : "text-fg"}`}
      >
        {m.text}
      </b>
    </>
  );
}

/** Escape hides the explanation while the pointer rests on the row or focus is inside it (WCAG 1.4.13); it shows
 * again once the pointer leaves or focus moves out (old research primitives `useExplainDismiss`). */
function useExplainDismiss(ref: RefObject<HTMLLIElement | null>, enabled: boolean) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (el.matches(":hover") || el.contains(document.activeElement)))
        setHidden(true);
    };
    const onLeave = () => setHidden(false);
    const onOut = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) setHidden(false);
    };
    document.addEventListener("keydown", onKey);
    el.addEventListener("mouseleave", onLeave);
    el.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("keydown", onKey);
      el.removeEventListener("mouseleave", onLeave);
      el.removeEventListener("focusout", onOut);
    };
  }, [ref, enabled]);
  return hidden;
}

// `.mx`: shown on the row's hover / focus after .25s, hidden at once (the visibility waits for the fade).
const popShown =
  "group-hover/mrow:visible group-hover/mrow:opacity-100 group-hover/mrow:[transition:opacity_120ms_250ms,visibility_0s_linear_250ms] group-focus-within/mrow:visible group-focus-within/mrow:opacity-100 group-focus-within/mrow:[transition:opacity_120ms_250ms,visibility_0s_linear_250ms] motion-reduce:group-hover/mrow:[transition:none] motion-reduce:group-focus-within/mrow:[transition:none]";

function MacroRow({ r }: { r: MacroRowData }) {
  const xid = useId();
  const explain = r.explain ?? null;
  const ref = useRef<HTMLLIElement>(null);
  const hidden = useExplainDismiss(ref, explain != null);
  return (
    <li
      ref={ref}
      data-macro={r.id}
      className={`group/mrow relative py-1.75 text-sm ${r.missing ? "opacity-62" : ""}`}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <button
          type="button"
          aria-describedby={explain ? xid : undefined}
          onClick={r.onOpen}
          className="max-w-full cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-0 bg-transparent p-0 text-left font-strong text-fg hover:text-accent hover:underline hover:underline-offset-2"
        >
          {r.label}
        </button>
        {r.missing ? (
          <b className="whitespace-nowrap font-medium text-fg-muted">{r.missing}</b>
        ) : (
          r.states.map((s, i) => (
            <b
              key={s.text}
              className={`whitespace-nowrap font-strong ${i === 0 ? stateTone[s.tone] : "text-warning"}`}
            >
              {s.text}
            </b>
          ))
        )}
        {(r.since || r.stale) && (
          <span
            title={r.sinceTitle}
            className="whitespace-nowrap text-2xs-plus text-fg-muted tabular-nums"
          >
            {r.since}
            {r.since && r.stale ? DOT : null}
            {r.stale && (
              <span className="text-warning" title={r.stale.title}>
                {r.stale.text}
              </span>
            )}
          </span>
        )}
        {r.number && (
          <span
            title={r.number.title}
            className="whitespace-nowrap text-2xs-plus text-fg-muted tabular-nums"
          >
            {r.number.text}
          </span>
        )}
        {r.unread && <RowMarks flag={null} alert={null} notes={r.unread} />}
      </div>
      <div
        data-brief={r.briefId ?? undefined}
        className="mt-0.75 text-sm font-strong leading-cozy text-fg"
      >
        {r.headline}
      </div>
      {r.why && <div className="mt-0.5 text-xs-plus leading-widget text-fg-muted">{r.why}</div>}
      {r.supports && r.supports.items.length > 0 && (
        <BriefList label={r.supports.label} items={r.supports.items} tone="sup" />
      )}
      {r.risks && r.risks.items.length > 0 && (
        <BriefList label={r.risks.label} items={r.risks.items} tone="rsk" />
      )}
      {explain && (
        <div
          role="tooltip"
          id={xid}
          className={`invisible absolute top-[calc(100%+2px)] -left-2 z-50 w-[min(420px,calc(100vw-32px))] rounded-md border border-border bg-surface-raised px-3 py-2.5 opacity-0 shadow-toast [transition:opacity_120ms,visibility_0s_linear_120ms] before:absolute before:-top-1 before:right-0 before:left-0 before:h-1 before:content-[''] max-wide:w-[min(360px,calc(100vw-32px))] max-narrow:left-0 max-narrow:w-[calc(100vw-32px)] motion-reduce:[transition:none] ${hidden ? "" : popShown}`}
        >
          <div className="mb-1 text-xs text-fg-muted tabular-nums">{explain.head}</div>
          <p className="m-0 whitespace-pre-line text-xs-plus leading-normal text-fg">
            {explain.text}
          </p>
          {explain.metrics.length > 0 && <MacroMetrics metrics={explain.metrics.slice(0, 3)} />}
        </div>
      )}
    </li>
  );
}

/** The five macro regimes side by side (old MacroWidgets `MacroRows wide`, `.mrows.wide .mrow`): title, toned
 * state, `od <miesiąc rok>`, one basic number, then the brief (headline, why, Co sprzyja / Na co uważać); hover or
 * focus opens the explanation under the row (Escape hides it); the title opens the regime. */
export function MacroRows({ label, rows }: { label: string; rows: readonly MacroRowData[] }) {
  return (
    <ul
      aria-label={label}
      className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-5 p-0"
    >
      {rows.map((r) => (
        <MacroRow key={r.id} r={r} />
      ))}
    </ul>
  );
}
