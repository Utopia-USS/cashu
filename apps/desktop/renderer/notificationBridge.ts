import {
  type NotificationResolveResult,
  notificationResolveResultSchema,
} from "@cashu/host-protocol";

interface NotificationBridge {
  onTarget(handler: (target: NotificationResolveResult) => void): () => void;
  onPending(handler: () => void): () => void;
  status(): Promise<unknown>;
  requestPermission(): Promise<unknown>;
}

export type NotificationPermissionStatus =
  | "allowed"
  | "denied"
  | "pending"
  | "system"
  | "unavailable";
function permissionStatus(value: unknown): NotificationPermissionStatus {
  return value === "allowed" || value === "denied" || value === "pending" || value === "system"
    ? value
    : "unavailable";
}
export async function readNotificationPermission(): Promise<NotificationPermissionStatus> {
  try {
    return permissionStatus(await window.cashuNotifications?.status());
  } catch {
    return "unavailable";
  }
}
export async function requestNotificationPermission(): Promise<NotificationPermissionStatus> {
  try {
    return permissionStatus(await window.cashuNotifications?.requestPermission());
  } catch {
    return "unavailable";
  }
}

declare global {
  interface Window {
    readonly cashuNotifications?: NotificationBridge;
  }
}

/** Only main's authenticated resolution result reaches a screen, never the opaque click token. */
export function onNotificationTarget(
  handler: (target: NotificationResolveResult) => void,
): () => void {
  return (
    window.cashuNotifications?.onTarget((raw) => {
      const parsed = notificationResolveResultSchema.safeParse(raw);
      if (parsed.success) handler(parsed.data);
    }) ?? (() => {})
  );
}

/** A click entered main's resolver. Carries no request ID, token or vault data. */
export function onNotificationPending(handler: () => void): () => void {
  return window.cashuNotifications?.onPending(handler) ?? (() => {});
}
