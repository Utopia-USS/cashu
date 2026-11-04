// @vitest-environment jsdom
import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HomeRailView, type HomeRailViewProps } from "./HomeRailView.js";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLanguageForTests("en");
});
afterEach(() => vi.unstubAllGlobals());

it("shows the review decision box only when due and routes the rail actions", async () => {
  const onReview = vi.fn();
  const onSubject = vi.fn();
  const onAll = vi.fn();
  const onNew = vi.fn();
  const props: HomeRailViewProps = {
    privacy: false,
    signals: {
      available: true,
      navigationAvailable: true,
      fresh: 1,
      left: 0,
      unchanged: 0,
      total: 1,
      reviewDue: true,
      nextReviewDay: null,
      rows: [
        {
          id: "synthetic",
          tile: "ACM",
          title: "Synthetic risk",
          text: "A short reason.",
          group: "risk",
          onOpen: onSubject,
        },
      ],
      review: { name: "Weekly review", items: 1, counts: { risk: 1 }, onOpen: onReview },
      onAll,
    },
    alerts: { available: true, active: 0, rows: [], onAll, onNew },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HomeRailView {...props} />));
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find((node) =>
        node.textContent?.includes(label),
      );
      await act(async () => button?.click());
    };
    expect(container.textContent).toContain("Weekly review");
    await click("Synthetic risk");
    await click("Open the review");
    await click("+ New");
    expect(onSubject).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledTimes(1);
    await act(async () =>
      root.render(<HomeRailView {...props} signals={{ ...props.signals, reviewDue: false }} />),
    );
    expect(container.textContent).not.toContain("Open the review");
    await act(async () =>
      root.render(
        <HomeRailView
          {...props}
          signals={{
            ...props.signals,
            available: false,
            navigationAvailable: true,
            total: 0,
            rows: [],
            review: null,
          }}
        />,
      ),
    );
    const all = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("All (0)"),
    );
    expect(all?.disabled).toBe(false);
    await act(async () => all?.click());
    expect(onAll).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
