// The instrument hover card (ab24ab6 v2/InstLabel.tsx: useTouch, useHoverCard, HoverCard, InstCard; index.css
// `.ilc`): a fixed-position portal under the anchor (above it when there is no room below), opened 350 ms after the
// pointer enters or at once on keyboard focus of the name, closed on leave, blur, Esc, scroll and resize. Without
// hover (touch) there is no card: the caller sets a one-line title instead.

import {
  type CSSProperties,
  type FocusEvent,
  Fragment,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { InstTile, type InstTileProps } from "../instruments/InstTile.js";
import { Tag } from "../surfaces/Tag.js";

const OPEN_DELAY = 350;

/** True without hover (touch). */
export function useTouch(): boolean {
  const [touch] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(hover: none)").matches,
  );
  return touch;
}

export interface HoverHandlers {
  onMouseOver?(e: MouseEvent<HTMLElement>): void;
  onMouseLeave?(): void;
  onFocus?(e: FocusEvent<HTMLElement>): void;
  onBlur?(): void;
}

/** Open / close of the card; `anchor` is the hovered element while the card is open. The classify icon (marked
 * `data-classify`) never opens it and closes it. */
export function useHoverCard(enabled: boolean): {
  anchor: HTMLElement | null;
  handlers: HoverHandlers;
} {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const hide = () => {
    clear();
    setAnchor(null);
  };
  useEffect(
    () => () => {
      if (timer.current != null) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    // Window capture runs before the modals' document listeners: Esc closes the card, not the dialog under it.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor]);
  if (!enabled) return { anchor: null, handlers: {} };
  return {
    anchor,
    handlers: {
      onMouseOver: (e) => {
        if ((e.target as HTMLElement).closest?.("[data-classify]")) {
          hide();
          return;
        }
        if (!anchor && timer.current == null) {
          const el = e.currentTarget;
          timer.current = setTimeout(() => {
            timer.current = null;
            setAnchor(el);
          }, OPEN_DELAY);
        }
      },
      onMouseLeave: hide,
      onFocus: (e) => {
        const t = e.target;
        if (
          t instanceof HTMLButtonElement &&
          !t.hasAttribute("data-classify") &&
          t.matches(":focus-visible")
        ) {
          clear();
          setAnchor(e.currentTarget);
        }
      },
      onBlur: hide,
    },
  };
}

/** The `.ilc` frame: fixed under the anchor, kept inside the viewport. */
export interface HoverCardProps {
  anchor: HTMLElement;
  id: string;
  /** `.ilc.gain`: no minimum width, values right-aligned. */
  gain?: boolean;
  children: ReactNode;
}

export function HoverCard({ anchor, id, gain, children }: HoverCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ top: 0, left: 0, visibility: "hidden" });
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
    const below = a.bottom + 6 + h <= window.innerHeight - 8;
    setPos(
      below || a.top - 6 - h < 8
        ? { top: a.bottom + 6, left }
        : { bottom: window.innerHeight - a.top + 6, left },
    );
  }, [anchor]);
  return createPortal(
    <div
      role="tooltip"
      id={id}
      ref={ref}
      style={pos}
      className={`pointer-events-none fixed z-80 max-w-80 rounded-md border border-border bg-surface-raised px-3 py-2.5 text-left text-xs-plus leading-widget text-fg shadow-toast ${gain ? "min-w-0" : "min-w-60"}`}
    >
      {children}
    </div>,
    document.body,
  );
}

/** One `.kvl` row: key, value, value tone (`hv rule` warn 600, `hv info` muted, ISIN tabular). */
export interface CardRow {
  key: string;
  value: string;
  tone?: "rule" | "review" | "info" | "tnum" | "positive" | "negative";
}

const rowTone = {
  rule: "font-strong text-warning",
  review: "",
  info: "text-fg-muted",
  tnum: "tabular-nums",
  positive: "tabular-nums text-positive",
  negative: "tabular-nums text-negative",
} as const;

/** `.kvl`: key | value grid (keys muted, at least 64px). */
export function CardRows({ rows, alignEnd }: { rows: CardRow[]; alignEnd?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(--spacing(16),max-content)_minmax(0,1fr)] gap-x-2.5 gap-y-0.75">
      {rows.map((r) => (
        <Fragment key={`${r.key}:${r.value}`}>
          <span className="text-fg-muted">{r.key}</span>
          <span className={`${r.tone ? rowTone[r.tone] : ""} ${alignEnd ? "text-right" : ""}`}>
            {r.value}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

export interface InstCardProps {
  tile: InstTileProps;
  name: string;
  /** `symbol · exchange`. */
  detail: string;
  rows: CardRow[];
  /** Status tags (not-normal only): warn solid, except cost / manual valuation (plain). */
  status: { text: string; warn: boolean }[];
}

/** InstCard: tile + name + `symbol · exchange`, the fact rows, the status tags. */
export function InstCardBody({ tile, name, detail, rows, status }: InstCardProps) {
  return (
    <>
      <div className="mb-2 flex items-center gap-2.5">
        <InstTile {...tile} />
        <div>
          <b className="block text-sm-plus font-strong leading-tight">{name}</b>
          {detail && <span className="block text-xs text-fg-muted">{detail}</span>}
        </div>
      </div>
      {rows.length > 0 && <CardRows rows={rows} />}
      {status.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {status.map((t) => (
            <Tag key={t.text} tone={t.warn ? "warning" : "neutral"} solid={t.warn}>
              {t.text}
            </Tag>
          ))}
        </div>
      )}
    </>
  );
}
