// Presentational motion of the budget screen (cashU motion rules: ease-out entrances, staggered, no bounce,
// nothing under reduced motion). The tokens hold no keyframes for a bar growing from its baseline or a ring
// segment sweeping in, so those run through the Web Animations API once, when the element mounts.
import { type RefObject, useEffect, useRef, useState } from "react";

/** The tiles' curve (`--ease-tile`). */
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

const reducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Runs `animate(elements)` once after the first paint of the elements under `ref` matching `selector`. */
export function useEntrance<T extends Element>(
  selector: string,
  animate: (el: Element, index: number) => Keyframe[] | null,
  timing: (index: number) => KeyframeAnimationOptions,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const done = useRef(false);
  useEffect(() => {
    const root = ref.current;
    if (done.current || !root || reducedMotion() || typeof Element.prototype.animate !== "function")
      return;
    done.current = true;
    root.querySelectorAll(selector).forEach((el, i) => {
      const frames = animate(el, i);
      if (frames) el.animate(frames, { fill: "backwards", easing: EASE_OUT, ...timing(i) });
    });
  });
  return ref;
}

/** The width of an element, followed (a chart that fills its tile). */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** A hovered key that leaves only after a beat, so moving between neighbours never flashes the rest state. */
export function useLingeringHover(delayMs = 90): [string | null, (key: string | null) => void] {
  const [key, setKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const set = (next: string | null) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (next !== null) setKey(next);
    else timer.current = setTimeout(() => setKey(null), delayMs);
  };
  return [key, set];
}
