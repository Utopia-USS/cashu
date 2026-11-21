// The deck's top card (ab24ab6 v2/ReviewDeck.tsx SwipeCard): drag sideways to answer (120 px), the stamp shows
// which way it goes; while flying it leaves the window, rotated. Generic deck chrome: a candidate for packages/ui
// once a second deck needs it (packages/ui is outside this port's ownership).
import { type PointerEvent, type ReactNode, useRef, useState } from "react";

export type SwipeVerdict = "keep" | "flag";

// `.rd-card` (+ `.top`, `.anim`): the card frame, 20px radius, the deck shadow, rotating around 50% 90%.
export const deckCard =
  "absolute inset-0 flex origin-[center_90%] touch-pan-y flex-col overflow-hidden rounded-2xl border border-border bg-surface-raised shadow-deck";
const anim = "transition-[transform,opacity] duration-260 ease-deck motion-reduce:transition-none";
// `.rd .stamp` (+ `.k` / `.f`): the verdict stamp, hidden until dragged.
const stamp =
  "pointer-events-none absolute top-5.5 z-5 rounded-md border-2 border-current bg-surface-raised px-3 py-1.5 text-lg font-black";

const DRAG_START = 8;
const SWIPE = 120;

export function SwipeCard({
  card,
  flying,
  onSwipe,
  stampKeep,
  stampFlag,
  children,
}: {
  /** The card's id as `data-card` (e2e and the screenshot harness find the top card by it). */
  card: string;
  flying: SwipeVerdict | null;
  onSwipe(verdict: SwipeVerdict): void;
  stampKeep: string;
  stampFlag: string;
  children: ReactNode;
}) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; on: boolean } | null>(null);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, textarea, input, a")) return;
    drag.current = { x: e.clientX, y: e.clientY, dx: 0, on: false };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.dx = e.clientX - d.x;
    if (!d.on && Math.abs(d.dx) > DRAG_START && Math.abs(d.dx) > Math.abs(e.clientY - d.y)) {
      d.on = true;
      setDragging(true);
      el.current?.setPointerCapture(e.pointerId);
    }
    if (d.on) setDx(d.dx);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d?.on) return;
    if (Math.abs(d.dx) > SWIPE) onSwipe(d.dx > 0 ? "keep" : "flag");
    else setDx(0);
  };
  const out = flying ? (flying === "keep" ? 1 : -1) * Math.max(window.innerWidth, 700) : dx;
  const style = out
    ? {
        transform: `translateX(${out}px) rotate(${out / 18}deg)`,
        ...(flying ? { opacity: 0 } : {}),
      }
    : undefined;
  return (
    <div
      ref={el}
      data-card={card}
      className={`${deckCard} select-none ${dragging ? "" : anim}`}
      style={style}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div
        className={`${stamp} right-4.5 rotate-8 text-positive`}
        style={{ opacity: flying === "keep" ? 1 : Math.max(0, Math.min(1, dx / SWIPE)) }}
      >
        {stampKeep}
      </div>
      <div
        className={`${stamp} left-4.5 -rotate-8 text-net`}
        style={{ opacity: flying === "flag" ? 1 : Math.max(0, Math.min(1, -dx / SWIPE)) }}
      >
        {stampFlag}
      </div>
      {children}
    </div>
  );
}
