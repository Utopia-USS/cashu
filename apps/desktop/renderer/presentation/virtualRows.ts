// Immutable React external-store boundary around the installed TanStack Virtual core.
// Lifecycle follows @tanstack/react-virtual 3.14.25; the mutable instance never escapes this closure.
import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
} from "@tanstack/react-virtual";

interface VirtualRow {
  readonly index: number;
  readonly key: string | number | bigint;
  readonly start: number;
  readonly end: number;
  readonly size: number;
}
interface VirtualRowsSnapshot {
  readonly items: readonly VirtualRow[];
  readonly totalSize: number;
}
export interface VirtualRowsOptions {
  readonly count: number;
  readonly getScrollElement: () => HTMLElement | null;
  readonly estimateSize: () => number;
  readonly getItemKey?: (index: number) => string | number | bigint;
  readonly overscan?: number;
}
const EMPTY: VirtualRowsSnapshot = Object.freeze({ items: Object.freeze([]), totalSize: 0 });

export function createVirtualRows() {
  let snapshot = EMPTY;
  const listeners = new Set<() => void>();
  const publish = () => {
    const items = instance.getVirtualItems();
    const totalSize = instance.getTotalSize();
    if (
      totalSize === snapshot.totalSize &&
      items.length === snapshot.items.length &&
      items.every((item, index) => {
        const prev = snapshot.items[index];
        return (
          prev?.key === item.key &&
          prev.index === item.index &&
          prev.start === item.start &&
          prev.end === item.end &&
          prev.size === item.size
        );
      })
    )
      return;
    snapshot = Object.freeze({
      totalSize,
      items: Object.freeze(
        items.map(({ index, key, start, end, size }) =>
          Object.freeze({ index, key, start, end, size }),
        ),
      ),
    });
    for (const listener of listeners) listener();
  };
  const defaults = {
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    onChange: publish,
  };
  const instance = new Virtualizer<HTMLElement, HTMLElement>({
    ...defaults,
    count: 0,
    getScrollElement: () => null,
    estimateSize: () => 1,
  });
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount: () => instance._didMount(),
    update: (options: VirtualRowsOptions) => {
      instance.setOptions({ ...defaults, ...options });
      instance._willUpdate();
      publish();
    },
    measureElement: (element: HTMLElement | null) => {
      instance.measureElement(element);
      publish();
    },
  };
}
