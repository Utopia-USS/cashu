// The asset drawer over the investments grid (F6 owner decision 3; design/v2/research/research-drawer.html,
// research.md section 1): a right panel `min(920px, 100% - 120px)` (full width below 760 px) over a scrim,
// header = crumb `Inwestycje › Aktywa › <name>`, `otwórz jako stronę`, `Esc`, `✕`. The route keeps the deep
// link (`#/{slug}/investments.portfolio/assets/{id}` opens the home with the drawer on top).
//
// Esc, the scrim and ✕ close it. Esc is read on window in the bubble phase, so a v1 drawer opened from inside
// (transactions, thesis, journal) handles its own Esc first (capture + stopPropagation) and this one stays.
// Focus moves into the panel, Tab cycles inside it and focus returns to the opener on close. The page under
// it does not scroll while it is open (its scroll position is kept).
import { type ReactNode, useEffect, useRef } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AssetDrawer({ name, onClose, onPage, onCrumb, children }: {
  name: string;
  onClose: () => void;
  /** "otwórz jako stronę": the same detail as a full page. */
  onPage: () => void;
  /** `Inwestycje` / `Aktywa` in the crumb (close and scroll to the asset list). */
  onCrumb: (where: "home" | "assets") => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (!el || e.defaultPrevented) return;
      // Another dialog on top (a v1 drawer opened from inside) owns the keyboard.
      const top = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].pop();
      if (top && top !== el) return;
      if (e.key === "Escape") { e.preventDefault(); close.current(); return; }
      if (e.key !== "Tab") return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <>
      <div className="ascrim" onClick={onClose} aria-hidden />
      <div className="adrawer" role="dialog" aria-modal="true" aria-label={name} ref={ref} tabIndex={-1}>
        <div className="adh">
          <nav aria-label="Ścieżka"><span className="pre"><button onClick={() => onCrumb("home")}>Inwestycje</button> › <button onClick={() => onCrumb("assets")}>Aktywa</button> › </span><b>{name}</b></nav>
          <span className="spacer" />
          <button className="lnk" onClick={onPage}>otwórz jako stronę</button>
          <kbd aria-hidden>Esc</kbd>
          <button className="icon-btn" title="Zamknij (Esc)" aria-label="Zamknij" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </>
  );
}
