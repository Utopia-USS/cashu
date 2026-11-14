/// <reference lib="dom" />
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Button } from "../controls/Button.js";
import { S } from "../overlays/overlay.strings.js";
import {
  dropToast,
  MIN_ACTION_MS,
  pushToast,
  type ToastAction,
  type ToastItem,
  toastTimers,
} from "./toasts.js";

/** The close glyph of the old `.icon-btn` (a symbol, not a word). */
const CLOSE_GLYPH = "\u2715";

export type { ToastAction };

/** Shows a toast for `ms` (default 2 s; at least 20 s with an action) and returns its id. */
type ShowToast = (text: string, ms?: number, action?: ToastAction) => number;

const ToastContext = createContext<ShowToast>(() => 0);
const ToastCloseContext = createContext<(id: number) => void>(() => {});

/** The function that shows a toast in the nearest `ToastProvider`. */
export const useToast = () => useContext(ToastContext);
/** Closes a toast by the id `useToast()` returned (e.g. an older undo the next change makes stale). */
export const useToastClose = () => useContext(ToastCloseContext);

/** Toast stack at the bottom centre (old `.toasts` / `.toast`): each toast with its own timer and optional
 * action; every timer pauses while the pointer or focus is on the stack or the window is hidden. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef<ReturnType<typeof toastTimers> | null>(null);
  const hover = useRef(false);
  const focus = useRef(false);
  const clock = () => {
    timers.current ??= toastTimers((id) => setItems((current) => dropToast(current, id)));
    return timers.current;
  };
  const close = (id: number) => {
    clock().stop(id);
    setItems((current) => dropToast(current, id));
  };
  const show: ShowToast = (text, ms = 2000, action) => {
    const id = ++seq.current;
    setItems((current) => pushToast(current, { id, text, action }));
    clock().start(id, action ? Math.max(ms, MIN_ACTION_MS) : ms);
    return id;
  };
  const sync = () => {
    if (hover.current || focus.current || document.hidden) clock().pause();
    else clock().resume();
  };
  useEffect(() => {
    const onVisibility = () => {
      if (hover.current || focus.current || document.hidden) timers.current?.pause();
      else timers.current?.resume();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      timers.current?.clear();
    };
  }, []);
  // The stack unmounts when empty (no mouseleave / blur then): reset the pause state.
  useEffect(() => {
    if (items.length > 0) return;
    hover.current = false;
    focus.current = false;
    if (!document.hidden) timers.current?.resume();
  }, [items.length]);
  return (
    <ToastContext.Provider value={show}>
      <ToastCloseContext.Provider value={close}>
        {children}
        {items.length > 0 && (
          <section
            aria-label={S.notifications}
            className="pointer-events-none fixed bottom-6 left-1/2 z-100 flex max-w-[92vw] -translate-x-1/2 flex-col items-center gap-2"
            onMouseEnter={() => {
              hover.current = true;
              sync();
            }}
            onMouseLeave={() => {
              hover.current = false;
              sync();
            }}
            onFocus={() => {
              focus.current = true;
              sync();
            }}
            onBlur={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              focus.current = false;
              sync();
            }}
          >
            <div role="status" aria-live="polite" className="contents">
              {items.map((toast) => (
                <div
                  key={toast.id}
                  className="pointer-events-auto flex max-w-[92vw] animate-toast-in items-center gap-3 rounded-md border border-border bg-surface-raised px-3 py-2.5 shadow-toast motion-reduce:animate-none"
                >
                  <span className="text-sm">{toast.text}</span>
                  {toast.action && (
                    <Button
                      onPress={() => {
                        close(toast.id);
                        toast.action?.onClick();
                      }}
                    >
                      {toast.action.label}
                    </Button>
                  )}
                  {toast.action && (
                    <Button variant="icon" label={S.close} onPress={() => close(toast.id)}>
                      {CLOSE_GLYPH}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </ToastCloseContext.Provider>
    </ToastContext.Provider>
  );
}
