import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dbus, { Message, type MessageBus } from "dbus-next";
import { expect, it } from "vitest";
import { linuxNotificationTransport } from "./linux.js";
import { linuxSessionBus } from "./linuxSessionBus.js";

const NAME = "org.freedesktop.Notifications";
const PATH = "/org/freedesktop/Notifications";
const IFACE = NAME;

// Only a private daemon with a private unix:path socket is used. No real desktop bus or server is touched.
it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/dbus-daemon"))(
  "submits through a private Unix session bus and routes only its live action signal",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "cashu-notification-bus-"));
    const address = `unix:path=${join(directory, "bus.sock")}`;
    const daemon = spawn(
      "/usr/bin/dbus-daemon",
      ["--session", "--nofork", `--address=${address}`, "--print-address=1"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let service: MessageBus | undefined;
    let transport: ReturnType<typeof linuxNotificationTransport> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("private_bus_start_timeout")), 2_000);
        daemon.once("error", reject);
        daemon.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes("\n")) {
            clearTimeout(timer);
            resolve();
          }
        });
        daemon.once("exit", () => reject(new Error("private_bus_exited")));
      });
      service = dbus.sessionBus({ busAddress: address });
      await service.requestName(NAME, 0);
      let submitted: Message | undefined;
      service.addMethodHandler((message: Message) => {
        if (message.path !== PATH || message.interface !== IFACE || message.member !== "Notify")
          return false;
        submitted = message;
        service?.send(Message.newMethodReturn(message, "u", [7]));
        return true;
      });
      const clicked: string[] = [];
      let clickReceived: () => void = () => {};
      const click = new Promise<void>((resolve) => {
        clickReceived = resolve;
      });
      transport = linuxNotificationTransport(linuxSessionBus(address), (requestId, token) => {
        clicked.push(`${requestId}:${token}`);
        clickReceived();
      });
      const frame = {
        version: 1 as const,
        requestId: "f09aebd7-5eac-4d87-8130-751ad06facd4",
        locale: "en" as const,
        kind: "signal" as const,
        intentToken: "a".repeat(64),
      };
      expect(await transport.submit(frame)).toEqual({ state: "accepted" });
      expect(submitted?.signature).toBe("susssasa{sv}i");
      expect(submitted?.body).toEqual([
        "cashU",
        0,
        "",
        "cashU",
        "New signal in cashU.",
        ["default", "Open cashU"],
        {},
        -1,
      ]);
      expect(JSON.stringify(submitted?.body)).not.toContain(frame.intentToken);
      expect(JSON.stringify(submitted?.body)).not.toContain(frame.requestId);
      service.send(Message.newSignal(PATH, IFACE, "ActionInvoked", "us", [7, "default"]));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("private_action_timeout")), 500);
        void click.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      expect(clicked).toEqual([`${frame.requestId}:${frame.intentToken}`]);
    } finally {
      transport?.dispose();
      service?.disconnect();
      daemon.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  5_000,
);
