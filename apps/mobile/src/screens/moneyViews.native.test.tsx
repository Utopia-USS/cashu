import { UiEnvProvider } from "@cashu/ui/native";
import { render, screen } from "@testing-library/react-native";
import type { ComponentType } from "react";
import loanMeta, {
  Gone,
  Incognito as LoanIncognito,
  Mortgage,
  NoPayingAccount,
  PaidOff,
} from "./loan/LoanView.stories";
import netWorthMeta, {
  Empty as EmptyNetWorth,
  EmptyShown,
  Incognito as NetWorthIncognito,
  NoRateYet,
  Owner,
  Partner,
} from "./networth/NetWorthView.stories";
import spendingMeta, {
  ClosedMonth,
  CurrentMonth,
  Empty as EmptySpending,
  ExactLargeValue,
  ManyCategories,
  OneCurrency,
  Quarter,
} from "./spending/SpendingView.stories";

jest.mock("@expo/ui", () => require("./testing/expoUiMock").default);

const cases: [string, ComponentType<never>, object][] = [
  ["net worth owner", netWorthMeta.component, Owner.args],
  ["net worth partner", netWorthMeta.component, Partner.args],
  ["net worth no rate yet", netWorthMeta.component, NoRateYet.args],
  ["net worth empty accounts shown", netWorthMeta.component, EmptyShown.args],
  ["net worth empty", netWorthMeta.component, EmptyNetWorth.args],
  ["loan mortgage", loanMeta.component, Mortgage.args],
  ["loan no paying account", loanMeta.component, NoPayingAccount.args],
  ["loan paid off", loanMeta.component, PaidOff.args],
  ["loan gone", loanMeta.component, Gone.args],
  ["spending current month", spendingMeta.component, CurrentMonth.args],
  ["spending one currency", spendingMeta.component, OneCurrency.args],
  ["spending closed month", spendingMeta.component, ClosedMonth.args],
  ["spending quarter", spendingMeta.component, Quarter.args],
  ["spending large value", spendingMeta.component, ExactLargeValue.args],
  ["spending many categories", spendingMeta.component, ManyCategories.args],
  ["spending empty", spendingMeta.component, EmptySpending.args],
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

it("labels the converted net worth with the NBP table date and the other currency beside it", async () => {
  const View = netWorthMeta.component;
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <View {...Owner.args} />
    </UiEnvProvider>,
  );
  expect(screen.getByText("Net worth, converted to PLN")).toBeOnTheScreen();
  expect(screen.getByText("converted at the NBP mid rate of Tue, Nov 10")).toBeOnTheScreen();
  expect(screen.getByText("incl.")).toBeOnTheScreen();
});

it("hides the amounts and the converted parts in privacy mode", async () => {
  const View = netWorthMeta.component;
  await render(
    <UiEnvProvider locale="en-US" privacy>
      <View {...Owner.args} />
    </UiEnvProvider>,
  );
  const rendered = JSON.stringify(screen.toJSON());
  expect(rendered).not.toContain("97,374");
  expect(rendered).not.toContain("1,240.00");
  // Without a banana scale the figure is dots, so the label does not promise bananas.
  expect(screen.getByText("Net worth, converted to PLN")).toBeOnTheScreen();
  expect(screen.queryByText("incl.")).toBeNull();
  expect(screen.getAllByLabelText("Amount hidden").length).toBeGreaterThan(0);
});

it("says the net worth is in bananas only on the banana scale", async () => {
  const View = netWorthMeta.component;
  await render(
    <UiEnvProvider
      locale="en-US"
      privacy
      bananas={{ anchor: "salary", perPln: 0.08, plnRates: { EUR: 4.3 } }}
    >
      <View {...Owner.args} />
    </UiEnvProvider>,
  );
  expect(screen.getByText("Net worth, in bananas")).toBeOnTheScreen();
  expect(JSON.stringify(screen.toJSON())).not.toContain("97,374");
});

it("leads with Accounts for the household profile", async () => {
  const View = netWorthMeta.component;
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <View {...Partner.args} />
    </UiEnvProvider>,
  );
  const rendered = JSON.stringify(screen.toJSON());
  expect(rendered.indexOf("Accounts")).toBeLessThan(rendered.indexOf("12 months"));
});

it.each([
  ["net worth", netWorthMeta.component, NetWorthIncognito],
  ["loan", loanMeta.component, LoanIncognito],
] as const)("renders the %s incognito story without amounts", async (_name, Component, story) => {
  const View = Component as ComponentType<object>;
  const [decorate] = story.decorators;
  if (decorate === undefined) throw new Error("missing privacy decorator");
  await render(decorate(() => <View {...story.args} />));
  expect(screen.getAllByLabelText("Amount hidden").length).toBeGreaterThan(0);
  expect(JSON.stringify(screen.toJSON())).not.toContain("389,600");
});

it("puts a compact currency choice in the period row only with more than one currency", async () => {
  const View = spendingMeta.component;
  const view = await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <View {...CurrentMonth.args} />
    </UiEnvProvider>,
  );
  expect(screen.getByLabelText("Currency")).toBeOnTheScreen();
  expect(screen.getByRole("tab", { name: "EUR" })).toBeOnTheScreen();
  expect(screen.getByRole("tab", { name: "PLN", selected: true })).toBeOnTheScreen();
  await view.rerender(
    <UiEnvProvider locale="en-US" privacy={false}>
      <View {...OneCurrency.args} />
    </UiEnvProvider>,
  );
  expect(screen.queryByLabelText("Currency")).toBeNull();
  expect(screen.queryByRole("tab", { name: "PLN" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Month", selected: true })).toBeOnTheScreen();
});
