import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { serializeNotifyAck } from "@cashu/host-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { submitNotificationHelper } from "./notificationTransportMac.js";

const frame = {
  version: 1 as const,
  requestId: "12345678-1234-4234-8234-123456789abc",
  locale: "en" as const,
  kind: "generic" as const,
  intentToken: "a".repeat(64),
};

function fakeHelper() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", null));
    return true;
  });
  const launch = vi.fn(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as unknown as typeof spawn;
  return { child, launch };
}

afterEach(() => vi.useRealTimers());

it("accepts only a matching canonical ACK from a normal helper exit", async () => {
  const { child, launch } = fakeHelper();
  const result = submitNotificationHelper(frame, "/synthetic/executable", launch);
  await Promise.resolve();
  child.stdout.write(
    serializeNotifyAck({ version: 1, requestId: frame.requestId, status: "accepted" }),
  );
  child.emit("close", 0);
  expect(await result).toEqual({ state: "accepted" });
  expect(launch).toHaveBeenCalledWith(
    "/synthetic/executable",
    ["--notify-helper"],
    expect.objectContaining({ shell: false, stdio: ["pipe", "pipe", "ignore"] }),
  );
});

it("keeps the claim on EPIPE after spawn without an unhandled stream error", async () => {
  const { child, launch } = fakeHelper();
  const result = submitNotificationHelper(frame, "/synthetic/executable", launch);
  await Promise.resolve();
  child.stdin.emit("error", new Error("EPIPE"));
  expect(await result).toEqual({ state: "unknown" });
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

it("kills an unresponsive exact child at the deadline and reports unknown", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { child, launch } = fakeHelper();
  const result = submitNotificationHelper(frame, "/synthetic/executable", launch);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toEqual({ state: "unknown" });
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

it.each(["malformed", "mismatched", "oversized"] as const)(
  "treats %s output after spawn as unknown",
  async (kind) => {
    const { child, launch } = fakeHelper();
    const result = submitNotificationHelper(frame, "/synthetic/executable", launch);
    await Promise.resolve();
    const output =
      kind === "malformed"
        ? Buffer.from("bad\n")
        : kind === "mismatched"
          ? Buffer.from(
              serializeNotifyAck({
                version: 1,
                requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                status: "accepted",
              }),
            )
          : Buffer.alloc(257, 65);
    child.stdout.write(output);
    child.emit("close", kind === "oversized" ? null : 0);
    expect(await result).toEqual({ state: "unknown" });
  },
);
