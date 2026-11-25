/** One host-lifetime notification capability. The worker supplies its live-click handler on demand. */

import type { NotificationIntentLedger } from "./notifications/intentLedger.js";
import { hostNotifier } from "./notifications/notifier.js";
import { platformNotificationTransport } from "./notificationTransport.js";
import type { WorkerNotifier } from "./worker/contracts.js";

export interface HostNotificationCapability {
  readonly intents: NotificationIntentLedger;
  notifier(onClick: (requestId: string, intentToken: string) => void): WorkerNotifier | null;
  dispose(): void;
}

export function hostNotificationCapability(
  intents: NotificationIntentLedger,
  isCurrent: () => boolean,
  makeTransport: typeof platformNotificationTransport = platformNotificationTransport,
): HostNotificationCapability {
  let disposed = false;
  let transport: ReturnType<typeof platformNotificationTransport> | undefined;
  let notifier: WorkerNotifier | undefined;
  return {
    intents,
    notifier(onClick) {
      if (disposed || !isCurrent()) return null;
      if (notifier === undefined) {
        transport = makeTransport(onClick);
        const delegate = hostNotifier(intents, transport);
        notifier = {
          name: delegate.name,
          send: (notification) =>
            disposed || !isCurrent()
              ? Promise.resolve({ state: "rejected", reason: "unavailable" })
              : delegate.send(notification),
        };
      }
      return notifier;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      transport?.dispose?.();
    },
  };
}
