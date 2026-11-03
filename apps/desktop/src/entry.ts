/// <reference types="node" />
import { app } from "electron/main";
import { dispatchDesktopEntry } from "./entryDispatch.js";
import { registerEarlyNotificationResponses } from "./notification/early.js";

// Helper selection must precede loading main.ts: main resolves userData, logs, host and windows at
// module evaluation time. A malformed helper invocation never falls through to ordinary startup.
const args = process.argv.slice(app.isPackaged ? 1 : 2);
const exitCode = await dispatchDesktopEntry(args, {
  registerEarlyResponses: registerEarlyNotificationResponses,
  loadMain: () => import("./main.js"),
  runHelper: async () => (await import("./notification/helper.js")).runNotificationHelper(),
});
if (exitCode !== null) app.exit(exitCode);
