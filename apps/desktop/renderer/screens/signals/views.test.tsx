// @vitest-environment jsdom
// The Signals dialogs are portaled Modals, so the Views render into a DOM document.
import { setLanguageForTests } from "@cashu/i18n";
import { UiEnvProvider } from "@cashu/ui";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as alertHistoryStories from "./AlertHistoryView.stories.js";
import * as alertsStories from "./AlertsPageView.stories.js";
import * as decisionStories from "./DecisionDialogView.stories.js";
import { JournalPageView } from "./JournalPageView.js";
import * as journalStories from "./JournalPageView.stories.js";
import * as railStories from "./SignalsHomeRailView.stories.js";
import { SignalsListView } from "./SignalsListView.js";
import * as listStories from "./SignalsListView.stories.js";
import * as noticeStories from "./SignalsNoticeView.stories.js";
import { SignalsPageView } from "./SignalsView.js";
import * as pageStories from "./SignalsView.stories.js";
import { signalsStorySnapshot, storyFeedback, storyJournal, storyList } from "./storyState.js";
import * as watchlistStories from "./WatchlistPageView.stories.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLElement | null = null;
beforeEach(() => setLanguageForTests("en"));
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});
async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <UiEnvProvider locale="en-US" privacy={false}>
        {node}
      </UiEnvProvider>,
    ),
  );
  return document.body;
}

it("tells the owner a removed watch or alert was removed and restored, not saved", async () => {
  const page = (notice: "removed" | "restored") => (
    <SignalsPageView
      page="watchlist"
      available
      privacy={false}
      feedback={storyFeedback({ notice })}
      onUndoLast={() => {}}
    >
      {null}
    </SignalsPageView>
  );
  const body = await render(page("removed"));
  expect(body.querySelector('[role="status"]')?.textContent).toBe("Removed");
  await act(async () =>
    root?.render(
      <UiEnvProvider locale="en-US" privacy={false}>
        {page("restored")}
      </UiEnvProvider>,
    ),
  );
  expect(body.querySelector('[role="status"]')?.textContent).toBe("Restored");
});

it("shows a known refusal as owner copy instead of its raw code", async () => {
  const body = await render(
    <SignalsPageView
      page="alerts"
      available
      privacy={false}
      feedback={storyFeedback({ notice: "failed", refusal: "no_alert" })}
      onUndoLast={() => {}}
    >
      {null}
    </SignalsPageView>,
  );
  expect(body.querySelector('[role="alert"]')?.textContent).toBe("This alert no longer exists.");
});

it("names the journal kind filter for what it filters", async () => {
  const body = await render(<JournalPageView {...storyJournal(signalsStorySnapshot())} />);
  const selects = [...body.querySelectorAll("select")].map((row) => row.getAttribute("aria-label"));
  expect(selects).toEqual(["Entry type", "Instrument"]);
});

it("keeps the dialog's named regions and moves the cursor with j and k", async () => {
  const moves: number[] = [];
  const body = await render(
    <SignalsListView
      {...storyList(signalsStorySnapshot(), { onMove: (delta) => moves.push(delta) })}
    />,
  );
  const dialog = body.querySelector('[role="dialog"]');
  expect(dialog?.getAttribute("aria-label")).toBe("Signals");
  // Rows are virtualized (no layout in jsdom); the named scroll regions are what e2e scopes by.
  expect(body.querySelector('section[aria-label="Watched"]')).not.toBeNull();
  expect(body.querySelector('section[aria-label="Portfolio"]')).not.toBeNull();
  const panel = dialog as HTMLElement;
  await act(async () => {
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
  });
  expect(moves).toEqual([1, -1]);
});

it("renders every Signals story", async () => {
  const modules = [
    railStories,
    listStories,
    decisionStories,
    alertsStories,
    alertHistoryStories,
    watchlistStories,
    journalStories,
    noticeStories,
    pageStories,
  ];
  for (const module of modules) {
    for (const [name, story] of Object.entries(module)) {
      if (name === "default" || typeof story !== "object" || story === null) continue;
      const { render: draw } = story as { render: () => ReactNode };
      const body = await render(draw());
      expect(body.textContent?.length, name).toBeGreaterThan(0);
      await act(async () => root?.unmount());
      container?.remove();
      root = null;
    }
  }
});
