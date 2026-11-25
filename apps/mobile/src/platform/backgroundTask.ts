// iOS background work through expo-background-task (one BGProcessingTask for every JS task) and
// expo-task-manager: the only file importing them. Best effort only: iOS decides when (often overnight,
// with charge and network), never on the simulator, and not at all after the user swipes the app away
// until the next launch. Nothing may rely on its timing.
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";

/**
 * Define the task at module scope (iOS may launch the app in the background to run it, before any
 * screen mounts). `run` answers whether the work succeeded; a throw counts as failed.
 */
export function defineBackgroundTask(name: string, run: () => Promise<boolean>): void {
  TaskManager.defineTask(name, async () => {
    try {
      return (await run())
        ? BackgroundTask.BackgroundTaskResult.Success
        : BackgroundTask.BackgroundTaskResult.Failed;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

/**
 * Ask iOS to run the task about every `minutes` (a hint; at least 15). `restricted` when background
 * tasks are unavailable here (the simulator, Background App Refresh off): nothing was registered.
 */
export async function registerBackgroundTask(
  name: string,
  minutes: number,
): Promise<"registered" | "restricted"> {
  const status = await BackgroundTask.getStatusAsync();
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) return "restricted";
  await BackgroundTask.registerTaskAsync(name, { minimumInterval: minutes });
  return "registered";
}
