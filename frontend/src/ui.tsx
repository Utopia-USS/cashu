import type { CSSProperties, ReactNode } from "react";

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

export function Seg<T extends string | number>({
  items, value, onChange,
}: {
  items: [label: string, value: T][];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <span className="seg">
      {items.map(([label, v]) => (
        <button key={String(v)} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </span>
  );
}

export function Kpi({ label, value, hint, cls }: { label: string; value: ReactNode; hint?: ReactNode; cls?: string }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className={`value ${cls || ""}`}>{value}</div>
      <div className="hint">{hint || ""}</div>
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
