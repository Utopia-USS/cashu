// Instrument identity (design/v2/instrument-label/instrument-label.md; owner feedback GF9): one component names an
// instrument on the investments pages. `row` / `compact` / `header`: a black ticker tile of one fixed width per
// density (every tile alike; the classify icon is the only unclassified cue) + the name; `inline`: today's name + muted symbol (signal titles, no tile). Status markers that change how the
// row's numbers read (flags, agent badge) follow the name; everything that only identifies the instrument sits in
// a hover card (facts only, no actions, no bucket: F7-generic). The card is a fixed-position portal (it must not
// be clipped by the scrolling Aktywa table or the signals dialog), opens 350 ms after the pointer enters the
// label or at once on keyboard focus of the name, closes on leave, blur, Esc, scroll and resize. Without hover
// (touch) there is no card: the label carries a one-line `title` instead.
import { type CSSProperties, type FocusEvent, Fragment, type MouseEvent, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { instCardFacts, instMono, instName, type InstLike, instSummary } from "./logic";

export type InstDensity = "row" | "compact" | "inline" | "header";
export type { InstLike };

const CLS: Record<InstDensity, string> = { row: "il", compact: "il cmp", inline: "il inl", header: "il hd" };
const OPEN_DELAY = 350;

/** The tile: same width for every monogram of a density; a 5-character one (`00241`, `BRK-B`), or 4 capitals with
 * two or more of the widest letters (`WWWW`, `MMMM`), steps the type down (`data-n="5"`) instead of widening it. */
function Tile({ inst }: { inst: InstLike }) {
  const mono = instMono(inst);
  const dense = mono.length >= 5 || (mono.length === 4 && (mono.match(/[WM]/g) ?? []).length >= 2);
  return <span className="av" data-n={dense ? "5" : undefined} aria-hidden>{mono}</span>;
}

export function InstLabel({ inst, density = "row", onOpen, text, accounts, stale, badges, action, sub, card }: {
  inst: InstLike;
  density?: InstDensity;
  /** Set: the name is `button.nm` (opens the asset); unset: plain text. */
  onOpen?: (id: number | string) => void;
  /** Display text override (signal titles); default the instrument's name. */
  text?: ReactNode;
  /** Account labels (already formatted) for the card's `rachunek` row; omitted for watched instruments. */
  accounts?: string[];
  /** Price date when the price is stale (card status `cena z d.m`). */
  stale?: string | null;
  /** Status markers after the name: flags, AgentTag, research tag. */
  badges?: ReactNode;
  /** After the badges: `ClassifyButton` (Aktywa only). */
  action?: ReactNode;
  /** Second line (row, compact) or the muted span after the name (header). */
  sub?: ReactNode;
  /** Hover card; default on, except `header`. */
  card?: boolean;
}) {
  const withCard = card ?? density !== "header";
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [touch] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(hover: none)").matches);
  const hover = useHoverCard(ref, withCard && !touch);
  const name = text ?? instName(inst);
  const facts = { accounts, stale };
  const nameNode = onOpen
    ? <button className="nm" onClick={() => onOpen(inst.id)} aria-describedby={hover.open ? id : undefined}>{name}</button>
    : <span className="nmt">{name}</span>;
  const title = withCard && touch ? instSummary(inst, facts) : undefined;
  const cardNode = hover.open && ref.current ? <InstCard anchor={ref.current} id={id} inst={inst} accounts={accounts} stale={stale} /> : null;
  if (density === "inline") {
    const sym = inst.symbol && inst.symbol !== name ? inst.symbol : null;
    return (
      <span className={CLS.inline} ref={ref} title={title} {...hover.handlers}>
        {nameNode}{sym && <span className="sym">{sym}</span>}{badges}{cardNode}
      </span>
    );
  }
  return (
    <span className={CLS[density]} ref={ref} title={title} {...hover.handlers}>
      <Tile inst={inst} />
      <span className="tx">
        <span className="ln">{nameNode}{badges}{action}{density === "header" && sub != null && sub !== "" && <span className="sub">{sub}</span>}</span>
        {density !== "header" && sub != null && sub !== "" && <span className="sub">{sub}</span>}
      </span>
      {cardNode}
    </span>
  );
}

/** Open / close of the hover card: pointer over the tile or the name (after a delay) and leave, keyboard focus of
 * the name button (`:focus-visible`) and blur, Esc (consumed only while the card is open), scroll and resize. The
 * row's action (the classify icon and its popover, a React child even when portaled) never opens it and closes
 * it, so the card cannot cover the popover or take its Esc. */
function useHoverCard(ref: RefObject<HTMLSpanElement>, enabled: boolean) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current != null) { clearTimeout(timer.current); timer.current = null; } };
  const hide = () => { clear(); setOpen(false); };
  useEffect(() => clear, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); hide(); } };
    // Window capture runs before the modals' document listeners: Esc closes the card, not the dialog under it.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!enabled) return { open: false, handlers: {} };
  const isName = (t: EventTarget | null) => t instanceof HTMLElement && t.matches("button.nm") && ref.current?.contains(t);
  return {
    open,
    handlers: {
      onMouseOver: (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest?.(".menu-anchor, .pop")) { hide(); return; }
        if (!open && timer.current == null) timer.current = setTimeout(() => { timer.current = null; setOpen(true); }, OPEN_DELAY);
      },
      onMouseLeave: hide,
      onFocus: (e: FocusEvent) => { if (isName(e.target) && (e.target as HTMLElement).matches(":focus-visible")) { clear(); setOpen(true); } },
      onBlur: hide,
    },
  };
}

