import { createContext, type CSSProperties, Fragment, type ReactNode, type RefObject, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { attachModal, FOCUSABLE } from "./modal";
import { dropToast, MIN_ACTION_MS, pushToast, type ToastAction, type ToastItem, toastTimers } from "./toasts";

export function Skeleton({ w = "100%", h = 14, r = 8, style }: {
  w?: number | string; h?: number | string; r?: number; style?: CSSProperties;
}) {
  return <div className="skeleton" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

/** Placeholder KPI row (matches the real .kpis grid). */
export function SkeletonKpis({ n = 6 }: { n?: number }) {
  return (
    <div className="kpis">
      {Array.from({ length: n }, (_, i) => (
        <div className="card kpi" key={i}>
          <Skeleton w={90} h={10} />
          <Skeleton w={130} h={22} style={{ marginTop: 8 }} />
          <Skeleton w={70} h={10} style={{ marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}

/** Placeholder chart card (title + big block). */
export function SkeletonChart({ height = 300 }: { height?: number }) {
  return (
    <div className="card chart-card">
      <Skeleton w={180} h={14} style={{ marginBottom: 14 }} />
      <Skeleton w="100%" h={height} />
    </div>
  );
}

/** Placeholder table rows inside a titled card. */
export function SkeletonTable({ rows = 6, title = true }: { rows?: number; title?: boolean }) {
  return (
    <div className="card chart-card">
      {title && <Skeleton w={160} h={14} style={{ marginBottom: 14 }} />}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: "flex", gap: 12, alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
          <Skeleton w="40%" h={12} />
          <span style={{ flex: 1 }} />
          <Skeleton w={80} h={12} />
        </div>
      ))}
    </div>
  );
}

export function Seg<T extends string | number | null>({
  items, value, onChange, quiet, label, disabled, title,
}: {
  items: [label: string, value: T][];
  value: T;
  onChange: (v: T) => void;
  /** v2 quiet variant: the selected item on the chip colour instead of the accent. */
  quiet?: boolean;
  /** Accessible name of the group. */
  label?: string;
  /** The whole group is read-only (e.g. a field an edit cannot change); `title` says why. */
  disabled?: boolean;
  title?: string;
}) {
  return (
    <span className={`seg ${quiet ? "quiet" : ""}`} role="group" aria-label={label} title={title}>
      {items.map(([text, v]) => (
        <button key={String(v)} type="button" className={v === value ? "on" : ""} aria-pressed={v === value} disabled={disabled} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}

export function Kpi({ label, value, hint, cls, hintCls }: {
  label: string; value: ReactNode; hint?: ReactNode; cls?: string; hintCls?: "pos" | "neg" | "warn";
}) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className={`value ${cls || ""}`}>{value}</div>
      <div className={`hint ${hintCls ?? ""}`}>{hint || ""}</div>
    </div>
  );
}

export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="controls">
      <strong style={{ fontSize: 14 }}>{children}</strong>
      {right != null && <span className="spacer" />}
      {right}
    </div>
  );
}

// ---- F1 shell primitives (design-system-notes 4.2) --------------------------

export type Tone = "pos" | "neg" | "warn" | "info";

export function Tag({ tone, solid, title, children }: { tone?: Tone; solid?: boolean; title?: string; children: ReactNode }) {
  return <span className={`tag ${tone ?? ""} ${solid ? "solid" : ""}`} title={title}>{children}</span>;
}

/** Soft inline message (tinted), optional action on the right. `.err` stays for blocking failures. */
export function Notice({ tone, action, children, style }: {
  tone?: Tone; action?: ReactNode; children: ReactNode; style?: CSSProperties;
}) {
  return (
    <div className={`notice ${tone ?? ""}`} style={style} role={tone === "neg" || tone === "warn" ? "alert" : undefined}>
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

/** Horizontal wizard stepper: steps before `current` are done, `current` is on (0-based). */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="steps" aria-label="Kroki">
      {steps.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <li className="ln" aria-hidden />}
          <li className={`st ${i < current ? "done" : i === current ? "on" : ""}`} aria-current={i === current ? "step" : undefined}>
            <b>{i < current ? "✓" : i + 1}</b> {s}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

export type StepStatus = "done" | "on" | "todo";
export interface SetupStepItem {
  key: string; title: ReactNode; hint?: ReactNode; status: StepStatus; tag?: ReactNode; actions?: ReactNode; body?: ReactNode;
  /** Never counts toward the module state: `opcjonalnie` after the title until done (unless `tag` is given). */
  optional?: boolean;
}

/** Vertical step list with live status (blank page / setup). `compact`: the actions go under the hint (a 1/3 widget). */
export function SetupSteps({ steps, compact }: { steps: SetupStepItem[]; compact?: boolean }) {
  return (
    <div className={`setup-steps${compact ? " compact" : ""}`}>
      {steps.map((s, i) => (
        <div key={s.key} className={`ss ${s.status}`}>
          <b className="n" aria-label={s.status === "done" ? "zrobione" : `krok ${i + 1}`}>{s.status === "done" ? "✓" : i + 1}</b>
          <div style={{ minWidth: 0 }}>
            <div className="t">{s.title} {s.tag ?? (s.optional && s.status !== "done" ? <Tag>opcjonalnie</Tag> : null)}</div>
            {s.body}
            {s.hint && <div className="h">{s.hint}</div>}
          </div>
          <div className="act">{s.actions}</div>
        </div>
      ))}
    </div>
  );
}

/** Anchored popover menu. Closes on Esc and outside click; arrow keys move between items. */
export function Menu({ open, onClose, children, label, className }: { open: boolean; onClose: () => void; children: ReactNode; label?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    (el?.querySelector<HTMLElement>(".mi.on") ?? el?.querySelector<HTMLElement>(".mi"))?.focus();
    const onDown = (e: MouseEvent) => {
      const anchor = el?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); (el?.parentElement?.querySelector("button") as HTMLElement | null)?.focus(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = [...(el?.querySelectorAll<HTMLElement>(".mi") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, onClose]);
  if (!open) return null;
  return <div className={className ? `menu ${className}` : "menu"} role="menu" aria-label={label} ref={ref}>{children}</div>;
}

export function MenuItem({ icon, title, sub, on, onSelect, right, disabled }: {
  icon?: ReactNode; title: ReactNode; sub?: ReactNode; on?: boolean; onSelect: () => void; right?: ReactNode;
  /** `aria-disabled` (still focusable, so the menu's arrow keys keep working); a click does nothing. */
  disabled?: boolean;
}) {
  return (
    <button className={`mi ${on ? "on" : ""}`} role="menuitem" aria-disabled={disabled || undefined} onClick={disabled ? undefined : onSelect}>
      {icon}
      <span className="grow">{title}{sub && <div className="sub">{sub}</div>}</span>
      {right}
    </button>
  );
}

export const MenuSep = () => <div className="sep" role="separator" />;
export const MenuHead = ({ children }: { children: ReactNode }) => <div className="mh">{children}</div>;

export function ChoiceCard({ checked, title, desc, hint, tag, disabled, onChange }: {
  checked: boolean; title: ReactNode; desc?: ReactNode; hint?: ReactNode; tag?: ReactNode; disabled?: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className={`choice ${checked ? "on" : ""} ${disabled ? "off" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <div>
        <div className="t">{title} {tag}</div>
        {desc && <div className="d">{desc}</div>}
        {hint && <div className="h">{hint}</div>}
      </div>
    </label>
  );
}

export function RadioList<T extends string>({ name, value, onChange, options, disabled }: {
  name: string; value: T; onChange: (v: T) => void; disabled?: boolean;
  /** `disabled` on an option: shown, not selectable (a placeholder slot); `tooltip` says why. */
  options: { value: T; title: ReactNode; desc?: ReactNode; tag?: ReactNode; tooltip?: string; disabled?: boolean }[];
}) {
  return (
    <div className="radios" role="radiogroup">
      {options.map((o) => (
        <label key={o.value} className={`${o.value === value ? "on" : ""}${o.disabled ? " off" : ""}`} title={o.tooltip}>
          <input type="radio" name={name} value={o.value} checked={o.value === value} disabled={disabled || o.disabled} onChange={() => onChange(o.value)} />
          <div>
            <div className="t">{o.title} {o.tag}</div>
            {o.desc && <div className="d">{o.desc}</div>}
          </div>
        </label>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, disabled, label, title }: {
  on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; title?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={title}
      className={`switch ${on ? "on" : ""}`} disabled={disabled} onClick={() => onChange(!on)} />
  );
}

/** Copy text to the clipboard; falls back to a hidden textarea where the async API is missing. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** Monospace command with a copy button; shows the `Skopiowano` toast. */
export function Code({ cmd, multiline }: { cmd: string; multiline?: boolean }) {
  const toast = useToast();
  return (
    <div className={`code ${multiline ? "multi" : ""}`}>
      <span>{cmd}</span>
      <button className="btn" onClick={() => copyText(cmd).then(() => toast("Skopiowano", 1500))}>Kopiuj</button>
    </div>
  );
}

export function Empty({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div style={{ color: "var(--text)", fontWeight: 600 }}>{title}</div>
      {hint && <div style={{ fontSize: 13, marginTop: 4 }}>{hint}</div>}
      {action && <div className="controls">{action}</div>}
    </div>
  );
}

// ---- toasts (a stack at the bottom centre; each with its own timer and action, F5 R4) ----------

export type { ToastAction } from "./toasts";
/** Shows a toast and returns its id (for `useToastClose`). */
type ShowToast = (text: string, ms?: number, action?: ToastAction) => number;
const ToastCtx = createContext<ShowToast>(() => 0);
const ToastCloseCtx = createContext<(id: number) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
/** Closes a toast by the id `useToast()` returned (e.g. an older undo the next change makes stale). */
export const useToastClose = () => useContext(ToastCloseCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef<ReturnType<typeof toastTimers> | null>(null);
  timers.current ??= toastTimers((id) => setItems((cur) => dropToast(cur, id)));
  const close = useCallback((id: number) => {
    timers.current!.stop(id);
    setItems((cur) => dropToast(cur, id));
  }, []);
  const show = useCallback<ShowToast>((text, ms = 2000, action) => {
    const id = ++seq.current;
    setItems((cur) => pushToast(cur, { id, text, action }));
    // An undo stays long enough to reach it with the keyboard; every timer pauses while the owner is on the
    // stack (hover, focus) or away from the window (F7 FE14).
    timers.current!.start(id, action ? Math.max(ms, MIN_ACTION_MS) : ms);
    return id;
  }, []);
  const hover = useRef(false), focus = useRef(false);
  const sync = useCallback(() => {
    if (hover.current || focus.current || document.hidden) timers.current!.pause(); else timers.current!.resume();
  }, []);
  useEffect(() => {
    document.addEventListener("visibilitychange", sync);
    return () => { document.removeEventListener("visibilitychange", sync); timers.current?.clear(); };
  }, [sync]);
  // The stack unmounts when empty (no mouseleave / blur then): reset the pause state.
  useEffect(() => { if (!items.length) { hover.current = false; focus.current = false; sync(); } }, [items.length, sync]);
  return (
    <ToastCtx.Provider value={show}>
      <ToastCloseCtx.Provider value={close}>
      {children}
      {items.length > 0 && (
        <div className="toasts" role="region" aria-label="Powiadomienia"
          onMouseEnter={() => { hover.current = true; sync(); }} onMouseLeave={() => { hover.current = false; sync(); }}
          onFocus={() => { focus.current = true; sync(); }}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { focus.current = false; sync(); } }}>
          <div role="status" aria-live="polite" style={{ display: "contents" }}>
            {items.map((t) => (
              <div className="toast" key={t.id}>
                <span className="txt">{t.text}</span>
                {t.action && <button className="btn" onClick={() => { close(t.id); t.action!.onClick(); }}>{t.action.label}</button>}
                {t.action && <button className="icon-btn" aria-label="Zamknij" onClick={() => close(t.id)}>✕</button>}
              </div>
            ))}
          </div>
        </div>
      )}
      </ToastCloseCtx.Provider>
    </ToastCtx.Provider>
  );
}

/** Label/value grid of a compact overview card (max ~3 rows). `null` facts render a skeleton. */
export function FactList({ facts }: { facts: [ReactNode, ReactNode, string?][] | null }) {
  if (!facts) return <div className="mf"><Skeleton w="70%" h={12} /><Skeleton w={70} h={12} /><Skeleton w="60%" h={12} /><Skeleton w={60} h={12} /></div>;
  if (!facts.length) return <div className="muted" style={{ fontSize: 13 }}>Brak danych.</div>;
  return (
    <div className="mf">
      {facts.map(([k, v, cls], i) => (
        <Fragment key={i}><span>{k}</span><span className={cls}>{v}</span></Fragment>
      ))}
    </div>
  );
}

// ---- F3 workspace primitives (design-system-notes 4.2) ----------------------

/** Modal behaviour of a panel (modal.ts): Esc (after an open `[data-esc-local]` form inside), Tab trap,
 * body scroll lock, browser back closes, focus returns to the opener. Shared by `Drawer` and the centered
 * dialogs (signals-rail.md 3). `focus: "panel"` focuses the panel itself instead of its first control. */
export function useModal(ref: RefObject<HTMLElement>, open: boolean, onClose: () => void, opts?: { focus?: "first" | "panel" }) {
  const close = useRef(onClose);
  close.current = onClose;
  const focus = opts?.focus;
  useEffect(() => {
    if (!open) return;
    return attachModal(ref.current, { onClose: () => close.current(), focus });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Right side panel over a scrim. Esc, the scrim, ✕ and the browser back button close it; focus is
 * trapped inside while it is open and returns to the opener afterwards. */
export function Drawer({ open, title, tag, width = 520, footer, onClose, children, label }: {
  open: boolean; title: ReactNode; tag?: ReactNode; width?: number; footer?: ReactNode;
  onClose: () => void; children: ReactNode; label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden />
      <div className="drawer" role="dialog" aria-modal="true" aria-label={label} ref={ref} tabIndex={-1} style={{ width: `min(${width}px, 100vw)` }}>
        <div className="dh">
          <strong>{title}</strong>
          {tag}
          <span style={{ flex: 1 }} />
          <button className="icon-btn" title="Zamknij (Esc)" aria-label="Zamknij" onClick={onClose}>✕</button>
        </div>
        <div className="db">{children}</div>
        {footer && <div className="df">{footer}</div>}
      </div>
    </>
  );
}

/** Anchored popover (`.pop`) under its `.menu-anchor` parent: closes on Esc (focus back to the anchor's button)
 * and outside click. `portal`: rendered into `document.body` with fixed positioning from the anchor's rect, so a
 * scrolling container (the Aktywa table) neither clips it nor scrolls for it; it flips above the anchor when there
 * is no room below, follows scroll / resize, and Tab keeps the DOM order (anchor -> popover -> what follows the
 * anchor; Shift+Tab from its first control returns to the anchor). */
export function Pop({ open, onClose, children, width = 420, align = "left", label, portal }: {
  open: boolean; onClose: () => void; children: ReactNode; width?: number; align?: "left" | "right"; label?: string; portal?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const anchorOf = () => (portal ? mark.current?.parentElement : ref.current?.parentElement) ?? null;
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const onDown = (e: MouseEvent) => {
      const anchor = anchorOf();
      const t = e.target as Node;
      if (anchor && !anchor.contains(t) && !el?.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      const anchor = anchorOf();
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        (anchor?.querySelector("button") as HTMLElement | null)?.focus();
        return;
      }
      if (e.key !== "Tab" || !portal || !el || !anchor) return;
      const visible = (x: HTMLElement) => x.offsetParent !== null;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
      if (!items.length) return;
      const active = document.activeElement as HTMLElement | null;
      const trigger = anchor.querySelector<HTMLElement>("button");
      if (!e.shiftKey && active && anchor.contains(active) && !el.contains(active)) { e.preventDefault(); items[0].focus(); return; }
      if (e.shiftKey && active === items[0] && trigger) { e.preventDefault(); trigger.focus(); return; }
      if (!e.shiftKey && active === items[items.length - 1]) {
        const page = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => visible(x) && !el.contains(x));
        const next = page.slice(page.indexOf(trigger ?? anchor) + 1).find((x) => !anchor.contains(x));
        if (next) { e.preventDefault(); next.focus(); }
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, onClose, portal]); // eslint-disable-line react-hooks/exhaustive-deps
  // Fixed placement under (or above) the anchor, written to the node in the layout phase (before the content's
  // effects run, so a control that focuses itself on mount is already visible); again on scroll and resize.
  useLayoutEffect(() => {
    if (!open || !portal) return;
    const update = () => {
      const anchor = mark.current?.parentElement, el = ref.current;
      if (!anchor || !el) return;
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth, h = el.scrollHeight;
      const vw = window.innerWidth, vh = window.innerHeight;
      const left = Math.max(8, Math.min(align === "right" ? a.right - w : a.left, vw - w - 8));
      const roomBelow = vh - a.bottom - 14, roomAbove = a.top - 14;
      const below = h <= roomBelow || roomBelow >= roomAbove;
      Object.assign(el.style, {
        top: below ? `${a.bottom + 6}px` : "auto", bottom: below ? "auto" : `${vh - a.top + 6}px`, left: `${left}px`, right: "auto",
        maxHeight: `${Math.max(120, below ? roomBelow : roomAbove)}px`, visibility: "visible",
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [open, portal, align]);
  if (!open) return null;
  const size = { width: `min(${width}px, calc(100vw - 32px))` };
  if (portal) {
    return (
      <>
        <span ref={mark} hidden />
        {createPortal(
          <div className="pop fixed" role="dialog" aria-label={label} ref={ref} style={{ ...size, visibility: "hidden" }}>{children}</div>,
          document.body,
        )}
      </>
    );
  }
  return (
    <div className="pop" role="dialog" aria-label={label} ref={ref}
      style={{ ...size, ...(align === "right" ? { left: "auto", right: 0 } : {}) }}>
      {children}
    </div>
  );
}
