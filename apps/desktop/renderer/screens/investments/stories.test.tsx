import { setLanguageForTests } from "@cashu/i18n";
import { type ComponentType, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import * as asset from "./AssetDetailView.stories.js";
import * as imports from "./ImportStepsView.stories.js";
import * as drawers from "./PortfolioDrawersView.stories.js";
import * as portfolio from "./PortfolioView.stories.js";
import * as transactions from "./TransactionsView.stories.js";

type Decorator = (Story: ComponentType) => ReactElement;
type Story = { args?: Record<string, unknown>; decorators?: Decorator[] };
type Meta = Story & {
  component: ComponentType<Record<string, unknown>>;
  render?: (args: Record<string, unknown>) => ReactElement;
};
it.each(["en", "pl"] as const)(
  "renders all actual investment and strategy story phases in %s",
  (language) => {
    setLanguageForTests(language);
    for (const module of [asset, drawers, imports, portfolio, transactions]) {
      const meta = module.default as unknown as Meta;
      for (const [name, value] of Object.entries(module)) {
        if (name === "default") continue;
        const story = value as Story;
        const args = { ...meta.args, ...story.args };
        let element = meta.render ? meta.render(args) : createElement(meta.component, args);
        for (const decorate of [...(story.decorators ?? []), ...(meta.decorators ?? [])]) {
          const previous = element;
          element = decorate(() => previous);
        }
        expect(renderToStaticMarkup(element)).not.toContain("undefined");
      }
    }
  },
);
