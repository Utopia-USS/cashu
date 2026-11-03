import { type ReactNode, useRef } from "react";
import { useVirtualRows } from "../../presentation/useVirtualRows.js";
export function Rows<T>({
  rows,
  rowKey,
  children,
  label,
}: {
  rows: readonly T[];
  rowKey(row: T): string;
  children(row: T): ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const virtual = useVirtualRows({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 80,
    getItemKey: (i) => (rows[i] === undefined ? i : rowKey(rows[i])),
    overscan: 5,
  });
  return (
    <section ref={ref} aria-label={label} className="max-h-96 overflow-auto">
      <div className="relative" style={{ height: virtual.totalSize }}>
        {virtual.items.map((item) => {
          const row = rows[item.index];
          return row === undefined ? null : (
            <div
              key={item.key}
              ref={virtual.measureElement}
              data-index={item.index}
              className="absolute left-0 top-0 w-full border-b border-border py-3"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {children(row)}
            </div>
          );
        })}
      </div>
    </section>
  );
}
