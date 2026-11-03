import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hostNotificationCapability } from "./notificationCapability.js";
import { privateNotificationIntents } from "./notifications/intentLedger.js";
import type { NotificationSubmission } from "./notifications/notifier.js";

it("shares one durable ledger with the notifier and closes its live click transport", async () => {
  const directory = mkdtempSync(join(tmpdir(), "t45-notification-capability-"));
  try {
    const intents = privateNotificationIntents(directory, () => true, Date.now);
    let frame: NotificationSubmission | undefined;
    let click: ((requestId: string, intentToken: string) => void) | undefined;
    let closed = false;
    const capability = hostNotificationCapability(
      intents,
      () => true,
      (onClick) => {
        click = onClick;
        return {
          submit: async (value) => {
            frame = value;
            return { state: "accepted" };
          },
          dispose: () => {
            closed = true;
          },
        };
      },
    );
    const received: string[] = [];
    const notifier = capability.notifier((requestId, intentToken) => {
      received.push(`${requestId}:${intentToken}`);
    });
    expect(notifier).not.toBeNull();
    expect(
      await notifier?.send({ vaultId: "native-vault", kind: "generic", locale: "en" }),
    ).toEqual({ state: "accepted" });
    if (frame === undefined) throw new Error("missing_submission");
    expect(capability.intents.resolve(frame.requestId, frame.intentToken)?.vaultId).toBe(
      "native-vault",
    );
    click?.(frame.requestId, frame.intentToken);
    expect(received).toEqual([`${frame.requestId}:${frame.intentToken}`]);
    capability.dispose();
    expect(closed).toBe(true);
    expect(capability.notifier(() => {})).toBeNull();
    expect(
      await notifier?.send({ vaultId: "native-vault", kind: "generic", locale: "en" }),
    ).toEqual({ state: "rejected", reason: "unavailable" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
