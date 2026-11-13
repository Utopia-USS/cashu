// The phone's notification wiring at startup: the platform half (the expo scheduler and the bench log),
// the background re-plan and the wipe's cancel. Imported by the app entry (`index.ts`) right after
// `src/boot.ts` (the language source first) and before Expo Router loads a route: iOS may launch the app
// in the background only to run the task, and the task must be defined by then.
//
// The background task is best effort: iOS runs it when it decides (often overnight, with charge and
// network; never on the simulator), so it only refreshes the counts of digests already planned in the
// foreground. Nothing promises its timing.

import { defineBackgroundTask, registerBackgroundTask } from "../platform/backgroundTask";
import { appendBenchLog } from "../platform/benchLog";
import { expoScheduler } from "../platform/notifications";
import { bootServices } from "../services/services";
import { onBeforeWipe } from "../services/wipe";
import { type NotificationPlatform, runPlan } from "./runPlan";
import { forgetNotifications } from "./scheduler";

const TASK = "cashu.notifications.plan";
/** A hint to iOS, in minutes: about every six hours. */
const TASK_INTERVAL_MINUTES = 6 * 60;

export const phoneNotifications: NotificationPlatform = {
  scheduler: expoScheduler,
  log: appendBenchLog,
};

// Module scope: a background launch runs the bundle without mounting a screen.
defineBackgroundTask(TASK, async () => {
  const outcome = await runPlan(bootServices(), phoneNotifications, "task");
  return outcome !== null;
});

// Removing this phone forgets its notifications before the data goes: pending ones (previews included)
// cancelled, delivered ones taken off Notification Center and the lock screen.
onBeforeWipe(() => forgetNotifications(expoScheduler));

// Ask iOS for the background re-plan on every start (a no-op once registered); skipped where background
// tasks are unavailable, as on the simulator.
registerBackgroundTask(TASK, TASK_INTERVAL_MINUTES).then(
  (status) => appendBenchLog({ kind: "notifications_task", status }),
  (error: unknown) => appendBenchLog({ kind: "notifications_task", error: String(error) }),
);
