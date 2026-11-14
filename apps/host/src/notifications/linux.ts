/** Session D-Bus notifications. Click routing is limited to this live host process. */

import { S } from "../worker/worker.strings.js";
import type {
  NotificationSubmission,
  NotificationTransport,
  SubmissionResult,
} from "./notifier.js";

export interface LinuxNotificationBus {
  /** A null owner proves service absence before Notify starts. */
  currentOwner(): Promise<string | null>;
  /** Notify targets this unique owner, never an auto-activating well-known name. */
  notify(
    owner: string,
    input: {
      readonly appName: "cashU";
      readonly title: "cashU";
      readonly body: string;
      readonly actions: readonly ["default", string];
    },
  ): Promise<number>;
  onActionInvoked(callback: (owner: string, serverId: number, action: string) => void): () => void;
  onClosed(callback: (owner: string, serverId: number) => void): () => void;
  onOwnerChanged(callback: () => void): () => void;
  reset(): void;
  close(): void;
}

const MAX_CLICKS = 1024;
const CLICK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const uniqueOwner = (owner: string | null): owner is string =>
  owner !== null && /^:[0-9]+\.[0-9]+(?:\.[0-9]+)*$/.test(owner);

export function linuxNotificationTransport(
  bus: LinuxNotificationBus,
  onClick: (requestId: string, intentToken: string) => void,
  timeoutMs = 10_000,
  now: () => number = Date.now,
): NotificationTransport & { dispose(): void } {
  const clicks = new Map<string, { requestId: string; intentToken: string; expiresAt: number }>();
  const closedIds = new Set<string>();
  let generation = 0;
  let closed = false;
  const key = (owner: string, id: number) => `${owner}/${id}`;
  const prune = () => {
    for (const [id, click] of clicks) if (click.expiresAt <= now()) clicks.delete(id);
  };
  const offAction = bus.onActionInvoked((owner, id, action) => {
    if (closed || action !== "default" || !uniqueOwner(owner) || !Number.isInteger(id) || id === 0)
      return;
    prune();
    const idKey = key(owner, id);
    const click = clicks.get(idKey);
    if (click === undefined) return;
    clicks.delete(idKey);
    onClick(click.requestId, click.intentToken);
  });
  const offClosed = bus.onClosed((owner, id) => {
    if (!closed && uniqueOwner(owner) && Number.isInteger(id) && id > 0) {
      const idKey = key(owner, id);
      clicks.delete(idKey);
      if (closedIds.size >= MAX_CLICKS) closedIds.delete(closedIds.values().next().value as string);
      closedIds.add(idKey);
    }
  });
  const offOwner = bus.onOwnerChanged(() => {
    generation++;
    clicks.clear();
    closedIds.clear();
  });
  const dispose = () => {
    if (closed) return;
    closed = true;
    generation++;
    clicks.clear();
    closedIds.clear();
    offAction();
    offClosed();
    offOwner();
    bus.close();
  };
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            generation++;
            clicks.clear();
            closedIds.clear();
            try {
              bus.reset();
            } catch {
              dispose();
            }
            reject(new Error("notification_timeout"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return {
    async submit(frame: NotificationSubmission): Promise<SubmissionResult> {
      if (closed) return { state: "rejected", reason: "unavailable" };
      const body = S[frame.kind]?.[frame.locale];
      if (body === undefined) return { state: "rejected", reason: "invalid" };
      let owner: string | null;
      try {
        owner = await bounded(bus.currentOwner());
      } catch {
        return { state: "rejected", reason: "unavailable" };
      }
      if (!uniqueOwner(owner) || closed) return { state: "rejected", reason: "unavailable" };
      const before = generation;
      try {
        const id = await bounded(
          bus.notify(owner, {
            appName: "cashU",
            title: "cashU",
            body,
            actions: ["default", S.openAction[frame.locale]],
          }),
        );
        // A reply proves acceptance even if the service changed while it was in flight.
        // Its click cannot safely be routed after that change.
        if (!Number.isInteger(id) || id <= 0 || id > 0xffff_ffff) return { state: "unknown" };
        if (!closed && before === generation) {
          prune();
          if (!closedIds.delete(key(owner, id))) {
            if (clicks.size >= MAX_CLICKS) clicks.delete(clicks.keys().next().value as string);
            clicks.set(key(owner, id), {
              requestId: frame.requestId,
              intentToken: frame.intentToken,
              expiresAt: now() + CLICK_TTL_MS,
            });
          }
        }
        return { state: "accepted" };
      } catch {
        return { state: "unknown" };
      }
    },
    dispose,
  };
}
