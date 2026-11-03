// @vitest-environment jsdom

import { act, StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVirtualRows } from "./useVirtualRows.js";
import { createVirtualRows } from "./virtualRows.js";

class Observer {
  static all: Observer[] = [];
  readonly nodes = new Set<Element>();
  disconnected = false;
  constructor(readonly callback: ResizeObserverCallback) {
    Observer.all.push(this);
  }
  observe(node: Element) {
    this.nodes.add(node);
  }
  unobserve(node: Element) {
    this.nodes.delete(node);
  }
  disconnect() {
    this.disconnected = true;
    this.nodes.clear();
  }
}
beforeEach(() => {
  Observer.all = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", Observer);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
function viewport() {
  const node = document.createElement("div");
  Object.defineProperties(node, {
    clientHeight: { configurable: true, value: 200 },
    clientWidth: { value: 400 },
    scrollHeight: { value: 10000 },
  });
  node.scrollTo = vi.fn();
  document.body.append(node);
  return node;
}
it("caches immutable snapshots, follows scroll/resize, changes count/keys and releases observers", () => {
  const node = viewport(),
    store = createVirtualRows();
  const options = {
    count: 100,
    getScrollElement: () => node,
    estimateSize: () => 50,
    getItemKey: (index: number) => `row-${index}`,
    overscan: 1,
  };
  const end = store.mount();
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  store.update(options);
  const first = store.getSnapshot();
  expect(first.items.length).toBeGreaterThan(0);
  expect(first.items.length).toBeLessThan(20);
  expect(first.totalSize).toBe(5000);
  expect(Object.isFrozen(first.items[0])).toBe(true);
  store.update(options);
  expect(store.getSnapshot()).toBe(first);
  node.scrollTop = 500;
  node.dispatchEvent(new Event("scroll"));
  expect(store.getSnapshot().items.some((row) => row.index === 10)).toBe(true);
  Object.defineProperty(node, "clientHeight", { configurable: true, value: 400 });
  for (const observer of Observer.all)
    if (observer.nodes.has(node))
      observer.callback(
        [
          {
            target: node,
            borderBoxSize: [{ inlineSize: 400, blockSize: 400 }],
          } as unknown as ResizeObserverEntry,
        ],
        observer as unknown as ResizeObserver,
      );
  store.update({ ...options, count: 2, getItemKey: (index) => `new-${index}` });
  expect(store.getSnapshot().totalSize).toBe(100);
  expect(
    store
      .getSnapshot()
      .items.every((item) => String(item.key).startsWith("new-") && item.index < 2),
  ).toBe(true);
  const row = document.createElement("div");
  row.setAttribute("data-index", "0");
  node.append(row);
  store.measureElement(row);
  for (const observer of Observer.all)
    if (observer.nodes.has(row))
      observer.callback(
        [
          {
            target: row,
            borderBoxSize: [{ inlineSize: 400, blockSize: 80 }],
          } as unknown as ResizeObserverEntry,
        ],
        observer as unknown as ResizeObserver,
      );
  expect(store.getSnapshot().totalSize).toBe(130);
  unsubscribe();
  end();
  const before = listener.mock.calls.length;
  node.dispatchEvent(new Event("scroll"));
  expect(listener).toHaveBeenCalledTimes(before);
  expect(Observer.all.every((observer) => observer.nodes.size === 0)).toBe(true);
  node.remove();
});
function Harness({ count }: { count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const window = useVirtualRows({
    count,
    getScrollElement: () => ref.current,
    estimateSize: () => 50,
  });
  return (
    <div ref={ref}>
      <span data-testid="size">{window.totalSize}</span>
    </div>
  );
}
it("survives StrictMode mount cleanup and empty/count changes without exposing the instance", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <StrictMode>
        <Harness count={0} />
      </StrictMode>,
    ),
  );
  expect(container.querySelector("[data-testid=size]")?.textContent).toBe("0");
  await act(async () =>
    root.render(
      <StrictMode>
        <Harness count={20} />
      </StrictMode>,
    ),
  );
  expect(container.querySelector("[data-testid=size]")?.textContent).toBe("1000");
  await act(async () => root.unmount());
  container.remove();
  expect(Observer.all.every((observer) => observer.nodes.size === 0)).toBe(true);
});
