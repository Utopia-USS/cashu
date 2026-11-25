import { useEffect, useRef, useState } from "react";

/** A fast action never shows a loader: it appears only after this delay... */
export const PENDING_SHOW_DELAY_MS = 150;
/** ...and, once shown, stays at least this long, so it never blinks. */
export const PENDING_MIN_VISIBLE_MS = 400;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * The pending state of a pressable control: `inFlight` while the press handler's promise (or the
 * caller's `pending`) runs, `visible` for the loader (delayed by {@link PENDING_SHOW_DELAY_MS}, held for
 * {@link PENDING_MIN_VISIBLE_MS}). `press` runs the handler and ignores presses while one is in flight.
 */
export function usePressPending(
  onPress: (() => unknown) | undefined,
  pending: boolean | undefined,
): { inFlight: boolean; visible: boolean; press: (() => void) | undefined } {
  const [running, setRunning] = useState(0);
  const inFlight = Boolean(pending) || running > 0;
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (inFlight && !visible) {
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, PENDING_SHOW_DELAY_MS);
      return () => clearTimeout(timer);
    }
    if (!inFlight && visible) {
      const left = PENDING_MIN_VISIBLE_MS - (Date.now() - shownAt.current);
      const timer = setTimeout(() => setVisible(false), Math.max(0, left));
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [inFlight, visible]);

  const press =
    onPress === undefined
      ? undefined
      : () => {
          if (inFlight) return;
          const result = onPress();
          if (!isThenable(result)) return;
          setRunning((n) => n + 1);
          const settle = () => setRunning((n) => Math.max(0, n - 1));
          // A rejection still surfaces as unhandled, as it did when the caller dropped the promise.
          result.then(settle, (error: unknown) => {
            settle();
            throw error;
          });
        };
  return { inFlight, visible, press };
}
