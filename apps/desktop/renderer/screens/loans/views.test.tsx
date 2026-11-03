import { setLanguageForTests } from "@cashu/i18n";
import { UiEnvProvider } from "@cashu/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { InstallmentDrawerView } from "./InstallmentDrawerView.js";
import { LoanDrawerView } from "./LoanDrawerView.js";
import { LoansStartView } from "./LoansStartView.js";
import { LoansView } from "./LoansView.js";
import { StoryFixture, storyState } from "./storyState.js";

it.each(["pl", "en"] as const)("renders loan forms and exact values in %s", (language) => {
  setLanguageForTests(language);
  expect(renderToStaticMarkup(<StoryFixture component={LoansView} state={storyState} />)).toContain(
    'data-testid="native-loans"',
  );
  expect(
    renderToStaticMarkup(
      <StoryFixture component={LoanDrawerView} state={{ ...storyState, drawer: "loan" }} />,
    ),
  ).toContain('type="date"');
  expect(
    renderToStaticMarkup(
      <StoryFixture
        component={InstallmentDrawerView}
        state={{ ...storyState, drawer: "payment" }}
      />,
    ),
  ).toContain('autoComplete="off"');
  expect(
    renderToStaticMarkup(<StoryFixture component={LoansStartView} state={storyState} />),
  ).toContain("Synthetic setup step");
});
it("suppresses identities, amounts and forms in privacy mode", () => {
  setLanguageForTests("en");
  const state = { ...storyState, privacy: true };
  const html = renderToStaticMarkup(
    <UiEnvProvider locale="en-US" privacy={true}>
      <StoryFixture component={LoansView} state={state} />
      <StoryFixture component={LoanDrawerView} state={state} />
      <StoryFixture component={InstallmentDrawerView} state={state} />
    </UiEnvProvider>,
  );
  expect(html).not.toContain("Synthetic mortgage");
  expect(html).not.toContain("12,000");
  expect(html).not.toContain("<dialog");
});

it("exposes selected loan/range and actionable keyboard controls through semantic tokens", () => {
  const state = { ...storyState, selected: storyState.rows[0]?.id ?? null, range: 365 };
  const markup = renderToStaticMarkup(<StoryFixture component={LoansView} state={state} />);
  expect(markup).toContain("focus-visible:outline-accent");
  expect(markup).toContain("disabled:opacity-50");
  expect(markup).toContain("aria-pressed:bg-accent-muted");
  expect(markup).toMatch(/<tr[^>]*bg-accent-muted/);
});
