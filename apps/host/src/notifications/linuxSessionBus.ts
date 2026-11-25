/** Production session D-Bus connection for freedesktop notifications. */
import dbus, { Message, type MessageBus, MessageType } from "dbus-next";
import type { LinuxNotificationBus } from "./linux.js";

const NAME = "org.freedesktop.Notifications";
const PATH = "/org/freedesktop/Notifications";
const IFACE = "org.freedesktop.Notifications";
const DBUS = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const OWNER_MATCH = `type='signal',sender='${DBUS}',interface='${DBUS}',path='${DBUS_PATH}',member='NameOwnerChanged',arg0='${NAME}'`;
const ACTION_MATCH = `type='signal',interface='${IFACE}',path='${PATH}',member='ActionInvoked'`;
const CLOSED_MATCH = `type='signal',interface='${IFACE}',path='${PATH}',member='NotificationClosed'`;
const ownerPattern = /^:[0-9]+\.[0-9]+(?:\.[0-9]+)*$/;

function method(
  destination: string,
  path: string,
  iface: string,
  member: string,
  signature: string,
  body: unknown[],
) {
  return new Message({ destination, path, interface: iface, member, signature, body });
}

/** Owns one bus connection at a time. reset() drops pending calls on timeout. */
export function linuxSessionBus(
  busAddress = process.env.DBUS_SESSION_BUS_ADDRESS,
  openBus: (address: string) => MessageBus = (address) => dbus.sessionBus({ busAddress: address }),
): LinuxNotificationBus & { reset(): void } {
  const actions = new Set<(owner: string, serverId: number, action: string) => void>();
  const closures = new Set<(owner: string, serverId: number) => void>();
  const ownerChanges = new Set<() => void>();
  let closed = false;
  let owner: string | null = null;
  let ownerSerial = 0;
  let connection: MessageBus;
  let ready: Promise<void>;
  let epoch = 0;
  const changed = () => {
    for (const callback of ownerChanges) callback();
  };
  const receive = (message: Message) => {
    if (message.type !== MessageType.SIGNAL) return;
    if (
      message.path === PATH &&
      message.interface === IFACE &&
      message.member === "NotificationClosed" &&
      message.signature === "uu" &&
      message.sender === owner &&
      ownerPattern.test(message.sender)
    ) {
      const [id, reason] = message.body;
      if (
        Number.isInteger(id) &&
        id > 0 &&
        id <= 0xffff_ffff &&
        Number.isInteger(reason) &&
        reason >= 1 &&
        reason <= 4
      )
        for (const callback of closures) callback(message.sender, id);
      return;
    }
    if (
      message.sender === DBUS &&
      message.path === DBUS_PATH &&
      message.interface === DBUS &&
      message.member === "NameOwnerChanged" &&
      message.signature === "sss" &&
      message.body[0] === NAME
    ) {
      const next = message.body[2];
      ownerSerial++;
      owner = typeof next === "string" && ownerPattern.test(next) ? next : null;
      changed();
      return;
    }
    if (
      message.path !== PATH ||
      message.interface !== IFACE ||
      message.member !== "ActionInvoked" ||
      message.signature !== "us" ||
      message.sender !== owner ||
      !ownerPattern.test(message.sender)
    )
      return;
    const [id, action] = message.body;
    if (!Number.isInteger(id) || id <= 0 || id > 0xffff_ffff || typeof action !== "string") return;
    for (const callback of actions) callback(message.sender, id, action);
  };
  const connect = () => {
    const current = ++epoch;
    if (
      busAddress === undefined ||
      busAddress.length > 4096 ||
      busAddress.includes(String.fromCharCode(0)) ||
      !/^unix:path=\/[^,;:]+(?:,guid=[0-9a-fA-F]{32})?$/.test(busAddress)
    )
      throw new Error("notification_session_bus_unavailable");
    connection = openBus(busAddress);
    const bus = connection;
    bus.on("message", receive);
    bus.on("error", () => {
      if (closed || current !== epoch) return;
      owner = null;
      changed();
    });
    ready = Promise.all(
      [OWNER_MATCH, ACTION_MATCH, CLOSED_MATCH].map((rule) =>
        bus.call(method(DBUS, DBUS_PATH, DBUS, "AddMatch", "s", [rule])),
      ),
    ).then(() => undefined);
    // A connection can fail before the first submit awaits readiness.
    void ready.catch(() => undefined);
  };
  const drop = () => {
    epoch++;
    ownerSerial++;
    owner = null;
    changed();
    connection.removeListener("message", receive);
    // Keep the retired bus's error listener as a sink for late stream errors.
    // Its epoch check prevents it from changing the replacement connection.
    try {
      connection.disconnect();
    } catch {
      /* The connection is already gone. */
    }
  };
  connect();
  return {
    async currentOwner() {
      if (closed) throw new Error("notification_bus_closed");
      const current = epoch;
      await ready;
      if (closed || current !== epoch) throw new Error("notification_bus_replaced");
      const serial = ownerSerial;
      let reply: Message | null;
      try {
        reply = await connection.call(method(DBUS, DBUS_PATH, DBUS, "GetNameOwner", "s", [NAME]));
      } catch (error) {
        if ((error as { type?: string }).type === `${DBUS}.Error.NameHasNoOwner`) {
          if (owner !== null) {
            owner = null;
            changed();
          }
          return null;
        }
        throw error;
      }
      if (closed || current !== epoch || serial !== ownerSerial)
        throw new Error("notification_bus_replaced");
      const next = reply?.body[0];
      if (reply?.sender !== DBUS || typeof next !== "string" || !ownerPattern.test(next))
        throw new Error("notification_owner_invalid");
      if (owner !== null && owner !== next) changed();
      owner = next;
      return next;
    },
    async notify(target, input) {
      if (closed || !ownerPattern.test(target) || target !== owner)
        throw new Error("notification_owner_changed");
      const current = epoch;
      await ready;
      if (closed || current !== epoch || target !== owner)
        throw new Error("notification_owner_changed");
      const reply = await connection.call(
        method(target, PATH, IFACE, "Notify", "susssasa{sv}i", [
          input.appName,
          0,
          "",
          input.title,
          input.body,
          [...input.actions],
          {},
          -1,
        ]),
      );
      if (
        closed ||
        current !== epoch ||
        target !== owner ||
        reply?.sender !== target ||
        reply.signature !== "u" ||
        !Number.isInteger(reply.body[0])
      )
        throw new Error("notification_reply_uncertain");
      return reply.body[0] as number;
    },
    onActionInvoked(callback) {
      actions.add(callback);
      return () => {
        actions.delete(callback);
      };
    },
    onClosed(callback) {
      closures.add(callback);
      return () => {
        closures.delete(callback);
      };
    },
    onOwnerChanged(callback) {
      ownerChanges.add(callback);
      return () => {
        ownerChanges.delete(callback);
      };
    },
    reset() {
      if (closed) return;
      drop();
      connect();
    },
    close() {
      if (closed) return;
      closed = true;
      drop();
      actions.clear();
      closures.clear();
      ownerChanges.clear();
    },
  };
}
