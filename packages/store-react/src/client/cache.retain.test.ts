// Kept values (`retainMs`): a page opened again renders its last value at once while the live query
// reopens behind it; errors are never kept, privacy changes and the cap drop kept values.
import { defineQuery } from "@cashu/store/query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryCache } from "./cache.js";
import type { Adapter, Sink } from "./types.js";

const TARGET = { kind: "vault" as const, vault: "a".repeat(32) };
const count = defineQuery<{ n: number }, number>({ id: "test.count", run: () => 0 });

function fakeAdapter() {
  const open = new Map<number, Sink>();
  let opened = 0;
  const adapter: Adapter = {
    vaults: [TARGET.vault],
    open(_target, _query, args, sink) {
      const id = opened++;
      open.set(id, sink);
      queueMicrotask(() => sink.value((args as { n: number }).n * 10));
      return () => open.delete(id);
    },
    run: () => Promise.reject(new Error("no commands")),
  };
  return { adapter, open, opened: () => opened };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("stops the live query after the linger but keeps the value for the next reader", async () => {
  const { adapter, open, opened } = fakeAdapter();
  const client = new QueryCache(adapter, { async: true, lingerMs: 100, retainMs: 1_000 });
  const first = client.entry(TARGET, count, { n: 1 });
  const off = first.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(first.getSnapshot()).toEqual({ status: "value", value: 10 });
  off();
  await vi.advanceTimersByTimeAsync(150);
  expect(open.size).toBe(0);
  expect(client.size).toBe(0);

  const again = client.entry(TARGET, count, { n: 1 });
  expect(again).toBe(first);
  expect(again.getSnapshot()).toEqual({ status: "value", value: 10 });
  expect((again.ready as { status?: string }).status).toBe("fulfilled");
  expect(open.size).toBe(1);
  expect(opened()).toBe(2);
  client.dispose();
});

it("releases a kept value after retainMs", async () => {
  const { adapter } = fakeAdapter();
  const client = new QueryCache(adapter, { async: true, lingerMs: 100, retainMs: 1_000 });
  const first = client.entry(TARGET, count, { n: 1 });
  first.subscribe(() => {})();
  await vi.advanceTimersByTimeAsync(100 + 1_000 + 10);
  const fresh = client.entry(TARGET, count, { n: 1 });
  expect(fresh).not.toBe(first);
  expect(fresh.getSnapshot().status).toBe("pending");
  client.dispose();
});

it("never keeps an error", async () => {
  const adapter: Adapter = {
    vaults: [TARGET.vault],
    open(_target, _query, _args, sink) {
      queueMicrotask(() => sink.error(new Error("synthetic failure")));
      return () => {};
    },
    run: () => Promise.reject(new Error("no commands")),
  };
  const client = new QueryCache(adapter, { async: true, lingerMs: 100, retainMs: 1_000 });
  const first = client.entry(TARGET, count, { n: 1 });
  first.subscribe(() => {})();
  await vi.advanceTimersByTimeAsync(150);
  expect(client.entry(TARGET, count, { n: 1 })).not.toBe(first);
  client.dispose();
});

it("drops kept values on a privacy change and beyond maxRetained", async () => {
  const { adapter } = fakeAdapter();
  const client = new QueryCache(adapter, {
    async: true,
    lingerMs: 100,
    retainMs: 10_000,
    maxRetained: 1,
  });
  const one = client.entry(TARGET, count, { n: 1 });
  one.subscribe(() => {})();
  await vi.advanceTimersByTimeAsync(150);
  const two = client.entry(TARGET, count, { n: 2 });
  two.subscribe(() => {})();
  await vi.advanceTimersByTimeAsync(150);
  expect(client.entry(TARGET, count, { n: 1 })).not.toBe(one);

  const three = client.entry(TARGET, count, { n: 3 });
  three.subscribe(() => {})();
  await vi.advanceTimersByTimeAsync(150);
  client.resetSnapshots();
  expect(client.entry(TARGET, count, { n: 3 })).not.toBe(three);
  client.dispose();
});
