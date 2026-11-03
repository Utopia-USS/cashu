// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { readNotificationPermission, requestNotificationPermission } from "./notificationBridge.js";
import { T } from "./screens/settings/Settings.strings.js";

afterEach(() => {
  Reflect.deleteProperty(window, "cashuNotifications");
});

it("preserves the Linux system-managed status without claiming delivery or prompting", async () => {
  let requests = 0;
  Object.defineProperty(window, "cashuNotifications", {
    configurable: true,
    value: {
      status: async () => "system",
      requestPermission: async () => {
        requests++;
        return "system";
      },
    },
  });
  expect(await readNotificationPermission()).toBe("system");
  expect(requests).toBe(0);
  expect(T.notificationPermissionSystem).toContain("system");
  expect(await requestNotificationPermission()).toBe("system");
});
