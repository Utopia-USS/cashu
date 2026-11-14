// Keeps this phone's scheduled notifications in line with its data and choices (mounted once, by
// `PhoneNotifications`). Plans after the first frame, when the app goes to the background
// (the user just left: the counts are the latest the phone has), and at once when a notification choice,
// a marked alert or the permission changes. A Control Center pull or a Face ID prompt (`inactive`) is not
// a trigger.
import { markedAlerts, notificationPrefs } from "@cashu/store/device";
import type { Read } from "@cashu/store/query";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useServices } from "../services/ServicesProvider";
import type { PlannerServices } from "./planner";
import { onReplanRequested } from "./replan";
import { createPlanRunner, type NotificationPlatform, runPlan } from "./runPlan";

/** The user's notification choices and marks on every vault: a change re-plans at once. */
function choicesOf(services: PlannerServices): string {
  const read: Read = (sql, ...params) => services.device.read(sql, ...params);
  return JSON.stringify(
    services.profiles.map(({ vault }) => [
      notificationPrefs.run(read, { vault }),
      markedAlerts.run(read, { vault }),
    ]),
  );
}

export function useNotificationPlanner(platform: NotificationPlatform): void {
  const services = useServices();
  useEffect(() => {
    const runner = createPlanRunner({
      run: (trigger, force) => runPlan(services, platform, trigger, force),
      now: Date.now,
    });
    const first = setTimeout(() => runner.request("start", true), 0);
    let previous = AppState.currentState;
    const appState = AppState.addEventListener("change", (state) => {
      // iOS goes active -> inactive -> background: plan on the arrival in the background.
      if (state === "background" && previous !== "background") runner.request("background", false);
      previous = state;
    });
    let choices = choicesOf(services);
    const settings = services.device.subscribe(["device_settings"], () => {
      // The planner's own ledger write lands here too; only a changed choice re-plans.
      const next = choicesOf(services);
      if (next === choices) return;
      choices = next;
      runner.request("settings", true);
    });
    const replan = onReplanRequested(() => runner.request("permission", true));
    return () => {
      clearTimeout(first);
      appState.remove();
      settings();
      replan();
      runner.dispose();
    };
  }, [services, platform]);
}
