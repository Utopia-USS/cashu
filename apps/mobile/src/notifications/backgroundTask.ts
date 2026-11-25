// The phone's notification wiring at startup: the platform half (the expo scheduler and the bench log),
// the background sync and re-plan, and the wipe's cancel. Imported by the app entry (`index.ts`) right
// after `src/boot.ts` (the language source first) and before Expo Router loads a route: iOS may launch
// the app in the background only to run the task, and the task must be defined by then.
//
// The background task is best effort: iOS runs it when it decides (often overnight, with charge and
// network; never on the simulator), so it only refreshes the counts of digests already planned in the
// foreground. Nothing promises its timing. It is a processing task (expo-background-task submits a
// `BGProcessingTaskRequest`): it may get minutes while the phone idles, not a fixed 30 s, but iOS can
// expire it at any moment and the JS is not told, so the sync step is bounded from the task's start
// (`TASK_OPEN_WAIT_MS`, `syncRunner.ts`) and every write it makes must survive being cut off mid-way
// (the logs commit in transactions, the KeyStore replaces blobs atomically).

import { defineBackgroundTask, registerBackgroundTask } from "../platform/backgroundTask";
import { appendBenchLog } from "../platform/benchLog";
import { expoScheduler } from "../platform/notifications";
import { servicesReady } from "../services/services";
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
// Sync first, so the digests count what the other devices wrote since the last open.
defineBackgroundTask(TASK, async () => {
  const services = await servicesReady();
  await services.sync.request("task");
  const outcome = await runPlan(services, phoneNotifications, "task");
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
