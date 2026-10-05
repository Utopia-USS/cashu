// Modal behaviour shared by the right drawer (ui.tsx `Drawer`) and centered dialogs (`useModal`, e.g. the
// signals dialog, signals-rail.md 3): Esc closes, unless the key comes from inside an element that handles
// Esc itself (`[data-esc-local]`: an open decision form collapses first) or another modal lies on top of
// this one; Tab cycles inside; the page under it does not scroll; the browser back button closes it (one
// history entry per open modal, same URL); focus returns to the opener. React-free and environment-injected,
// so `npm test` drives it with a fake document.

export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalEnv {
  doc: Pick<Document, "activeElement" | "addEventListener" | "removeEventListener" | "querySelectorAll" | "body">;
  win: Pick<Window, "addEventListener">;
  history: Pick<History, "state" | "pushState" | "back">;
}

export interface ModalOptions {
  onClose: () => void;
  /** Focus on open: "first" (default) = the `[data-autofocus]` element, else the first focusable inside
   * `.db`, else the panel; "panel" = the panel itself (page shortcuts such as j / k / Enter then work). */
  focus?: "first" | "panel";
  env?: ModalEnv;
}

// history.back() calls made by a closing modal itself: the popstate they cause is not a "back" press.
// One shared listener, so such an event is consumed even after the modal unmounted.
let ownBacks = 0;
const backHandlers = new Set<() => void>();
const listening = new WeakSet<object>();

/** The shared popstate handler (exported for tests). */
export function handlePopState(): void {
  if (ownBacks > 0) { ownBacks--; return; }
  backHandlers.forEach((h) => h());
}

/** Wires the modal behaviour to an open panel; returns the teardown (call it when the modal closes). */
export function attachModal(el: HTMLElement | null, { onClose, focus = "first", env }: ModalOptions): () => void {
  const { doc, win, history: hist } = env ?? { doc: document, win: window, history: window.history };
  if (!listening.has(win)) { listening.add(win); win.addEventListener("popstate", handlePopState); }
  const opener = doc.activeElement as HTMLElement | null;
  const initial = focus === "panel" ? el : el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(".db " + FOCUSABLE) ?? el;
  initial?.focus();
  hist.pushState({ ...((hist.state as object | null) ?? {}), finanseDrawer: true }, "");
  let viaBack = false;
  const onPop = () => { viaBack = true; onClose(); };
  const onKey = (e: KeyboardEvent) => {
    if (!el || (e.key !== "Escape" && e.key !== "Tab")) return;
    // Another modal on top (a drawer opened from inside) owns the keyboard.
    const top = [...doc.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].pop();
    if (top && top !== el) return;
    if (e.key === "Escape") {
      const t = e.target as Element | null;
      if (t && typeof t.closest === "function" && el.contains(t) && t.closest("[data-esc-local]")) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const active = doc.activeElement;
    if (!el.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  backHandlers.add(onPop);
  doc.addEventListener("keydown", onKey, true);
  const prev = doc.body.style.overflow;
  doc.body.style.overflow = "hidden";
  return () => {
    backHandlers.delete(onPop);
    doc.removeEventListener("keydown", onKey, true);
    doc.body.style.overflow = prev;
    // A tick later: a close that navigated away (the shell replaced this entry with the new view) leaves the
    // history as it is; a plain close drops this modal's entry.
    if (!viaBack) setTimeout(() => { if ((hist.state as { finanseDrawer?: boolean } | null)?.finanseDrawer) { ownBacks++; hist.back(); } }, 0);
    opener?.focus?.();
  };
}
