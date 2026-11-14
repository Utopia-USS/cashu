import { D, Money as MoneyValue } from "@cashu/domain";
import { bananaScale } from "@cashu/domain/core";
import { setLanguageForTests } from "@cashu/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storyCases } from "../charts/testing/csf.js";
import { UiEnvProvider } from "../environment/UiEnv.js";
import { Amount } from "./Amount.js";
import * as amountStories from "./Amount.stories.js";
import { DateText } from "./DateText.js";
import * as dateStories from "./DateText.stories.js";
import { Delta } from "./Delta.js";
import * as deltaStories from "./Delta.stories.js";
import { Money } from "./Money.js";
import * as moneyStories from "./Money.stories.js";
import { Percent } from "./Percent.js";
import * as percentStories from "./Percent.stories.js";

beforeEach(() => setLanguageForTests("en"));
afterEach(cleanup);
const modules = { amountStories, dateStories, deltaStories, moneyStories, percentStories };
describe.each(Object.entries(modules))("%s (DOM)", (_name, stories) => {
  it.each(storyCases(stories))("%s renders with tabular figures", (_name, element) => {
    const { container } = render(element);
    expect(container.querySelector("span.tabular-nums")).not.toBeNull();
  });
});
it("masks money, amount and monetary delta in text, labels and tone", () => {
  const { container } = render(
    <UiEnvProvider privacy locale="en-US">
      <Money value={new MoneyValue(D("-123.45"), "USD")} tone="negative" />
      <Amount value={D("-123.45")} tone="negative" />
      <Delta kind="money" value={new MoneyValue(D("-123.45"), "USD")} />
    </UiEnvProvider>,
  );
  expect(screen.getAllByText("Amount hidden")).toHaveLength(3);
  expect(container.textContent).toBe("•••Amount hidden".repeat(3));
  expect(container.innerHTML).not.toMatch(/123|negative|positive|USD/);
});
it("shows money with a currency on the banana scale and still masks a bare amount", () => {
  const bananas = bananaScale("salary", D("8000"), { USD: 4 });
  const { container } = render(
    <UiEnvProvider privacy locale="en-US" bananas={bananas}>
      <Money value={new MoneyValue(D("-500"), "USD")} tone="negative" />
      <Amount value={D("-123.45")} />
      <Money value={new MoneyValue(D("10"), "CHF")} />
    </UiEnvProvider>,
  );
  expect(screen.getByText("-🍌 250").classList.contains("text-negative")).toBe(true);
  expect(screen.getAllByText("Amount hidden")).toHaveLength(2);
  expect(container.innerHTML).not.toMatch(/500|123|CHF|USD/);
});
it("keeps shares, percentage changes and dates visible in privacy mode", () => {
  render(
    <UiEnvProvider privacy locale="en-US">
      <Percent value={D("0.125")} />
      <Delta kind="percent" value={D("-0.125")} />
      <DateText value="2026-10-01" />
    </UiEnvProvider>,
  );
  expect(screen.getByText("12.5%")).toBeTruthy();
  expect(screen.getByText("-12.5%").classList.contains("text-negative")).toBe(true);
  expect(screen.getByText("Oct 1, 2026")).toBeTruthy();
});
it("updates locale and privacy without replacing raw values", () => {
  const value = new MoneyValue(D("9007199254740993.125"), "USD");
  const node = (locale: string, privacy: boolean) => (
    <UiEnvProvider privacy={privacy} locale={locale}>
      <Money value={value} />
    </UiEnvProvider>
  );
  const { rerender } = render(node("en-US", false));
  expect(screen.getByText("$9,007,199,254,740,993.13")).toBeTruthy();
  rerender(node("pl-PL", true));
  expect(screen.getByText("Kwota ukryta")).toBeTruthy();
  rerender(node("pl-PL", false));
  expect(screen.getByText(/9.007.199.254.740.993,13/)).toBeTruthy();
});
it("announces missing data and treats rounded zero as neutral", () => {
  render(
    <>
      <Money value={null} />
      <Delta kind="amount" value={D("-0.001")} />
    </>,
  );
  expect(screen.getByText("Not available").classList.contains("sr-only")).toBe(true);
  expect(screen.getByText("0.00").classList.contains("text-fg")).toBe(true);
});
it("nested privacy provider inherits the outer locale", () => {
  render(
    <UiEnvProvider privacy={false} locale="pl-PL">
      <UiEnvProvider privacy>
        <Amount value={D("12")} />
      </UiEnvProvider>
    </UiEnvProvider>,
  );
  expect(screen.getByText("Kwota ukryta")).toBeTruthy();
});
