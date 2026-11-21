import { expect, it } from "vitest";
import { type LinuxNotificationBus, linuxNotificationTransport } from "./linux.js";

const frame = {
  version: 1 as const,
  requestId: "f09aebd7-5eac-4d87-8130-751ad06facd4",
  locale: "pl" as const,
  kind: "signal" as const,
  intentToken: "a".repeat(64),
};
const OWNER = ":1.42";
function fake(overrides: Partial<LinuxNotificationBus> = {}) {
  let action: (owner: string, id: number, key: string) => void = () => {};
  let closed: (owner: string, id: number) => void = () => {};
  let ownerChanged: () => void = () => {};
  let resets = 0,
    closes = 0;
  const bus: LinuxNotificationBus = {
    currentOwner: async () => OWNER,
    notify: async () => 7,
    onActionInvoked(callback) {
      action = callback;
      return () => {
        action = () => {};
      };
    },
    onClosed(callback) {
      closed = callback;
      return () => {
        closed = () => {};
      };
    },
    onOwnerChanged(callback) {
      ownerChanged = callback;
      return () => {
        ownerChanged = () => {};
      };
    },
    reset() {
      resets++;
    },
    close() {
      closes++;
    },
    ...overrides,
  };
  return {
    bus,
    action: (owner: string, id: number, key = "default") => action(owner, id, key),
    closed: (owner: string, id: number) => closed(owner, id),
    changeOwner: () => ownerChanged(),
    counts: () => ({ resets, closes }),
  };
}

it("sends fixed generic copy and routes only the exact live owner/default action once", async () => {
  let sent: Parameters<LinuxNotificationBus["notify"]>[1] | undefined;
  const backend = fake({
    notify: async (owner, input) => {
      expect(owner).toBe(OWNER);
      sent = input;
      return 7;
    },
  });
  const clicks: string[] = [];
  const transport = linuxNotificationTransport(backend.bus, (requestId, token) => {
    clicks.push(`${requestId}:${token}`);
  });
  expect(await transport.submit(frame)).toEqual({ state: "accepted" });
  expect(sent).toEqual({
    appName: "cashU",
    title: "cashU",
    body: "Nowy sygnał w cashU.",
    actions: ["default", "Otwórz cashU"],
  });
  expect(JSON.stringify(sent)).not.toContain(frame.intentToken);
  expect(JSON.stringify(sent)).not.toContain(frame.requestId);
  backend.action(":1.99", 7);
  backend.action(OWNER, 7, "other");
  backend.action(OWNER, 7);
  backend.action(OWNER, 7);
  expect(clicks).toEqual([`${frame.requestId}:${frame.intentToken}`]);
  transport.dispose();
  expect(backend.counts().closes).toBe(1);
});

it("classifies missing service, errors after invocation, and timeout conservatively", async () => {
  const absent = fake({ currentOwner: async () => null });
  const missing = linuxNotificationTransport(absent.bus, () => {});
  expect(await missing.submit(frame)).toEqual({ state: "rejected", reason: "unavailable" });
  missing.dispose();
  const error = fake({
    notify: async () => {
      throw new Error("lost reply");
    },
  });
  const uncertain = linuxNotificationTransport(error.bus, () => {});
  expect(await uncertain.submit(frame)).toEqual({ state: "unknown" });
  uncertain.dispose();
  const hanging = fake({ notify: async () => new Promise<number>(() => {}) });
  const timed = linuxNotificationTransport(hanging.bus, () => {}, 5);
  expect(await timed.submit(frame)).toEqual({ state: "unknown" });
  expect(hanging.counts().resets).toBe(1);
  expect(await timed.submit(frame)).toEqual({ state: "unknown" });
  expect(hanging.counts().resets).toBe(2);
  timed.dispose();
});

it("clears mappings across service restart, repeated IDs and an owner change during Notify", async () => {
  const backend = fake();
  const clicks: string[] = [];
  const transport = linuxNotificationTransport(backend.bus, (requestId) => {
    clicks.push(requestId);
  });
  expect(await transport.submit(frame)).toEqual({ state: "accepted" });
  backend.changeOwner();
  backend.action(OWNER, 7);
  expect(clicks).toEqual([]);
  let finish: (id: number) => void = () => {};
  let entered: () => void = () => {};
  const notifyEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  backend.bus.notify = () =>
    new Promise<number>((resolve) => {
      finish = resolve;
      entered();
    });
  const inFlight = transport.submit({
    ...frame,
    requestId: "15933990-ac89-4616-9427-2778b649c0aa",
  });
  await notifyEntered;
  backend.changeOwner();
  finish(7);
  expect(await inFlight).toEqual({ state: "accepted" });
  backend.action(OWNER, 7);
  expect(clicks).toEqual([]);
  backend.bus.notify = async () => 7;
  expect(await transport.submit(frame)).toEqual({ state: "accepted" });
  backend.action(OWNER, 7);
  expect(clicks).toEqual([frame.requestId]);
  transport.dispose();
});

it("expires click mappings", async () => {
  let time = 0;
  const backend = fake();
  const clicks: string[] = [];
  const transport = linuxNotificationTransport(
    backend.bus,
    (id) => clicks.push(id),
    100,
    () => time,
  );
  expect(await transport.submit(frame)).toEqual({ state: "accepted" });
  time = 8 * 24 * 60 * 60 * 1000;
  backend.action(OWNER, 7);
  expect(clicks).toEqual([]);
  transport.dispose();
});

it("drops closed notification IDs and treats a zero Notify reply as unknown", async () => {
  const backend = fake();
  const clicks: string[] = [];
  const transport = linuxNotificationTransport(backend.bus, (id) => clicks.push(id));
  expect(await transport.submit(frame)).toEqual({ state: "accepted" });
  backend.closed(OWNER, 7);
  backend.action(OWNER, 7);
  expect(clicks).toEqual([]);
  backend.bus.notify = async () => 0;
  expect(await transport.submit(frame)).toEqual({ state: "unknown" });
  backend.action(OWNER, 0);
  expect(clicks).toEqual([]);
  let finish: (id: number) => void = () => {};
  let entered: () => void = () => {};
  const notifyEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  backend.bus.notify = () =>
    new Promise<number>((resolve) => {
      finish = resolve;
      entered();
    });
  const inFlight = transport.submit(frame);
  await notifyEntered;
  backend.closed(OWNER, 9);
  finish(9);
  expect(await inFlight).toEqual({ state: "accepted" });
  backend.action(OWNER, 9);
  expect(clicks).toEqual([]);
  transport.dispose();
});
