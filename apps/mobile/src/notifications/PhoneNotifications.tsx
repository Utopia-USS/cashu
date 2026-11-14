// The phone's notifications in the running app (mounted once by the root layout, under the profile;
// renders nothing): the planner over the expo scheduler and the taps.
import { phoneNotifications } from "./backgroundTask";
import { useNotificationPlanner } from "./useNotificationPlanner";
import { useNotificationResponse } from "./useNotificationResponse";

export function PhoneNotifications() {
  useNotificationPlanner(phoneNotifications);
  useNotificationResponse();
  return null;
}
