/// <reference lib="dom" />
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createVirtualRows, type VirtualRowsOptions } from "./virtualRows.js";

const useCommitEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

/** Consumers receive cached immutable row geometry, never TanStack's mutable virtualizer instance. */
export function useVirtualRows(options: VirtualRowsOptions) {
  const [store] = useState(createVirtualRows);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  useCommitEffect(() => store.mount(), [store]);
  useCommitEffect(() => {
    store.update(options);
  });
  return { ...snapshot, measureElement: store.measureElement };
}
