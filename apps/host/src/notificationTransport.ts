/** Lazy platform selection. S40's exclusive worker binding decides when a notifier actually runs. */

import { linuxNotificationTransport } from "./notifications/linux.js";
import { linuxSessionBus } from "./notifications/linuxSessionBus.js";
import type { NotificationTransport } from "./notifications/notifier.js";
import { windowsNotificationTransport } from "./notifications/windows.js";
import { macNotificationTransport } from "./notificationTransportMac.js";

export function platformNotificationTransport(
  onClick: (requestId: string, intentToken: string) => void,
): NotificationTransport & { dispose?(): void } {
  if (process.platform === "darwin") return macNotificationTransport();
  if (process.platform === "linux") {
    try {
      return linuxNotificationTransport(linuxSessionBus(), onClick);
    } catch {
      return windowsNotificationTransport;
    }
  }
  return windowsNotificationTransport;
}
