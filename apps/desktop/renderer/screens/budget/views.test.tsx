// @vitest-environment jsdom
// The budget drawers are portaled Modals, so the stories render into a DOM document.
import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { B } from "./Budget.strings.js";
import * as stories from "./BudgetView.stories.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const drawers: Record<string, () => string> = {
  Categories: () => B.uncategorized,
  Cushion: () => B.cushion,
  ImportUnavailable: () => B.import,
};

it.each(["en", "pl"] as const)("renders native budget story phases in %s", async (language) => {
  setLanguageForTests(language);
  for (const [name, story] of Object.entries(stories)) {
    if (name === "default") continue;
    if (!("render" in story)) throw new Error("missing synthetic story renderer");
    const Story = story.render;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Story />));
    expect(container.querySelector("main")).not.toBeNull();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toBe(drawers[name]?.());
    if (name === "Privacy") expect(document.body.innerHTML).not.toMatch(/123[.,]45/);
    await act(async () => root.unmount());
    document.body.replaceChildren();
  }
});
