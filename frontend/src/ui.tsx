import { createContext, type CSSProperties, Fragment, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { dropToast, pushToast, type ToastAction, type ToastItem } from "./toasts";

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
  items, value, onChange, quiet, label,
}: {
  items: [label: string, value: T][];
  value: T;
  onChange: (v: T) => void;
  /** v2 quiet variant: the selected item on the chip colour instead of the accent. */
  quiet?: boolean;
  /** Accessible name of the group. */
  label?: string;
}) {
  return (
    <span className={`seg ${quiet ? "quiet" : ""}`} role="group" aria-label={label}>
      {items.map(([text, v]) => (
        <button key={String(v)} type="button" className={v === value ? "on" : ""} aria-pressed={v === value} onClick={() => onChange(v)}>
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
export interface SetupStepItem { key: string; title: ReactNode; hint?: ReactNode; status: StepStatus; tag?: ReactNode; actions?: ReactNode; body?: ReactNode }

/** Vertical step list with live status (blank page / setup). */
export function SetupSteps({ steps }: { steps: SetupStepItem[] }) {
  return (
    <div className="setup-steps">
      {steps.map((s, i) => (
        <div key={s.key} className={`ss ${s.status}`}>
          <b className="n" aria-label={s.status === "done" ? "zrobione" : `krok ${i + 1}`}>{s.status === "done" ? "✓" : i + 1}</b>
          <div style={{ minWidth: 0 }}>
            <div className="t">{s.title} {s.tag}</div>
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
export function Menu({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label?: string }) {
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
  return <div className="menu" role="menu" aria-label={label} ref={ref}>{children}</div>;
}

export function MenuItem({ icon, title, sub, on, onSelect, right }: {
  icon?: ReactNode; title: ReactNode; sub?: ReactNode; on?: boolean; onSelect: () => void; right?: ReactNode;
}) {
  return (
    <button className={`mi ${on ? "on" : ""}`} role="menuitem" onClick={onSelect}>
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
  options: { value: T; title: ReactNode; desc?: ReactNode; tag?: ReactNode }[];
}) {
  return (
    <div className="radios" role="radiogroup">
      {options.map((o) => (
        <label key={o.value} className={o.value === value ? "on" : ""}>
          <input type="radio" name={name} value={o.value} checked={o.value === value} disabled={disabled} onChange={() => onChange(o.value)} />
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
type ShowToast = (text: string, ms?: number, action?: ToastAction) => void;
const ToastCtx = createContext<ShowToast>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);
  const close = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((cur) => dropToast(cur, id));
  }, []);
  const show = useCallback<ShowToast>((text, ms = 2000, action) => {
    const id = ++seq.current;
    setItems((cur) => pushToast(cur, { id, text, action }));
    timers.current.set(id, setTimeout(() => close(id), ms));
  }, [close]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {items.length > 0 && (
        <div className="toasts" role="status" aria-live="polite">
          {items.map((t) => (
            <div className="toast" key={t.id}>
              <span className="txt">{t.text}</span>
              {t.action && <button className="btn" onClick={() => { close(t.id); t.action!.onClick(); }}>{t.action.label}</button>}
              {t.action && <button className="icon-btn" aria-label="Zamknij" onClick={() => close(t.id)}>✕</button>}
            </div>
          ))}
        </div>
      )}
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

// history.back() calls made by a closing drawer itself: the popstate they cause is not a "back" press.
// One global listener, so such an event is consumed even after the drawer unmounted.
let ownBacks = 0;
const backHandlers = new Set<() => void>();
window.addEventListener("popstate", () => {
  if (ownBacks > 0) { ownBacks--; return; }
  backHandlers.forEach((h) => h());
});

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Right side panel over a scrim. Esc, the scrim, ✕ and the browser back button close it; focus is
 * trapped inside while it is open and returns to the opener afterwards. */
export function Drawer({ open, title, tag, width = 520, footer, onClose, children, label }: {
  open: boolean; title: ReactNode; tag?: ReactNode; width?: number; footer?: ReactNode;
  onClose: () => void; children: ReactNode; label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    (el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(".db " + FOCUSABLE) ?? el)?.focus();
    // Back button closes the drawer: one history entry per open drawer (same URL).
    history.pushState({ ...(history.state ?? {}), finanseDrawer: true }, "");
    let viaBack = false;
    const onPop = () => { viaBack = true; close.current(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); return; }
      if (e.key !== "Tab" || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    backHandlers.add(onPop);
    document.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      backHandlers.delete(onPop);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
      if (!viaBack && history.state?.finanseDrawer) { ownBacks++; history.back(); }
      opener?.focus?.();
    };
  }, [open]);
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

/** Anchored popover (`.pop`) under its `.menu-anchor` parent: closes on Esc and outside click. */
export function Pop({ open, onClose, children, width = 420, align = "left", label }: {
  open: boolean; onClose: () => void; children: ReactNode; width?: number; align?: "left" | "right"; label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const onDown = (e: MouseEvent) => {
      const anchor = el?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
      (el?.parentElement?.querySelector("button") as HTMLElement | null)?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="pop" role="dialog" aria-label={label} ref={ref}
      style={{ width: `min(${width}px, calc(100vw - 32px))`, ...(align === "right" ? { left: "auto", right: 0 } : {}) }}>
      {children}
    </div>
  );
}
