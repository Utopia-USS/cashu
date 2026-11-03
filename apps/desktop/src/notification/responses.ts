export interface NotificationResponsePair {
  readonly requestId: string;
  readonly intentToken: string;
}

export interface ResponseIntake {
  push(value: unknown): void;
  bind(handler: (pair: NotificationResponsePair) => void): void;
  dispose(): void;
}

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tokenPattern = /^[0-9a-f]{64}$/;
const MAX_PENDING = 16;
const MAX_SEEN = 128;

/** Accepts only the opaque native userInfo shape, or a previously parsed pair. */
export function parseNotificationResponse(value: unknown): NotificationResponsePair | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(",");
  if (keys !== "intentToken,requestId,version" && keys !== "intentToken,requestId") return null;
  if ("version" in row && row.version !== 1) return null;
  if (typeof row.requestId !== "string" || !requestIdPattern.test(row.requestId)) return null;
  if (typeof row.intentToken !== "string" || !tokenPattern.test(row.intentToken)) return null;
  return { requestId: row.requestId, intentToken: row.intentToken };
}

export function createResponseIntake(): ResponseIntake {
  let handler: ((pair: NotificationResponsePair) => void) | null = null;
  let disposed = false;
  const pending: NotificationResponsePair[] = [];
  const seen = new Set<string>();
  const deliver = (pair: NotificationResponsePair) => {
    try {
      handler?.(pair);
    } catch {
      /* A resolver failure must not invalidate native callback completion. */
    }
  };
  return {
    push(value) {
      if (disposed) return;
      const pair = parseNotificationResponse(value);
      if (!pair) return;
      const key = `${pair.requestId}:${pair.intentToken}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value as string);
      if (handler) deliver(pair);
      else {
        pending.push(pair);
        if (pending.length > MAX_PENDING) pending.shift();
      }
    },
    bind(nextHandler) {
      if (disposed) return;
      handler = nextHandler;
      // Main inserts each candidate at the front of its serial host-resolution queue.
      // Chronological drain therefore checks newest first without discarding older valid targets.
      for (const pair of pending.splice(0)) deliver(pair);
    },
    dispose() {
      disposed = true;
      handler = null;
      pending.length = 0;
      seen.clear();
    },
  };
}
