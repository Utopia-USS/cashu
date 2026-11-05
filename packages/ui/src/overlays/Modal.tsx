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

// Panel chrome of the Python app: centred dialogs like `.sdlg`, the right drawer like `.drawer` (`end`
// with an inner padding, `side` bare for the Drawer's head / body / foot), the deck's bottom sheet like
// `.rd-sheet .in`; every placement but `screen` sits over the --scrim backdrop. Panels portal to the body,
// so they set the old body text colour themselves; the drawers also the old body type (15px / 1.5).
const placements = {
  fill: "overflow-auto inset-4 rounded-lg border border-border bg-surface-raised p-4",
  center:
    "overflow-auto inset-4 m-auto h-fit max-h-[calc(100%-2rem)] rounded-lg border border-border bg-surface-raised p-6 shadow-dialog",
  end: "overflow-auto inset-y-0 right-0 w-full max-w-130 border-l border-border bg-surface-raised px-4.5 py-3.5 text-base leading-normal shadow-toast",
  side: "inset-y-0 right-0 flex flex-col border-l border-border bg-surface-raised text-base leading-normal shadow-toast",
  panel:
    "inset-y-0 right-0 w-[min(920px,calc(100%-120px))] overflow-y-auto overscroll-contain border-l border-border bg-surface px-5 pt-3.5 pb-7 text-md leading-widget shadow-panel animate-panel-in motion-reduce:animate-none max-narrow:w-full max-narrow:border-l-0 max-narrow:px-3 max-narrow:pt-3 max-narrow:pb-6",
  sheet:
    "inset-x-0 bottom-0 mx-auto max-h-[86%] w-full max-w-150 overflow-y-auto rounded-t-xl bg-surface-raised px-5 pt-5 pb-6 text-md leading-sheet",
  screen: "overflow-auto inset-0 bg-surface",
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
  sideWidth = 520,
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
    // A panel with a `[data-modal-body]` region (Drawer) starts in it, past the head's close button.
    const body = element.querySelector<HTMLElement>("[data-modal-body]");
    const initial =
      focus === "panel"
        ? element
        : (element.querySelector<HTMLElement>("[data-autofocus]") ??
          visibleFocusable(body ?? element)[0] ??
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
        className={`fixed inset-0 ${placement === "screen" ? "" : "bg-scrim"} ${placement === "panel" ? "animate-scrim-in motion-reduce:animate-none" : ""}`}
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
        className={`fixed text-fg outline-none ${placements[placement]} ${placement === "center" ? centerWidths[width] : ""} ${className}`}
        style={{
          zIndex: `calc(var(--modal-panel-layer) + ${depth} * var(--modal-layer-step))`,
          width: placement === "side" ? `min(${sideWidth}px, 100vw)` : undefined,
        }}
      >
        <ModalParent.Provider value={modalId}>{children}</ModalParent.Provider>
      </section>
    </>,
    document.body,
  );
}
