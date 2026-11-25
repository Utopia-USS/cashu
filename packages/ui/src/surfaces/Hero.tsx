import type { ReactNode } from "react";
import { Fact, type FactProps } from "./Fact.js";

export interface HeroProps {
  /** Accessible name of the strip. */
  label: string;
  /** Caption of the hero figure. */
  caption: ReactNode;
  /** The one hero figure (30px). */
  value: ReactNode;
  /** Muted line under the figure (13px), e.g. a toned weekly move plus text. */
  delta?: ReactNode;
  /** The facts right of the figure, split by dividers (values 16px); the `statement` variant shows none (its
   * facts live in the cards under it). */
  facts: readonly FactProps[];
  /** Status column at the right end, right-aligned (stacked items, 6px apart). */
  right?: ReactNode;
  /** Muted 12px line under `right`. */
  meta?: ReactNode;
  /** Free content after the facts (e.g. an action slot that places itself with `ml-auto self-center`). */
  children?: ReactNode;
  /** `strip` (default): the framed figure | facts | status strip. `statement` (investments home, design V5):
   * no frame, the caption as a quiet sentence-case line (with `meta` after it: filters, status tags), the
   * figure at the statement size (64px bold; pass dimmed parts inside `value`), `delta` under it and `right`
   * (the page actions) at the top right. */
  variant?: "strip" | "statement";
}

function StatementHero({ label, caption, value, delta, right, meta }: HeroProps) {
  return (
    <section
      aria-label={label}
      className="relative z-10 mt-2 mb-7 flex min-w-0 flex-wrap items-start gap-x-6 gap-y-4"
    >
      <div className="min-w-0">
        <div className="flex min-h-6 flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs-plus text-fg-muted">
          {caption != null && caption !== "" && (
            <span className="font-medium text-fg-secondary">{caption}</span>
          )}
          {meta}
        </div>
        <div className="mt-3.5 mb-2.5 whitespace-nowrap text-statement font-bold leading-none tracking-dense text-fg tabular-nums">
          {value}
        </div>
        {delta != null && (
          <div className="flex min-h-5 items-center gap-2.5 text-sm text-fg-muted">{delta}</div>
        )}
      </div>
      {right != null && <div className="ml-auto flex flex-wrap items-center gap-2.5">{right}</div>}
    </section>
  );
}

/** The hero strip over a dashboard grid (old `.w.hero`): figure | facts | status. */
export function Hero(props: HeroProps) {
  if (props.variant === "statement") return <StatementHero {...props} />;
  const { label, caption, value, delta, facts, right, meta, children } = props;
  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-row flex-wrap items-stretch gap-y-3 rounded-widget border border-border bg-surface-raised px-5 py-3.5 shadow-card"
    >
      <div className="mr-2 min-w-62.5 border-r border-border pr-6 max-narrow:border-r-0">
        <div className="text-2xs uppercase tracking-label text-fg-muted">{caption}</div>
        <div className="mt-0.5 text-4xl-plus font-heavy leading-hero tracking-tight text-fg tabular-nums">
          {value}
        </div>
        {delta != null && <div className="mt-0.75 text-sm text-fg-muted">{delta}</div>}
      </div>
      <div className="flex flex-1 flex-wrap items-center gap-y-2.5">
        {facts.map((fact, index) => (
          <Fact
            // biome-ignore lint/suspicious/noArrayIndexKey: facts are a fixed, ordered list without ids.
            key={index}
            {...fact}
            size="md"
            className="border-r border-border px-5 last:border-r-0"
          />
        ))}
      </div>
      {(right != null || meta != null) && (
        <div className="ml-auto flex flex-col items-end justify-center gap-1.5 pl-4 max-wide:ml-0 max-wide:items-start max-wide:pl-0">
          {right}
          {meta != null && <div className="text-right text-xs text-fg-muted">{meta}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
