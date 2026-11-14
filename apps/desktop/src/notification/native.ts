import { createRequire } from "node:module";
import { join } from "node:path";
import type { NotifyFrame } from "@cashu/host-protocol";

export type PermissionStatus = "allowed" | "denied" | "pending" | "unavailable";
export type PostStatus = "accepted" | "rejected" | "unknown";

interface NotificationIdentity {
  bundleIdentifier: string;
  bundleURL: string;
  executableName: string;
  executableURL: string;
  verified: boolean;
}

export interface NativeNotificationCenter {
  identity(): NotificationIdentity;
  permissionStatus(): Promise<PermissionStatus>;
  post(request: NotifyFrame): Promise<PostStatus>;
  /** Called only by the explicit, origin-checked Settings action. */
  requestPermission(): Promise<PermissionStatus>;
  installResponseHandler(callback: (value: unknown) => void): boolean;
  releaseResponseHandler(): void;
}

const require = createRequire(import.meta.url);

/** The addon is a fixed packaged resource; no caller may select another binary. */
export function loadNativeNotificationCenter(): NativeNotificationCenter | null {
  if (process.platform !== "darwin" || !process.resourcesPath) return null;
  try {
    return require(
      join(process.resourcesPath, "native", "CashUNotifications.node"),
    ) as NativeNotificationCenter;
  } catch {
    return null;
  }
}

export function installResponseHandler(callback: (value: unknown) => void): boolean {
  const center = loadNativeNotificationCenter();
  if (!center) return false;
  try {
    return center.installResponseHandler(callback);
  } catch {
    return false;
  }
}

export function releaseResponseHandler(): void {
  try {
    loadNativeNotificationCenter()?.releaseResponseHandler();
  } catch {
    /* The app is already shutting down. */
  }
}
