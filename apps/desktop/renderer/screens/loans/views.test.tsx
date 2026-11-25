// @vitest-environment jsdom
// The loan drawers are portaled Modals, so they render into a DOM document. Every loan story is
// rendered through its form composition in stories.test.tsx; this file pins incognito.
import { setLanguageForTests } from "@cashu/i18n";
import { UiEnvProvider } from "@cashu/ui";
import { setIncognito } from "@cashu/ui-logic/core/incognito";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { InstallmentDrawerView } from "./InstallmentDrawerView.js";
import { LoanDrawerView } from "./LoanDrawerView.js";
import { LoansView } from "./LoansView.js";
import { loansStoryState, StoryFixture, storyState } from "./testing/storyState.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});
async function mount(node: ReactNode) {
  await act(async () => root?.unmount());
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return document.body;
}

it("shows names and forms but no amounts in incognito", async () => {
  setLanguageForTests("en");
  setIncognito(true);
  const state = loansStoryState();
  const html = renderToStaticMarkup(
    <UiEnvProvider locale="en-US" privacy={true}>
      <StoryFixture component={LoansView} state={state} />
    </UiEnvProvider>,
  );
  setIncognito(false);
  expect(html).toContain("Synthetic mortgage");
  expect(html).not.toContain("12,000");
  for (const [component, drawer] of [
    [LoanDrawerView, { kind: "loan" }],
    [InstallmentDrawerView, { kind: "payment" }],
  ] as const) {
    const open = await mount(
      <UiEnvProvider locale="en-US" privacy={false}>
        <StoryFixture component={component} state={{ ...storyState, drawer }} />
      </UiEnvProvider>,
    );
    expect(open.querySelector('[role="dialog"]')).not.toBeNull();
    const incognito = await mount(
      <UiEnvProvider locale="en-US" privacy={true}>
        <StoryFixture component={component} state={{ ...state, drawer }} />
      </UiEnvProvider>,
    );
    expect(incognito.querySelector('[role="dialog"]')).not.toBeNull();
  }
});
