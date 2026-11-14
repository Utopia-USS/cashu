import { useRef } from "react";
import { useVirtualRows } from "./useVirtualRows.js";
import type { VirtualListProps } from "./VirtualList.types.js";

/** Bounded desktop list with measured rows and stable item identity. */
export function VirtualList<T>({
  items,
  getKey,
  renderItem,
  label,
  estimateSize,
  className = "",
  rowClassName = "",
}: VirtualListProps<T>) {
  const parent = useRef<HTMLElement>(null);
  const virtual = useVirtualRows({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => estimateSize,
    getItemKey: (index) => getKey(items[index] as T),
    overscan: 5,
  });
  return (
    <section ref={parent} aria-label={label} className={`max-h-96 overflow-auto ${className}`}>
      <div className="relative" style={{ height: virtual.totalSize }}>
        {virtual.items.map((entry) => {
          const item = items[entry.index];
          return item === undefined ? null : (
            <div
              key={entry.key}
              ref={virtual.measureElement}
              data-index={entry.index}
              className={`absolute left-0 top-0 w-full ${rowClassName}`}
              style={{ transform: `translateY(${entry.start}px)` }}
            >
              {renderItem(item, entry.index)}
            </div>
          );
        })}
      </div>
    </section>
  );
}
