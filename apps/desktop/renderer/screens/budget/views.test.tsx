import { setLanguageForTests } from "@cashu/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import * as stories from "./BudgetView.stories.js";

it.each(["en", "pl"] as const)("renders native budget story phases in %s", (language) => {
  setLanguageForTests(language);
  for (const [name, story] of Object.entries(stories)) {
    if (name === "default") continue;
    if (!("render" in story)) throw new Error("missing synthetic story renderer");
    const Story = story.render;
    const markup = renderToStaticMarkup(<Story />);
    expect(markup).toContain("<main");
    if (name === "Privacy") expect(markup).not.toMatch(/123[.,]45/);
  }
});
