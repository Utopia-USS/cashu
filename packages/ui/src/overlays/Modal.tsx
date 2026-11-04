/// <reference lib="dom" />
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ModalProps } from "./Modal.types.js";

const placements = {
  fill: "inset-4 rounded-lg border border-border bg-surface-raised p-4",
  center:
    "inset-4 m-auto h-fit max-h-[calc(100%-2rem)] rounded-lg border border-border bg-surface-raised p-6 shadow-lg",
  end: "inset-y-0 right-0 w-full max-w-xl border-l border-border bg-surface p-6 shadow-xl",
  screen: "inset-0 bg-surface",
} as const;
const centerWidths = {
  sm: "max-w-xl",
  md: "max-w-2xl",
  lg: "max-w-3xl",
  xl: "max-w-4xl",
  "2xl": "max-w-6xl",
} as const;
const focusable = "a[href], button, input, select, textarea, [tabindex]";
let nextModalId = 0;
let ownBacks = 0;
let savedOverflow: string | null = null;
let openCount = 0;
const backHandlers: Array<{ depth: number; close(): void }> = [];
const pendingHistoryPushes: Array<{ depth: number; push(): void }> = [];
let historyPushScheduled = false;
const listening = new WeakSet<Window>();
const ModalParent = createContext<string | null>(null);

function scheduleHistoryPush(depth: number, push: () => void): void {
  pendingHistoryPushes.push({ depth, push });
  if (historyPushScheduled) return;
  historyPushScheduled = true;
  queueMicrotask(() => {
    historyPushScheduled = false;
    const batch = pendingHistoryPushes.splice(0).sort((a, b) => a.depth - b.depth);
    for (const item of batch) item.push();
  });
}

function visibleFocusable(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(focusable)].filter((item) => {
    if (item.tabIndex < 0 || item.matches(":disabled")) return false;
    for (let node: HTMLElement | null = item; node && node !== panel; node = node.parentElement) {
      if (node.hidden || node.inert || node.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  });
}

function handleBack() {
  if (ownBacks > 0) {
    ownBacks--;
    return;
  }
  backHandlers
    .reduce<(typeof backHandlers)[number] | null>(
      (best, entry) => (best === null || entry.depth > best.depth ? entry : best),
      null,
    )
    ?.close();
}

/** Desktop modal dialog: traps Tab, closes on Escape, browser back or (unless turned off) the backdrop, restores focus to the opener. */
export function Modal({
  label,
  labelledBy,
  describedBy,
  onClose,
  children,
  className = "",
  placement = "fill",
  width = "lg",
  closeOnBackdrop = true,
  focus = "first",
  panelRef,
  onKeyDown,
}: ModalProps) {
  const panel = useRef<HTMLElement>(null);
  useImperativeHandle(panelRef, () => panel.current as HTMLElement, []);
  const close = useRef(onClose);
  const [depth, setDepth] = useState(0);
  const modalId = useId();
  const parentModalId = useContext(ModalParent);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panels = [...document.querySelectorAll<HTMLElement>("[data-cashu-modal-panel]")];
    const parentOf = (id: string) =>
      panels.find((entry) => entry.dataset.cashuModalId === id)?.dataset.cashuModalParent ?? null;
    const hasAncestor = (id: string, ancestor: string) => {
      let cursor = parentOf(id);
      while (cursor) {
        if (cursor === ancestor) return true;
        cursor = parentOf(cursor);
      }
      return false;
    };
    const earlierDialogs = panels
      .filter(
        (dialog) =>
          dialog !== element &&
          (hasAncestor(modalId, dialog.dataset.cashuModalId ?? "") ||
            (!hasAncestor(dialog.dataset.cashuModalId ?? "", modalId) &&
              (dialog.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)),
      )
      .map((dialog) => ({ dialog, inert: dialog.inert }));
    for (const { dialog } of earlierDialogs) dialog.inert = true;
    if (!listening.has(window)) {
      listening.add(window);
      window.addEventListener("popstate", handleBack);
    }
    const id = ++nextModalId;
    let mounted = true;
    let pushed = false;
    scheduleHistoryPush(earlierDialogs.length, () => {
      if (!mounted) return;
      window.history.pushState(
        { ...((window.history.state as object | null) ?? {}), cashuModal: id },
        "",
      );
      pushed = true;
    });
    setDepth(earlierDialogs.length);
    if (openCount++ === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const initial =
      focus === "panel"
        ? element
        : (element.querySelector<HTMLElement>("[data-autofocus]") ??
          visibleFocusable(element)[0] ??
          element);
    if (!panels.some((entry) => hasAncestor(entry.dataset.cashuModalId ?? "", modalId)))
      initial.focus();
    let viaBack = false;
    const onPop = () => {
      viaBack = true;
      close.current();
    };
    backHandlers.push({ depth: earlierDialogs.length, close: onPop });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      const top = [
        ...document.querySelectorAll<HTMLElement>("[data-cashu-modal-panel]"),
      ].reduce<HTMLElement | null>(
        (best, entry) =>
          best === null ||
          Number(entry.dataset.cashuModalDepth) > Number(best.dataset.cashuModalDepth)
            ? entry
            : best,
        null,
      );
      if (top !== element) return;
      if (event.key === "Escape") {
        if (
          event.target instanceof Element &&
          element.contains(event.target) &&
          event.target.closest("[data-esc-local]")
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      const items = visibleFocusable(element);
      const first = items[0],
        last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        element.focus();
        return;
      }
      const active = document.activeElement;
      if (!element.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === element)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      mounted = false;
      for (const { dialog, inert } of earlierDialogs) dialog.inert = inert;
      document.removeEventListener("keydown", onKey, true);
      const index = backHandlers.findIndex((entry) => entry.close === onPop);
      if (index >= 0) backHandlers.splice(index, 1);
      if (--openCount === 0) {
        document.body.style.overflow = savedOverflow ?? "";
        savedOverflow = null;
      }
      if (pushed && !viaBack)
        setTimeout(() => {
          if ((window.history.state as { cashuModal?: number } | null)?.cashuModal === id) {
            ownBacks++;
            window.history.back();
          }
        }, 0);
      if (opener?.isConnected) opener.focus();
    };
  }, [focus, modalId]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <div
        className="fixed inset-0 bg-overlay"
        style={{ zIndex: `calc(var(--modal-backdrop-layer) + ${depth} * var(--modal-layer-step))` }}
        aria-hidden="true"
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <section
        ref={panel}
        tabIndex={-1}
        role="dialog"
        data-cashu-modal-panel=""
        data-cashu-modal-id={modalId}
        data-cashu-modal-parent={parentModalId ?? undefined}
        data-cashu-modal-depth={depth}
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        onKeyDown={onKeyDown}
        className={`fixed overflow-auto ${placements[placement]} ${placement === "center" ? centerWidths[width] : ""} ${className}`}
        style={{ zIndex: `calc(var(--modal-panel-layer) + ${depth} * var(--modal-layer-step))` }}
      >
        <ModalParent.Provider value={modalId}>{children}</ModalParent.Provider>
      </section>
    </>,
    document.body,
  );
}
