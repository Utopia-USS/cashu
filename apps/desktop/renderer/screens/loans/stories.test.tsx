// @vitest-environment jsdom
// The drawers are portaled Modals, so every story renders into a DOM document.
import { setLanguageForTests } from "@cashu/i18n";
import { act, type ComponentType, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("renders every synthetic loan and asset first-step story through its actual form composition", async () => {
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
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => root.render(element));
      expect(document.body.innerHTML).not.toContain("undefined");
      await act(async () => root.unmount());
      document.body.replaceChildren();
    }
  }
});
