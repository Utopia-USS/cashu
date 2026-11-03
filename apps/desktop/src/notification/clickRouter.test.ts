import { expect, it } from "vitest";
import { createNotificationClickRouter } from "./clickRouter.js";

const pair = (n: number) => ({
  requestId: `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`,
  intentToken: String(n).padStart(64, "a"),
});
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

it("keeps the newest host-valid click when a newer locator is stale", async () => {
  const published: (string | null)[] = [];
  const seen: number[] = [];
  const router = createNotificationClickRouter<string>({
    resolve: async (value) => {
      const n = Number(value.requestId.slice(-12));
      seen.push(n);
      return n === 3 ? null : `target-${n}`;
    },
    publish: (target) => published.push(target),
    focus: () => {},
  });
  router.enqueue(pair(1));
  router.enqueue(pair(2));
  router.enqueue(pair(3));
  router.setReady();
  await settle();
  expect(seen).toEqual([3, 2, 1]);
  expect(published).toEqual(["target-2"]);
});

it("holds one typed result across renderer navigation and resumes without a token", async () => {
  const published: (string | null)[] = [];
  const events: string[] = [];
  const router = createNotificationClickRouter<string>({
    resolve: async () => "verified-target",
    publish: (target) => {
      published.push(target);
      events.push("target");
    },
    start: () => events.push("pending"),
    focus: () => {},
  });
  router.enqueue(pair(1));
  await settle();
  expect(published).toEqual([]);
  router.setReady();
  expect(published).toEqual(["verified-target"]);
  expect(events).toEqual(["pending", "target"]);
  router.setUnready();
  router.enqueue(pair(2));
  await settle();
  expect(published).toEqual(["verified-target"]);
  router.setReady();
  expect(published).toEqual(["verified-target", "verified-target"]);
  expect(events).toEqual(["pending", "target", "pending", "target"]);
});

it("continues after an unavailable host result and never publishes after disposal", async () => {
  const published: (string | null)[] = [];
  const router = createNotificationClickRouter<string>({
    resolve: async (value) => {
      if (value.requestId.endsWith("000000000002")) throw new Error("host reconnect");
      return "older-valid";
    },
    publish: (target) => published.push(target),
    focus: () => {},
  });
  router.enqueue(pair(1));
  router.enqueue(pair(2));
  router.setReady();
  await settle();
  expect(published).toEqual(["older-valid"]);
  router.enqueue(pair(3));
  router.dispose();
  await settle();
  expect(published).toEqual(["older-valid"]);
});

it("replays pending before a result when the page changes during host resolution", async () => {
  const events: string[] = [];
  let complete: (value: string) => void = () => {};
  const router = createNotificationClickRouter<string>({
    resolve: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    start: () => events.push("pending"),
    publish: () => events.push("target"),
    focus: () => {},
  });
  router.setReady();
  router.enqueue(pair(1));
  router.setUnready();
  await settle();
  complete("verified");
  await settle();
  router.setReady();
  expect(events).toEqual(["pending", "pending", "target"]);
});
