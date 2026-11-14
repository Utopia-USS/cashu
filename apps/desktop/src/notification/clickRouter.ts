import type { NotificationResponsePair } from "./responses.js";

/** Main-process ordering after native intake. A newer invalid locator cannot hide an older valid click. */
export function createNotificationClickRouter<T>(args: {
  resolve(pair: NotificationResponsePair): Promise<T | null>;
  publish(target: T | null): void;
  start?(): void;
  focus(): void;
}) {
  const queue: { pair: NotificationResponsePair; sequence: number }[] = [];
  let sequence = 0;
  let resolving = false;
  let ready = false;
  let pending: T | null | undefined;
  let pendingStart = false;
  let disposed = false;
  const publish = (target: T | null) => {
    if (disposed) return;
    if (!ready) pending = target;
    else args.publish(target);
  };
  const drain = async () => {
    let best: { target: T; sequence: number } | null = null;
    while (queue.length > 0 && !disposed) {
      const item = queue.shift();
      if (item === undefined) break;
      let target: T | null;
      try {
        target = await args.resolve(item.pair);
      } catch {
        target = null;
      }
      if (target !== null && (best === null || item.sequence > best.sequence))
        best = { target, sequence: item.sequence };
    }
    resolving = false;
    if (!disposed) publish(best?.target ?? null);
  };
  return {
    enqueue(pair: NotificationResponsePair) {
      if (disposed) return;
      if (ready) args.start?.();
      else pendingStart = true;
      args.focus();
      queue.unshift({ pair, sequence: ++sequence });
      if (queue.length > 16) queue.pop();
      if (!resolving) {
        resolving = true;
        // Native intake drains its bounded startup queue synchronously. Start after that drain so
        // the newest pending candidate is checked first, then older locators are fallbacks.
        queueMicrotask(() => {
          void drain();
        });
      }
    },
    setReady() {
      if (disposed) return;
      ready = true;
      if (pendingStart) {
        pendingStart = false;
        args.start?.();
      }
      if (pending !== undefined) {
        args.publish(pending);
        pending = undefined;
      }
    },
    setUnready() {
      ready = false;
      if (resolving || pending !== undefined) pendingStart = true;
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      pending = undefined;
      pendingStart = false;
    },
  };
}
