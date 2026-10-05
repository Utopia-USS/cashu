// v2 widget primitives (design/v2/v2.css, ia-v2.md section 2): the grid on thirds, the widget frame
// (title + count tag + controls / body / footer facts), facts as label-value-detail triplets, the hero strip,
// polarity dots, the agent badge and alert status. Widgets are landmarks (`section` + aria-labelledby).
import { type CSSProperties, Fragment, type ReactNode, useId } from "react";
import { type Span, splitNarrowOrder, twoColumnOrder } from "./grid";

export interface GridItem {
  id: string;
  span: Span;
  node: ReactNode;
  /** Consecutive span-1 items with the same key share one column at three columns (`.stack`). */
  stack?: string;
  /** Two columns: a wide item placed after the pending pair of single widgets (grid.ts `defer`). */
  defer?: boolean;
}

/** `.g3` with the two-column order applied through `--o` (index.css) and stacked single columns. */
export function Grid({ items, className }: { items: GridItem[]; className?: string }) {
  const present = items.filter((it) => it.node != null && it.node !== false);
  const { order, alone } = twoColumnOrder(present.map(({ id, span, defer }) => ({ id, span, defer })));
  const cell = (it: GridItem) => (
    <div key={it.id} className={`gi s${it.span}${alone.has(it.id) ? " s1-full" : ""}`} style={{ "--o": order.get(it.id) } as CSSProperties}>
      {it.node}
    </div>
  );
  const out: ReactNode[] = [];
  for (let k = 0; k < present.length; k++) {
    const it = present[k];
    if (it.stack && it.span === 1) {
      const group = [it];
      while (k + 1 < present.length && present[k + 1].stack === it.stack && present[k + 1].span === 1) group.push(present[++k]);
      out.push(group.length > 1 ? <div key={`stack:${it.id}`} className="stack">{group.map(cell)}</div> : cell(it));
    } else out.push(cell(it));
  }
  return <div className={`g3 ${className ?? ""}`}>{out}</div>;
}

/** Grid cell with a main column (2/3) and a rail (1/3) aligned to the thirds of `.g3` (signals-rail.md 1):
 * 320 px rail at <= 1180 px, one column below 900 px with the rail's first two widgets on top
 * (`splitNarrowOrder` through `--o`). Each column is a stack with the grid gap. */
export function Split({ main, rail }: { main: Pick<GridItem, "id" | "node">[]; rail: Pick<GridItem, "id" | "node">[] }) {
  const order = splitNarrowOrder(main.map((x) => x.id), rail.map((x) => x.id));
  const cell = (it: Pick<GridItem, "id" | "node">) => <div key={it.id} className="si" style={{ "--o": order.get(it.id) } as CSSProperties}>{it.node}</div>;
  return (
    <div className="split">
      <div className="main">{main.map(cell)}</div>
      <div className="rail">{rail.map(cell)}</div>
    </div>
  );
}

/** Widget frame. `body`: "tight" (less top padding), "flush" (tables edge to edge) or both. */
export function Widget({ title, count, tags, controls, footer, hl, ghost, body, className, id, children, label }: {
  /** Header title; null = no header (then pass `label`). */
  title: ReactNode;
  count?: ReactNode;
  tags?: ReactNode;
  controls?: ReactNode;
  footer?: ReactNode;
  hl?: boolean;
  ghost?: boolean;
  body?: "tight" | "flush" | "tight flush" | "flush tight";
  className?: string;
  id?: string;
  children?: ReactNode;
  /** Accessible name when the title is not plain text. */
  label?: string;
}) {
  const hid = useId();
  return (
    <section className={`w ${hl ? "hl" : ""} ${ghost ? "ghost" : ""} ${className ?? ""}`} id={id}
      aria-labelledby={label ? undefined : hid} aria-label={label}>
      {(title != null || count != null || tags != null || controls != null) && (
        <div className="wh">
          {title != null && <h3 id={hid}>{title}</h3>}
          {count != null && <span className="tag">{count}</span>}
          {tags}
          {controls != null && <><span className="spacer" /><div className="ctl">{controls}</div></>}
        </div>
      )}
      {children != null && <div className={`wb ${body ?? ""}`}>{children}</div>}
      {footer != null && <div className="wf">{footer}</div>}
    </section>
  );
}

