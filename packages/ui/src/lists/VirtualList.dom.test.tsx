import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VirtualList } from "./VirtualList.js";

class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", Observer);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.index === undefined ? 400 : 40;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.index === undefined ? 400 : 40;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps a thousand-row source bounded to the visible window", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = this.dataset.index === undefined ? 400 : 40;
    return {
      width: 500,
      height,
      top: 0,
      bottom: height,
      left: 0,
      right: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  });
  const items = Array.from({ length: 1000 }, (_, id) => ({ id: String(id) }));
  const { container } = render(
    <VirtualList
      items={items}
      getKey={(row) => row.id}
      renderItem={(row) => <span>{row.id}</span>}
      label="Synthetic rows"
      estimateSize={40}
    />,
  );
  expect(container.querySelector('[aria-label="Synthetic rows"]')).not.toBeNull();
  const rendered = container.querySelectorAll("[data-index]").length;
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(50);
});
