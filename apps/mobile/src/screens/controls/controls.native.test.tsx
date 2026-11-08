import { setLanguageForTests } from "@cashu/i18n";
import { UiEnvProvider } from "@cashu/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { useState } from "react";
import type { PeriodChoice } from "../money-contracts";
import meta, { Empty, RetainedHistory } from "./Controls.stories";
import { CurrencyPicker } from "./CurrencyPicker";
import { PeriodPicker } from "./PeriodPicker";

jest.mock("@expo/ui", () => require("../testing/expoUiMock").default);

afterEach(() => {
  cleanup();
  setLanguageForTests("en");
});

it.each([RetainedHistory, Empty])(
  "renders the actual controls CSF story with its supplied state",
  async (story) => {
    setLanguageForTests("en");
    await render(
      <UiEnvProvider privacy={false} locale="en-US">
        <meta.component {...story.args} />
      </UiEnvProvider>,
    );
    expect(screen.getByText("Currency")).toBeTruthy();
    expect(screen.getByText("Period")).toBeTruthy();
    if (story.args.empty) expect(screen.getByText("No currencies")).toBeTruthy();
    else expect(screen.getByTestId("money-currency").props.selectedValue).toBe("PLN");
  },
);

it("selects only a different currency supplied by the genuine hook contract", async () => {
  const changed = jest.fn();
  await render(
    <CurrencyPicker currencies={["PLN", "EUR"]} currency="PLN" onCurrencyChange={changed} />,
  );
  await fireEvent(screen.getByTestId("money-currency"), "valueChange", "USD");
  await fireEvent(screen.getByTestId("money-currency"), "valueChange", "PLN");
  expect(changed).not.toHaveBeenCalled();
  await fireEvent(screen.getByTestId("money-currency"), "valueChange", "EUR");
  expect(changed).toHaveBeenCalledWith("EUR");
});

function PeriodStory({ initial }: { initial: PeriodChoice }) {
  const [period, onPeriodChange] = useState(initial);
  return (
    <UiEnvProvider locale="en-US" privacy={false}>
      <PeriodPicker
        period={period}
        periodBounds={{ first: "2024-11-05", last: "2025-02-20" }}
        onPeriodChange={onPeriodChange}
      />
    </UiEnvProvider>
  );
}

it("steps December into January and stops at retained month boundaries", async () => {
  setLanguageForTests("en");
  await render(<PeriodStory initial={{ kind: "month", year: 2024, month: 12 }} />);
  await fireEvent.press(screen.getByTestId("money-period-next"));
  expect(screen.getByText("January 2025")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("money-period-next"));
  expect(screen.getByText("February 2025")).toBeTruthy();
  expect(screen.getByTestId("money-period-next").props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(screen.getByTestId("money-period-next"));
  expect(screen.getByText("February 2025")).toBeTruthy();
  await fireEvent(screen.getByTestId("money-period-kind"), "valueChange", "all");
  expect(screen.getAllByText("All history").length).toBeGreaterThan(0);
  expect(screen.getByTestId("money-period-previous").props.accessibilityState.disabled).toBe(true);
});

it("starts a bounded quarter from All and crosses Q4 into Q1", async () => {
  setLanguageForTests("en");
  await render(<PeriodStory initial={{ kind: "all" }} />);
  await fireEvent(screen.getByTestId("money-period-kind"), "valueChange", "quarter");
  expect(screen.getByText("Q1 2025")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("money-period-previous"));
  expect(screen.getByText("Q4 2024")).toBeTruthy();
  expect(screen.getByTestId("money-period-previous").props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(screen.getByTestId("money-period-next"));
  expect(screen.getByText("Q1 2025")).toBeTruthy();
});

it("refuses an unsupported period mode", async () => {
  const changed = jest.fn();
  await render(
    <PeriodPicker
      period={{ kind: "quarter", year: 2025, quarter: 1 }}
      periodBounds={{ first: "2025-01-01", last: "2025-03-31" }}
      onPeriodChange={changed}
    />,
  );
  await fireEvent(screen.getByTestId("money-period-kind"), "valueChange", "week");
  expect(changed).not.toHaveBeenCalled();
});
