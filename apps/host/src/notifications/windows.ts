/** Packaged toast identity and activation are not yet available on Windows. */
import type { NotificationTransport } from "./notifier.js";

export const windowsNotificationTransport: NotificationTransport = {
  async submit() {
    return { state: "rejected", reason: "unavailable" };
  },
};
