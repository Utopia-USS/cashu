/** Genuine worker delivery facts; device-local notification rows stay outside the synchronized view. */
import { toStorage } from "@cashu/domain";
import { views } from "@cashu/domain/investments";
import type { NotificationState } from "../local/notificationQueue.js";
import { decisions } from "./journal.js";
import type { Read } from "./shared.js";
import { signalByGid } from "./signals.js";
export function workerNotificationState(
  read: Read,
  signalGid: string,
  createdAt: string,
): { readonly state: NotificationState; readonly message: string } | undefined {
  const signal = signalByGid(read, signalGid);
  if (signal === undefined) return undefined;
  return {
    message: signal.message,
    state: {
      status: signal.status,
      severity: signal.severity,
      snoozedUntil: signal.snoozedUntil,
      hidden: views.hiddenFromOwner(signal),
      decided: decisions(read, { signal: signalGid }).some(
        (d) => toStorage(d.createdAt) >= toStorage(createdAt),
      ),
    },
  };
}
