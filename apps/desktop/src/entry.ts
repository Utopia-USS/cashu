/// <reference types="node" />
import { app, protocol } from "electron/main";
import { dispatchDesktopEntry } from "./entryDispatch.js";
import { registerEarlyNotificationResponses } from "./notification/early.js";

// Helper selection must precede loading main.ts: main resolves userData, logs, host and windows at
// module evaluation time. A malformed helper invocation never falls through to ordinary startup.
const args = process.argv.slice(app.isPackaged ? 1 : 2);
if (
  app.isPackaged &&
  process.env.CASHU_TESTING === "1" &&
  args.length === 1 &&
  args[0] === "--t46-probe-identity"
) {
  const identity = (await import("./notification/native.js"))
    .loadNativeNotificationCenter()
    ?.identity();
  process.stdout.write(`${JSON.stringify(identity ?? { verified: false })}\n`);
  app.exit(identity?.verified ? 0 : 2);
} else {
  const exitCode = await dispatchDesktopEntry(args, {
    registerAppScheme: () =>
      protocol.registerSchemesAsPrivileged([
        {
          scheme: "app",
          privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
        },
      ]),
    registerEarlyResponses: registerEarlyNotificationResponses,
    loadMain: () => import("./main.js"),
    runHelper: async () => (await import("./notification/helper.js")).runNotificationHelper(),
    refuseCommand: (command) =>
      process.stderr.write(
        `cashU: "${command}" is not a command of this app; use ${process.execPath} only to open the window, and the bundled shim (Contents/Resources/shim.mjs) for the CLI\n`,
      ),
  });
  if (exitCode !== null) app.exit(exitCode);
}