/** The card: tile + name + `symbol · exchange`, then klasa / rachunek / ISIN, then status tags (not-normal only). */
function InstCard({ anchor, id, inst, accounts, stale }: { anchor: HTMLElement; id: string; inst: InstLike; accounts?: string[]; stale?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ top: 0, left: 0, visibility: "hidden" });
  const f = instCardFacts(inst, { accounts, stale });
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
    const below = a.bottom + 6 + h <= window.innerHeight - 8;
    setPos(below || a.top - 6 - h < 8 ? { top: a.bottom + 6, left } : { bottom: window.innerHeight - a.top + 6, left });
  }, [anchor]);
  return createPortal(
    <div className="ilc" role="tooltip" id={id} ref={ref} style={pos}>
      <div className="ih"><span className="il"><Tile inst={inst} /></span><div><b>{f.head[0]}</b>{f.head[1] && <span>{f.head[1]}</span>}</div></div>
      {f.rows.length > 0 && (
        <div className="kvl">{f.rows.map(([k, v]) => <Fragment key={k}><span className="k">{k}</span><span className={k === "ISIN" ? "tnum" : undefined}>{v}</span></Fragment>)}</div>
      )}
      {f.status.length > 0 && <div className="st">{f.status.map((t) => <span key={t} className={`tag ${t === "koszt + odsetki" || t === "wycena ręczna" ? "" : "solid warn"}`}>{t}</span>)}</div>}
    </div>,
    document.body,
  );
}

/** The tag icon that replaces the `sklasyfikuj` pill (opens the existing classification popover). */
export function ClassifyButton({ name, expanded, onClick }: { name: string; expanded: boolean; onClick: () => void }) {
  return (
    <button type="button" className="il-cls" title="Sklasyfikuj · poza alokacją i regułami" aria-label={`Sklasyfikuj ${name}`} aria-haspopup="dialog" aria-expanded={expanded} onClick={onClick}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden>
        <path d="M2.75 2.75h4.6c.4 0 .78.16 1.06.44l4.84 4.84a1.5 1.5 0 0 1 0 2.12l-3.1 3.1a1.5 1.5 0 0 1-2.12 0L3.19 8.41A1.5 1.5 0 0 1 2.75 7.35z" />
        <circle cx={5.75} cy={5.75} r={1} fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}
