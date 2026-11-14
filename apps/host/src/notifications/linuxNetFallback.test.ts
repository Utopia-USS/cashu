import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dbus from "dbus-next";
import { expect, it } from "vitest";

/** Real dbus-next transport against a private socket; no desktop session bus is contacted. */
it("reaches a private Unix socket through the Node net fallback and starts D-Bus AUTH", async () => {
  const directory = mkdtempSync(join(tmpdir(), "t45-dbus-net-"));
  const socketPath = join(directory, "bus.sock");
  let auth = "";
  let received: () => void = () => {};
  const observed = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = createServer((socket) => {
    socket.on("data", (bytes: Buffer) => {
      auth += bytes.toString("utf8");
      if (auth.includes("AUTH EXTERNAL")) received();
    });
  });
  let bus: ReturnType<typeof dbus.sessionBus> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    bus = dbus.sessionBus({ busAddress: `unix:path=${socketPath}` });
    bus.on("error", () => {});
    await Promise.race([
      observed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("private_auth_timeout")), 1_000),
      ),
    ]);
    expect(auth.startsWith("\0AUTH EXTERNAL")).toBe(true);
  } finally {
    bus?.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 3_000);
