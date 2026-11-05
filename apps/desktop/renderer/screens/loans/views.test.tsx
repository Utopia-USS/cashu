// @vitest-environment jsdom
// The loan drawers are portaled Modals, so they render into a DOM document.
import { setLanguageForTests } from "@cashu/i18n";
import { UiEnvProvider } from "@cashu/ui";
import { setIncognito } from "@cashu/ui-logic/core/incognito";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { InstallmentDrawerView } from "./InstallmentDrawerView.js";
import { LoanDrawerView } from "./LoanDrawerView.js";
import { LoansStartView } from "./LoansStartView.js";
import { LoansView } from "./LoansView.js";
import { loansStoryState, StoryFixture, storyState } from "./storyState.js";

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

it.each(["pl", "en"] as const)("renders loan forms and exact values in %s", async (language) => {
  setLanguageForTests(language);
  expect(renderToStaticMarkup(<StoryFixture component={LoansView} state={storyState} />)).toContain(
    "Synthetic mortgage",
  );
  const loan = await mount(
    <StoryFixture component={LoanDrawerView} state={{ ...storyState, drawer: { kind: "loan" } }} />,
  );
  expect(loan.querySelector('[role="dialog"] input[type="date"]')).not.toBeNull();
  const payment = await mount(
    <StoryFixture
      component={InstallmentDrawerView}
      state={{ ...storyState, drawer: { kind: "payment" } }}
    />,
  );
  expect(payment.querySelector('[role="dialog"] input[autocomplete="off"]')).not.toBeNull();
  expect(
    renderToStaticMarkup(<StoryFixture component={LoansStartView} state={storyState} />),
  ).toContain("Synthetic mortgage");
});
it("suppresses identities, amounts and forms in privacy mode", async () => {
  setLanguageForTests("en");
  setIncognito(true);
  const state = loansStoryState(true);
  const html = renderToStaticMarkup(
    <UiEnvProvider locale="en-US" privacy={true}>
      <StoryFixture component={LoansView} state={state} />
    </UiEnvProvider>,
  );
  setIncognito(false);
  expect(html).not.toContain("Synthetic mortgage");
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
    const hidden = await mount(
      <UiEnvProvider locale="en-US" privacy={true}>
        <StoryFixture component={component} state={{ ...state, drawer }} />
      </UiEnvProvider>,
    );
    expect(hidden.querySelector('[role="dialog"]')).toBeNull();
  }
});

it("marks the selected loan row and its name button", () => {
  const state = { ...storyState, selected: 0, range: 365 };
  const markup = renderToStaticMarkup(<StoryFixture component={LoansView} state={state} />);
  expect(markup).toContain('aria-pressed="true"');
  expect(markup).toMatch(/<tr[^>]*bg-chip/);
});
