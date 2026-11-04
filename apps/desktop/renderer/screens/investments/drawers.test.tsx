// @vitest-environment jsdom
// The owner drawers are a portaled Modal, so their stories render into a DOM document.
import { setLanguageForTests } from "@cashu/i18n";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { I } from "./Portfolio.strings.js";
import meta, * as stories from "./PortfolioDrawersView.stories.js";
import type { PortfolioScreenState } from "./usePortfolioScreen.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const titles: Record<string, () => string> = {
  Transaction: () => I.addTransaction,
  Account: () => I.addAccount,
  Thesis: () => I.thesis,
  Note: () => I.noteTitle,
  Classification: () => I.classify,
  ImportUnavailable: () => I.import,
  Refusal: () => I.addTransaction,
  Pending: () => I.addTransaction,
};

it.each(["en", "pl"] as const)(
  "renders every owner drawer story as a named dialog in %s",
  async (language) => {
    setLanguageForTests(language);
    for (const [name, value] of Object.entries(stories)) {
      if (name === "default") continue;
      const story = value as { args?: { state?: Partial<PortfolioScreenState> } };
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(async () =>
        root.render(
          createElement(meta.render, {
            state: { ...(meta.args.state as Partial<PortfolioScreenState>), ...story.args?.state },
          }),
        ),
      );
      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute("aria-label")).toBe(titles[name]?.());
      expect(document.body.innerHTML).not.toContain("undefined");
      const described = dialog?.getAttribute("aria-describedby")?.split(" ") ?? [];
      expect(described.length).toBe(name === "Refusal" ? 2 : 1);
      if (name === "Refusal")
        expect(document.getElementById(described[1] ?? "")?.textContent).toBe("Synthetic refusal");
      await act(async () => root.unmount());
      document.body.replaceChildren();
    }
  },
);
