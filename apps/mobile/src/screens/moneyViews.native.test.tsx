import { UiEnvProvider } from "@cashu/ui";
import { render, screen } from "@testing-library/react-native";
import type { ComponentType } from "react";
import cashflowMeta, {
  Empty as EmptyCashflow,
  Monthly,
  OneCurrency,
} from "./cashflow/CashflowView.stories";
import moneyMeta, {
  Empty as EmptyMoney,
  MultipleCurrencies,
  Negative,
} from "./money/MoneyView.stories";

jest.mock("@expo/ui", () => require("./testing/expoUiMock"));

const cases: [string, ComponentType<never>, object][] = [
  ["money multiple currencies", moneyMeta.component, MultipleCurrencies.args],
  ["money negative", moneyMeta.component, Negative.args],
  ["money empty", moneyMeta.component, EmptyMoney.args],
  ["cashflow monthly", cashflowMeta.component, Monthly.args],
  ["cashflow one currency", cashflowMeta.component, OneCurrency.args],
  ["cashflow empty", cashflowMeta.component, EmptyCashflow.args],
];

it.each(cases)("renders %s story through the native View", async (_name, Component, args) => {
  const View = Component as ComponentType<object>;
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <View {...args} />
    </UiEnvProvider>,
  );
  expect(screen.root).toBeOnTheScreen();
});

it("hides exact net worth text and chart summary in privacy mode", async () => {
  const View = moneyMeta.component;
  await render(
    <UiEnvProvider locale="en-US" privacy>
      <View {...MultipleCurrencies.args} />
    </UiEnvProvider>,
  );
  const rendered = JSON.stringify(screen.toJSON());
  expect(rendered).not.toContain("12345.67");
  expect(rendered).not.toContain("12,345.67");
  expect(screen.getAllByLabelText("Amount hidden").length).toBeGreaterThan(0);
});
