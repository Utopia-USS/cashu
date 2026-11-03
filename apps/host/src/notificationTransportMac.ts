/** Packaged macOS helper transport. Bundle.main in the fixed native addon supplies the executable. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { NOTIFY_ACK_MAX_BYTES, parseNotifyAck, serializeNotifyFrame } from "@cashu/host-protocol";
import type {
  NotificationSubmission,
  NotificationTransport,
  SubmissionResult,
} from "./notifications/notifier.js";

const require = createRequire(import.meta.url);
const BUNDLE_ID = "io.utopiasoft.cashu.next";
const DEADLINE_MS = 10_000;

interface NativeIdentity {
  identity(): {
    readonly bundleIdentifier: string;
    readonly bundleURL: string;
    readonly executableURL: string;
    readonly verified: boolean;
  };
}

function bundledExecutable(): string | null {
  const resources = (process as typeof process & { resourcesPath?: string }).resourcesPath;
  if (process.platform !== "darwin" || !resources) return null;
  try {
    const addon = require(join(resources, "native", "CashUNotifications.node")) as NativeIdentity;
    const identity = addon.identity();
    if (
      !identity.verified ||
      identity.bundleIdentifier !== BUNDLE_ID ||
      !identity.bundleURL.endsWith(".app") ||
      !identity.executableURL.startsWith(`${identity.bundleURL}/Contents/MacOS/`)
    )
      return null;
    return identity.executableURL;
  } catch {
    return null;
  }
}

/** A valid ACK is evidence only after a normal helper exit. Every post-spawn failure is unknown. */
export function macNotificationTransport(): NotificationTransport {
  return {
    async submit(frame): Promise<SubmissionResult> {
      const executable = bundledExecutable();
      if (executable === null) return { state: "rejected", reason: "unavailable" };
      return submitNotificationHelper(frame, executable);
    },
  };
}

/** Test seam for a fake child only; production obtains executable from the native Bundle.main gate. */
export function submitNotificationHelper(
  frame: NotificationSubmission,
  executable: string,
  launch: typeof spawn = spawn,
): Promise<SubmissionResult> {
  let bytes: Uint8Array;
  try {
    bytes = serializeNotifyFrame(frame);
  } catch {
    return Promise.resolve({ state: "rejected", reason: "invalid" });
  }
  return new Promise<SubmissionResult>((resolve) => {
    let spawned = false;
    let settled = false;
    const finish = (result: SubmissionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const child = launch(executable, ["--notify-helper"], {
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      env: { HOME: process.env.HOME ?? "", LANG: process.env.LANG ?? "en_US.UTF-8" },
    });
    const output: Buffer[] = [];
    let size = 0;
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      finish(spawned ? { state: "unknown" } : { state: "rejected", reason: "unavailable" });
    }, DEADLINE_MS);
    child.once("spawn", () => {
      spawned = true;
      try {
        child.stdin.end(bytes);
      } catch {
        child.kill("SIGKILL");
        finish({ state: "unknown" });
      }
    });
    child.once("error", () =>
      finish(spawned ? { state: "unknown" } : { state: "rejected", reason: "unavailable" }),
    );
    child.stdin.on("error", () => {
      child.kill("SIGKILL");
      finish(spawned ? { state: "unknown" } : { state: "rejected", reason: "unavailable" });
    });
    child.stdout.on("error", () => {
      child.kill("SIGKILL");
      finish(spawned ? { state: "unknown" } : { state: "rejected", reason: "unavailable" });
    });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= NOTIFY_ACK_MAX_BYTES) output.push(chunk);
      else child.kill("SIGKILL");
    });
    child.once("close", (code) => {
      if (!spawned || code !== 0 || size > NOTIFY_ACK_MAX_BYTES)
        return finish(
          spawned ? { state: "unknown" } : { state: "rejected", reason: "unavailable" },
        );
      try {
        const ack = parseNotifyAck(Buffer.concat(output, size));
        if (ack.requestId !== frame.requestId) return finish({ state: "unknown" });
        if (ack.status === "accepted") return finish({ state: "accepted" });
        return finish({
          state: "rejected",
          reason: ack.status === "rejected" ? "invalid" : ack.status,
        });
      } catch {
        return finish({ state: "unknown" });
      }
    });
  });
}
