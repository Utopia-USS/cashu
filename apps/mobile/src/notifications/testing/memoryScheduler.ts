// An in-memory `NotificationScheduler` for tests: pending notifications by id, the ones delivered at
// once, and a permission the test sets. Synthetic only; nothing reaches the OS.
import {
  isOurs,
  type NotificationPermission,
  type NotificationScheduler,
  type ScheduledNotification,
} from "../scheduler";

export interface MemoryScheduler extends NotificationScheduler {
  /** Pending (future) notifications, by id. */
  readonly pending: Map<string, ScheduledNotification>;
  /** Notifications delivered at once (`fireAt === null`) and not dismissed, in order. */
  readonly delivered: ScheduledNotification[];
  /** How many times `dismissDelivered` ran. */
  dismissals(): number;
  /** Ids passed to `cancel`, in order. */
  readonly cancelled: string[];
  setPermission(permission: NotificationPermission): void;
  /** What `requestPermission` answers while undetermined (default granted). */
  answerPrompt(answer: "granted" | "denied"): void;
}

export function memoryScheduler(
  initial: NotificationPermission = "granted",
  options: { readonly failSchedule?: boolean } = {},
): MemoryScheduler {
  let permission = initial;
  let answer: "granted" | "denied" = "granted";
  const pending = new Map<string, ScheduledNotification>();
  const delivered: ScheduledNotification[] = [];
  const cancelled: string[] = [];
  let dismissals = 0;
  return {
    pending,
    delivered,
    cancelled,
    setPermission: (next) => {
      permission = next;
    },
    answerPrompt: (next) => {
      answer = next;
    },
    permission: async () => permission,
    requestPermission: async () => {
      if (permission === "undetermined") permission = answer;
      return permission === "granted" ? "granted" : "denied";
    },
    scheduled: async () => [...pending.keys()].filter(isOurs),
    schedule: async (n) => {
      if (options.failSchedule) throw new Error("synthetic schedule failure");
      if (n.fireAt === null) delivered.push(n);
      else pending.set(n.id, n);
    },
    cancel: async (ids) => {
      for (const id of ids) {
        cancelled.push(id);
        pending.delete(id);
      }
    },
    dismissDelivered: async () => {
      dismissals++;
      delivered.length = 0;
    },
    dismissals: () => dismissals,
  };
}