export interface FactItem { label: ReactNode; value: ReactNode; detail?: ReactNode; tone?: "pos" | "neg" | "warn"; small?: boolean; title?: string }

export function Fact({ label, value, detail, tone, small, title }: FactItem) {
  return (
    <div className="fact" title={title}>
      <div className="l">{label}</div>
      <div className={`v ${small ? "sm" : ""} ${tone ?? ""}`}>{value}</div>
      {detail != null && detail !== "" && <div className="d">{detail}</div>}
    </div>
  );
}

/** Facts in a grid of `cols` columns. */
export function Facts({ items, cols = 2, style }: { items: FactItem[]; cols?: number; style?: CSSProperties }) {
  return (
    <div className="facts" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, ...style }}>
      {items.map((f, i) => <Fact key={i} {...f} />)}
    </div>
  );
}

/** Hero strip (span 3): the one hero figure, a delta line, facts with dividers, status on the right. */
export function Hero({ label, value, delta, facts, right, meta, ariaLabel }: {
  label: ReactNode; value: ReactNode; delta?: ReactNode; facts: FactItem[]; right?: ReactNode; meta?: ReactNode; ariaLabel: string;
}) {
  return (
    <section className="w hero" aria-label={ariaLabel}>
      <div className="h1">
        <div className="l">{label}</div>
        <div className="v">{value}</div>
        {delta != null && <div className="d">{delta}</div>}
      </div>
      <div className="hf">{facts.map((f, i) => <Fact key={i} {...f} />)}</div>
      {(right != null || meta != null) && (
        <div className="hr">
          {right}
          {meta != null && <div className="meta">{meta}</div>}
        </div>
      )}
    </section>
  );
}

/** Agent-created item badge (`A agent` / `A alert agenta`); `mono` = the monogram only (compact rows), the
 * text then goes to the tooltip and screen readers. */
export function AgentTag({ text = "agent", mono }: { text?: string; mono?: boolean }) {
  if (mono) return <span className="tag agent mono" title={text}><i aria-hidden>A</i><span className="sr-only">{text}</span></span>;
  return <span className="tag agent" title="Dodane przez agenta"><i aria-hidden>A</i>{text}</span>;
}

export type Polarity = "positive" | "negative" | "neutral";
const POL: Record<Polarity, string> = { positive: "pos", negative: "neg", neutral: "neu" };
export const POLARITY_LABEL: Record<Polarity, string> = { positive: "szansa", negative: "ryzyko", neutral: "neutralny" };

/** Polarity dot (green chance, red risk, grey neutral or decided). */
export function PolDot({ polarity, quiet, className }: { polarity: Polarity | string; quiet?: boolean; className?: string }) {
  const cls = quiet ? "neu" : POL[polarity as Polarity] ?? "neu";
  return <span className={`pd ${cls} ${className ?? ""}`} aria-hidden />;
}

/** "● szansa" with the polarity colour (alerts table, history). */
export function PolarityText({ polarity }: { polarity: string }) {
  const p = (polarity in POL ? polarity : "neutral") as Polarity;
  return <span className={`polt ${POL[p]}`}><i aria-hidden />{POLARITY_LABEL[p]}</span>;
}

export const ALERT_STATUS: Record<string, [label: string, cls: string]> = {
  active: ["aktywny", "active"], triggered: ["wyzwolony", "trig"], snoozed: ["uśpiony", "snz"], muted: ["wyciszony", "mute"], expired: ["wygasł", "mute"],
};

export function AlertStatus({ status }: { status: string }) {
  const [label, cls] = ALERT_STATUS[status] ?? [status, "mute"];
  return <span className={`status ${cls}`}><i aria-hidden />{label}</span>;
}

/** Footer items separated like the mock: `label <b>value</b>`. */
export function FootFacts({ items }: { items: (ReactNode | null | false | undefined)[] }) {
  return <>{items.filter(Boolean).map((x, i) => <Fragment key={i}><span>{x}</span></Fragment>)}</>;
}
