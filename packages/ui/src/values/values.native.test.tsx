import { D, Money as MoneyValue } from "@cashu/domain";
import { setLanguageForTests } from "@cashu/i18n";
import { render, screen } from "@testing-library/react-native";
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
const modules = { amountStories, dateStories, deltaStories, moneyStories, percentStories };
describe.each(Object.entries(modules))("%s (native)", (_name, stories) => {
  it.each(storyCases(stories))("%s renders", async (_name, element) => {
    await render(element);
    expect(screen.root).toBeOnTheScreen();
  });
});
it("hides amount text, accessible labels and sign tone together", async () => {
  await render(
    <UiEnvProvider privacy locale="en-US">
      <Money value={new MoneyValue(D("-123.45"), "USD")} tone="negative" />
      <Amount value={D("123.45")} />
      <Delta kind="amount" value={D("-123.45")} />
    </UiEnvProvider>,
  );
  const values = screen.getAllByLabelText("Amount hidden");
  expect(values).toHaveLength(3);
  for (const value of values) {
    expect(value.props.children).toBe("•••");
    expect(value.props.className).not.toMatch(/positive|negative/);
    expect(value.props.className).toContain("tabular-nums");
    expect(value.props.allowFontScaling).not.toBe(false);
  }
  expect(JSON.stringify(screen.toJSON())).not.toMatch(/123|USD/);
});
it("keeps percentages and dates visible", async () => {
  await render(
    <UiEnvProvider privacy locale="en-US">
      <Percent value={D("0.125")} />
      <Delta kind="percent" value={D("0.125")} />
      <DateText value="2026-10-01" />
    </UiEnvProvider>,
  );
  expect(screen.getByText("12.5%")).toBeOnTheScreen();
  expect(screen.getByText("+12.5%")).toBeOnTheScreen();
  expect(screen.getByText("Oct 1, 2026")).toBeOnTheScreen();
});
it("updates locale and privacy with the same exact value", async () => {
  const value = new MoneyValue(D("9007199254740993.12"), "USD");
  const node = (locale: string, privacy: boolean) => (
    <UiEnvProvider locale={locale} privacy={privacy}>
      <Money value={value} />
    </UiEnvProvider>
  );
  const view = await render(node("en-US", false));
  expect(screen.getByText("$9,007,199,254,740,993.12")).toBeOnTheScreen();
  await view.rerender(node("pl-PL", true));
  expect(screen.getByLabelText("Kwota ukryta")).toBeOnTheScreen();
  await view.rerender(node("pl-PL", false));
  expect(screen.getByText(/9.007.199.254.740.993,12/)).toBeOnTheScreen();
});
