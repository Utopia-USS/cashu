import { app } from "electron/main";
import { installResponseHandler } from "./native.js";
import { createResponseIntake } from "./responses.js";

/** One intake shared by entry and main before ordinary startup modules load. */
export const notificationIntake = createResponseIntake();

export function registerEarlyNotificationResponses(): void {
  app.on("will-finish-launching", () => {
    installResponseHandler((value) => notificationIntake.push(value));
  });
  app.on("ready", (_event, launchInfo) => {
    const info = launchInfo as
      | { notification?: { userInfo?: unknown }; userInfo?: unknown }
      | undefined;
    notificationIntake.push(info?.notification?.userInfo ?? info?.userInfo);
  });
}
