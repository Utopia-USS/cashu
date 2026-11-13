// The port between the notification planner and the OS: what the planner may ask of iOS's local
// notification center. The expo implementation is `platform/notifications.ts` (the only file importing
// expo-notifications); tests use `testing/memoryScheduler.ts`. Only local notifications: nothing passes
// through a push service.
import type { NotificationKind } from "@cashu/domain/core/notifications";

export type NotificationPermission = "granted" | "denied" | "undetermined";

/** Every identifier the planner schedules starts with this; anything else in the OS list is not its. */
export const OUR_PREFIX = "cashu.";

/** The dev preview's identifiers: ours too, but outside the planner's (a re-plan never cancels them). */
export const PREVIEW_PREFIX = "cashu-preview.";

/** True for an identifier this app scheduled (the planner's or a preview). */
export function isOurs(id: string): boolean {
  return id.startsWith(OUR_PREFIX) || id.startsWith(PREVIEW_PREFIX);
}

export interface ScheduledNotification {
  /** Starts with `OUR_PREFIX`. */
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** Grouping in Notification Center (iOS `threadIdentifier`). */
  readonly thread: NotificationKind;
  /** What a tap needs: the vault and the kind (strings only, never an amount or a name). */
  readonly data: Readonly<Record<string, string>>;
  /** ISO instant, or null = deliver now. */
  readonly fireAt: string | null;
}

export interface NotificationScheduler {
  permission(): Promise<NotificationPermission>;
  /** Shows the iOS prompt while undetermined; answers the current state otherwise. */
  requestPermission(): Promise<"granted" | "denied">;
  /** The identifiers of our pending notifications (`isOurs`: the planner's and the previews). */
  scheduled(): Promise<readonly string[]>;
  /** Schedules, or replaces the pending one with the same id. */
  schedule(notification: ScheduledNotification): Promise<void>;
  cancel(ids: readonly string[]): Promise<void>;
  /** Removes every delivered notification of this app from Notification Center and the lock screen. */
  dismissDelivered(): Promise<void>;
}

/**
 * Forget everything this phone told or will tell (removing the phone): cancel our pending notifications,
 * previews included, and take the delivered ones off Notification Center and the lock screen, where
 * their titles ("cashU · Anna") and counts would outlive the data.
 */
export async function forgetNotifications(scheduler: NotificationScheduler): Promise<void> {
  const pending = await scheduler.scheduled();
  if (pending.length > 0) await scheduler.cancel(pending);
  await scheduler.dismissDelivered();
}

const DIGESTS: ReadonlySet<NotificationKind> = new Set(["evening", "weekly", "month_closed"]);

/**
 * A digest arrives quietly (designer #22.12): Notification Center and the lock screen only, never a
 * banner over the open app, never a sound. Alerts, warnings and device changes show a banner, no sound.
 */
export function isDigest(kind: string): boolean {
  return DIGESTS.has(kind as NotificationKind);
}
