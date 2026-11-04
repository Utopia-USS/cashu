// @vitest-environment jsdom
// The loan drawers are portaled Modals, so they render into a DOM document.
import { setLanguageForTests } from "@cashu/i18n";
import { UiEnvProvider } from "@cashu/ui";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { InstallmentDrawerView } from "./InstallmentDrawerView.js";
import { LoanDrawerView } from "./LoanDrawerView.js";
import { LoansStartView } from "./LoansStartView.js";
import { LoansView } from "./LoansView.js";
import { StoryFixture, storyState } from "./storyState.js";

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
    'data-testid="native-loans"',
  );
  const loan = await mount(
    <StoryFixture component={LoanDrawerView} state={{ ...storyState, drawer: "loan" }} />,
  );
  expect(loan.querySelector('[role="dialog"] input[type="date"]')).not.toBeNull();
  const payment = await mount(
    <StoryFixture component={InstallmentDrawerView} state={{ ...storyState, drawer: "payment" }} />,
  );
  expect(payment.querySelector('[role="dialog"] input[autocomplete="off"]')).not.toBeNull();
  expect(
    renderToStaticMarkup(<StoryFixture component={LoansStartView} state={storyState} />),
  ).toContain("Synthetic setup step");
});
it("suppresses identities, amounts and forms in privacy mode", async () => {
  setLanguageForTests("en");
  const state = { ...storyState, privacy: true };
  const html = renderToStaticMarkup(
    <UiEnvProvider locale="en-US" privacy={true}>
      <StoryFixture component={LoansView} state={state} />
    </UiEnvProvider>,
  );
  expect(html).not.toContain("Synthetic mortgage");
  expect(html).not.toContain("12,000");
  for (const [component, drawer] of [
    [LoanDrawerView, "loan"],
    [InstallmentDrawerView, "payment"],
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

it("exposes selected loan/range and actionable keyboard controls through semantic tokens", () => {
  const state = { ...storyState, selected: storyState.rows[0]?.id ?? null, range: 365 };
  const markup = renderToStaticMarkup(<StoryFixture component={LoansView} state={state} />);
  expect(markup).toContain("focus-visible:outline-accent");
  expect(markup).toContain("disabled:opacity-50");
  expect(markup).toContain("aria-pressed:bg-accent-muted");
  expect(markup).toMatch(/<tr[^>]*bg-accent-muted/);
});
