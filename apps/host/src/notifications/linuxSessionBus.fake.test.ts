import { EventEmitter } from "node:events";
import { Message, type MessageBus, MessageType } from "dbus-next";
import { expect, it } from "vitest";
import { linuxSessionBus } from "./linuxSessionBus.js";

const address = `unix:path=/tmp/cashu-private-bus,guid=${"a".repeat(32)}`;
function fakeBus(failStartup = false) {
  const emitter = new EventEmitter();
  const bus = Object.assign(emitter, {
    call: async (message: Message) => {
      if (message.member === "AddMatch" && failStartup) throw new Error("match_refused");
      if (message.member === "GetNameOwner")
        return new Message({
          type: MessageType.METHOD_RETURN,
          replySerial: "1",
          sender: "org.freedesktop.DBus",
          signature: "s",
          body: [":1.42"],
        });
      return new Message({
        type: MessageType.METHOD_RETURN,
        replySerial: "1",
        signature: "",
        body: [],
      });
    },
    disconnect: () => {},
  });
  return bus as unknown as MessageBus;
}

it("handles startup match failure before any submit observes readiness", async () => {
  const bus = fakeBus(true);
  const adapter = linuxSessionBus(address, () => bus);
  await Promise.resolve();
  await expect(adapter.currentOwner()).rejects.toThrow("match_refused");
  adapter.close();
  expect(() => bus.emit("error", new Error("late_stream_error"))).not.toThrow();
});

it("keeps a retired connection's late error from affecting its replacement", async () => {
  const first = fakeBus();
  const second = fakeBus();
  let opened = 0;
  const adapter = linuxSessionBus(address, () => [first, second][opened++] as MessageBus);
  expect(await adapter.currentOwner()).toBe(":1.42");
  adapter.reset();
  expect(() => first.emit("error", new Error("late_stream_error"))).not.toThrow();
  expect(await adapter.currentOwner()).toBe(":1.42");
  adapter.close();
  expect(() => second.emit("error", new Error("late_stream_error"))).not.toThrow();
});

it("accepts NotificationClosed only from the current service owner", async () => {
  const bus = fakeBus();
  const adapter = linuxSessionBus(address, () => bus);
  expect(await adapter.currentOwner()).toBe(":1.42");
  const closed: number[] = [];
  adapter.onClosed((_owner, id) => closed.push(id));
  const emit = (sender: string, id: number) =>
    bus.emit(
      "message",
      new Message({
        type: MessageType.SIGNAL,
        path: "/org/freedesktop/Notifications",
        interface: "org.freedesktop.Notifications",
        member: "NotificationClosed",
        sender,
        signature: "uu",
        body: [id, 2],
      }),
    );
  emit(":1.99", 7);
  emit(":1.42", 0);
  emit(":1.42", 7);
  expect(closed).toEqual([7]);
  adapter.close();
});
