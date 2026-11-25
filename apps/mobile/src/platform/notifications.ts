// The phone's local notifications through expo-notifications: the `NotificationScheduler` the planner
// uses, the foreground presentation (calm: a digest goes to the list only, an alert or a warning shows
// a banner, never a sound; designer #22.12) and the last tap. The only file importing expo-notifications.
// Local only: the app.json plugin sets `enableRemoteNotifications: false`, so there is no APNs
// entitlement and nothing passes through a push service.
import * as Notifications from "expo-notifications";
import {
  isDigest,
  isOurs,
  type NotificationPermission,
  type NotificationScheduler,
} from "../notifications/scheduler";

// Module scope, once: how a notification shows while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const kind = notification.request.content.data?.kind;
    const digest = typeof kind === "string" && isDigest(kind);
    return {
      shouldShowBanner: !digest,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});

function permissionOf(status: Notifications.NotificationPermissionsStatus): NotificationPermission {
  if (status.granted) return "granted";
  return status.status === "undetermined" ? "undetermined" : "denied";
}

export const expoScheduler: NotificationScheduler = {
  permission: async () => permissionOf(await Notifications.getPermissionsAsync()),
  requestPermission: async () => {
    // No sound and no badge are ever used: only the alert itself is asked for.
    const status = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: false, allowSound: false },
    });
    return permissionOf(status) === "granted" ? "granted" : "denied";
  },
  scheduled: async () =>
    (await Notifications.getAllScheduledNotificationsAsync())
      .map((request) => request.identifier)
      .filter(isOurs),
  schedule: async (n) => {
    await Notifications.scheduleNotificationAsync({
      identifier: n.id,
      content: {
        title: n.title,
        body: n.body,
        data: { ...n.data },
        threadIdentifier: n.thread,
        interruptionLevel: isDigest(n.thread) ? "passive" : "active",
        sound: false,
      },
      trigger:
        n.fireAt === null
          ? null
          : { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(n.fireAt) },
    });
  },
  cancel: async (ids) => {
    await Promise.all(ids.map((id) => Notifications.cancelScheduledNotificationAsync(id)));
  },
  // The app delivers nothing but its own local notifications, so "all" is ours.
  dismissDelivered: () => Notifications.dismissAllNotificationsAsync(),
};

/** What a tapped notification carried (string values only), or null. */
export interface NotificationTap {
  /** Unique per tap: the notification's id and delivery time. */
  readonly key: string;
  readonly data: Readonly<Record<string, string>>;
}

/** The last notification the user tapped (the default action), until `clearNotificationTap`. */
export function useNotificationTap(): NotificationTap | null {
  const response = Notifications.useLastNotificationResponse();
  if (response == null || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER)
    return null;
  const { request, date } = response.notification;
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.content.data ?? {}))
    if (typeof value === "string") data[key] = value;
  return { key: `${request.identifier}@${date}`, data };
}

export function clearNotificationTap(): void {
  Notifications.clearLastNotificationResponse();
}
