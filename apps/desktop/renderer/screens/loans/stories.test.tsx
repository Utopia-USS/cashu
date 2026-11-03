import { setLanguageForTests } from "@cashu/i18n";
import { type ComponentType, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import * as assets from "../assets/AssetsStartView.stories.js";
import * as assetDrawer from "../overview/AssetDrawerView.stories.js";
import * as payment from "./InstallmentDrawerView.stories.js";
import * as loan from "./LoanDrawerView.stories.js";
import * as start from "./LoansStartView.stories.js";
import * as loans from "./LoansView.stories.js";

type Decorator = (Story: ComponentType) => ReactElement;
type Story = { args?: Record<string, unknown>; decorators?: Decorator[] };
type Meta = Story & {
  component: ComponentType<Record<string, unknown>>;
  render?: (args: Record<string, unknown>) => ReactElement;
};
it("renders every synthetic loan and asset first-step story through its actual form composition", () => {
  setLanguageForTests("en");
  for (const module of [assets, assetDrawer, payment, loan, start, loans]) {
    const meta = module.default as unknown as Meta;
    for (const [name, value] of Object.entries(module)) {
      if (name === "default") continue;
      const story = value as Story;
      const args = { ...meta.args, ...story.args };
      let element = meta.render ? meta.render(args) : createElement(meta.component, args);
      for (const decorate of [...(story.decorators ?? []), ...(meta.decorators ?? [])]) {
        const prior = element;
        element = decorate(() => prior);
      }
      expect(renderToStaticMarkup(element)).not.toContain("undefined");
    }
  }
});
