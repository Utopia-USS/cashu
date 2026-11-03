// Actual screen hooks + Views over isolated event stores. Only navigation/native control internals
// may be isolated; useQuery, the query closures, SQLite and domain money calculations stay real.
import { D } from "@cashu/domain";
import { setLanguageForTests } from "@cashu/i18n";
import { formatDecimalValue } from "@cashu/i18n/values";
import { addCashExpense, recordBalance, setTransactionCategory } from "@cashu/store";
import { setCurrentVault } from "@cashu/store/device";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { type ReactNode, useEffect } from "react";
import { ServicesProvider } from "../services/ServicesProvider";
import { CashflowView } from "./cashflow/CashflowView";
import { useCashflowScreen } from "./cashflow/useCashflowScreen";
import { MoneyView } from "./money/MoneyView";
import { useMoneyScreen } from "./money/useMoneyScreen";
import type { CashflowViewProps, MoneyViewProps, SpendingViewProps } from "./money-contracts";
import { SpendingView } from "./spending/SpendingView";
import { useSpendingScreen } from "./spending/useSpendingScreen";
import {
  applyMoneyCommand,
  importMoneyFacts,
  MONEY_EURO,
  MONEY_OWN_A,
  MONEY_OWN_B,
  MONEY_VAULT_B,
  type MoneyStore,
  moneyStore,
} from "./testing/moneyStore";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@expo/ui", () => require("./testing/expoUiMock"));

const closers: (() => void)[] = [];
beforeEach(() => setLanguageForTests("en"));
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
  mockPush.mockClear();
  setLanguageForTests("en");
});

function setup() {
  const fixture = moneyStore();
  closers.push(() => fixture.close());
  return fixture;
}

function Frame({
  fixture,
  locale = "en-US",
  privacy = false,
  children,
}: {
  fixture: MoneyStore;
  locale?: string;
  privacy?: boolean;
  children: ReactNode;
}) {
  return (
    <ServicesProvider services={fixture.services}>
      <StoreProvider client={fixture.client}>
        <ProfileProvider>
          <UiEnvProvider locale={locale} privacy={privacy}>
            {children}
          </UiEnvProvider>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}

function MoneyScreen({ observed }: { observed: (props: MoneyViewProps) => void }) {
  const props = useMoneyScreen();
  useEffect(() => observed(props));
  return <MoneyView {...props} />;
}
function CashflowScreen({ observed }: { observed: (props: CashflowViewProps) => void }) {
  const props = useCashflowScreen();
  useEffect(() => observed(props));
  return <CashflowView {...props} />;
}
function SpendingScreen({ observed }: { observed: (props: SpendingViewProps) => void }) {
  const props = useSpendingScreen();
  useEffect(() => observed(props));
  return <SpendingView {...props} />;
}

const display = (amount: string, currency: string, locale = "en-US") =>
  formatDecimalValue(D(amount), locale, { currency }).text;

async function measureChart(label: RegExp) {
  const chart = screen
    .getAllByLabelText(label)
    .find((node) => typeof node.props.onLayout === "function");
  if (!chart) throw new Error("missing native measured chart");
  await act(() =>
    chart.props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 160 } },
    }),
  );
}

function grocery(fixture: MoneyStore, reference: string) {
  const txn = fixture.a.store.read<{ gid: string }>(
    "SELECT gid FROM transactions WHERE reference = ?",
    reference,
  )[0]?.gid;
  if (!txn) throw new Error("missing synthetic grocery transaction");
  applyMoneyCommand(fixture.a, setTransactionCategory, { txn, category: "groceries" });
}

function seedBudget(fixture: MoneyStore) {
  importMoneyFacts(fixture.a, "PLN", MONEY_OWN_A, [
    { date: "2026-08-02", amount: "-4.00", key: "synthetic-aug" },
    { date: "2026-09-02", amount: "1000.00", key: "synthetic-income" },
    { date: "2026-09-03", amount: "-12.10", key: "synthetic-food" },
    { date: "2026-09-04", amount: "-300.00", key: "synthetic-own-out", iban: MONEY_OWN_B },
    { date: "2026-09-05", amount: "-50.00", key: "synthetic-atm" },
  ]);
  importMoneyFacts(fixture.a, "PLN", MONEY_OWN_B, [
    { date: "2026-09-04", amount: "300.00", key: "synthetic-own-in", iban: MONEY_OWN_A },
  ]);
  importMoneyFacts(fixture.a, "EUR", MONEY_EURO, [
    { date: "2026-09-03", amount: "-9007199254740993.01", key: "synthetic-euro" },
  ]);
  grocery(fixture, "synthetic-aug");
  grocery(fixture, "synthetic-food");
  const withdrawal = fixture.a.store.read<{ gid: string }>(
    "SELECT gid FROM transactions WHERE reference = ?",
    "synthetic-atm",
  )[0]?.gid;
  if (!withdrawal) throw new Error("missing synthetic withdrawal");
  applyMoneyCommand(fixture.a, setTransactionCategory, {
    txn: withdrawal,
    category: "cash_withdrawal",
  });
  applyMoneyCommand(fixture.a, addCashExpense, {
    amount: "7.90",
    title: "Synthetic cash food",
    category: "groceries",
    currency: "PLN",
    onDate: "2026-09-07",
  });
}

describe("native money screens with the real synchronous store", () => {
  it("renders exact selected-currency net worth and a live balance append", async () => {
    const fixture = setup();
    const pln = importMoneyFacts(fixture.a, "PLN", MONEY_OWN_A, []);
    const eur = importMoneyFacts(fixture.a, "EUR", MONEY_EURO, []);
    applyMoneyCommand(fixture.a, recordBalance, {
      account: pln,
      date: "2026-09-01",
      amount: "12.34",
    });
    applyMoneyCommand(fixture.a, recordBalance, {
      account: pln,
      date: "2026-10-01",
      amount: "-5.67",
    });
    applyMoneyCommand(fixture.a, recordBalance, {
      account: eur,
      date: "2026-10-01",
      amount: "9007199254740993.12",
    });
    let props: MoneyViewProps | undefined;
    await render(
      <Frame fixture={fixture}>
        <MoneyScreen
          observed={(p) => {
            props = p;
          }}
        />
      </Frame>,
    );
    expect(props?.currency).toBe("PLN");
    expect(props?.total?.amount.toString()).toBe("-5.67");
    expect(screen.getAllByText(display("-5.67", "PLN")).length).toBeGreaterThan(0);
    await fireEvent(screen.getByTestId("money-currency"), "valueChange", "EUR");
    expect(props?.total?.amount.toString()).toBe("9007199254740993.12");
    expect(screen.getAllByText(display("9007199254740993.12", "EUR")).length).toBeGreaterThan(0);
    expect(props?.history.series[0]?.accessibleSummary).toContain(
      display("9007199254740993.12", "EUR"),
    );
    await measureChart(/^Net worth history/);
    expect(
      screen
        .getAllByLabelText(/^Net worth history/)
        .some((node) =>
          node.props.accessibilityLabel.includes(display("9007199254740993.12", "EUR")),
        ),
    ).toBe(true);
    await act(() => {
      applyMoneyCommand(fixture.a, recordBalance, {
        account: eur,
        date: "2026-10-02",
        amount: "9007199254740993.13",
      });
    });
    expect(props?.total?.amount.toString()).toBe("9007199254740993.13");
    expect(screen.getAllByText(display("9007199254740993.13", "EUR")).length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByLabelText(/^Net worth history/)
        .some((node) =>
          node.props.accessibilityLabel.includes(display("9007199254740993.13", "EUR")),
        ),
    ).toBe(true);
    await fireEvent.press(screen.getByRole("button", { name: "Cashflow" }));
    expect(mockPush).toHaveBeenCalledWith("/cashflow");
  });

  it("renders true cashflow after transfer/cash derivation and currency/period changes", async () => {
    const fixture = setup();
    seedBudget(fixture);
    let props: CashflowViewProps | undefined;
    const view = await render(
      <Frame fixture={fixture}>
        <CashflowScreen
          observed={(p) => {
            props = p;
          }}
        />
      </Frame>,
    );
    expect(
      props?.rows.map((r) => [r.label, r.income.amount.toString(), r.expense.amount.toString()]),
    ).toEqual([
      ["2026-08", "0.00", "4.00"],
      ["2026-09", "1000.00", "20.00"],
    ]);
    await fireEvent(screen.getByTestId("money-period-kind"), "valueChange", "month");
    expect(props?.rows).toHaveLength(1);
    expect(screen.getAllByText(display("980.00", "PLN")).length).toBeGreaterThan(0);
    expect(props?.chart.valueLabels).toEqual([display("980.00", "PLN")]);
    await measureChart(/^Cashflow/);
    expect(screen.getAllByLabelText(/980/).length).toBeGreaterThan(0);
    await fireEvent(screen.getByTestId("money-currency"), "valueChange", "EUR");
    expect(props?.rows[0]?.net.amount.toString()).toBe("-9007199254740993.01");
    expect(props?.chart.valueLabels).toEqual([display("-9007199254740993.01", "EUR")]);
    expect(screen.getAllByText(display("-9007199254740993.01", "EUR")).length).toBeGreaterThan(0);
    await view.rerender(
      <Frame fixture={fixture} privacy>
        <CashflowScreen
          observed={(p) => {
            props = p;
          }}
        />
      </Frame>,
    );
    expect(screen.getByLabelText(/^Cashflow: 2026-09 hidden$/)).toBeOnTheScreen();
    expect(JSON.stringify(screen.toJSON())).not.toContain("9007199254740993");
    await act(() => props?.onPeriodChange({ kind: "quarter", year: 2026, quarter: 1 }));
    expect(props?.empty).toBe(true);
    expect(props?.rows).toEqual([]);
  });

  it("localizes spending, masks accessible amounts, and updates from a native cash append", async () => {
    const fixture = setup();
    seedBudget(fixture);
    let props: SpendingViewProps | undefined;
    const observed = (p: SpendingViewProps) => {
      props = p;
    };
    const view = await render(
      <Frame fixture={fixture}>
        <SpendingScreen observed={observed} />
      </Frame>,
    );
    await fireEvent(screen.getByTestId("money-period-kind"), "valueChange", "month");
    expect(props?.total.amount.toString()).toBe("20.00");
    expect(screen.getByText("Groceries")).toBeOnTheScreen();
    expect(screen.getAllByText(display("20.00", "PLN")).length).toBeGreaterThan(0);
    await act(() => {
      applyMoneyCommand(fixture.a, addCashExpense, {
        amount: "0.11",
        title: "Synthetic extra food",
        category: "groceries",
        currency: "PLN",
        onDate: "2026-09-08",
      });
    });
    expect(props?.total.amount.toString()).toBe("20.11");
    expect(screen.getAllByText(display("20.11", "PLN")).length).toBeGreaterThan(0);
    setLanguageForTests("pl");
    await view.rerender(
      <Frame fixture={fixture} locale="pl-PL" privacy>
        <SpendingScreen observed={observed} />
      </Frame>,
    );
    expect(screen.getByText("Spożywcze")).toBeOnTheScreen();
    expect(screen.getAllByLabelText("Kwota ukryta").length).toBeGreaterThan(0);
    const hidden = JSON.stringify(screen.toJSON());
    expect(hidden).not.toContain("20.11");
    expect(hidden).not.toContain("20,11");
    expect(screen.getByLabelText(/Spożywcze 100%/)).toBeOnTheScreen();
    await fireEvent(screen.getByTestId("money-currency"), "valueChange", "EUR");
    expect(props?.total.amount.toString()).toBe("9007199254740993.01");
    expect(JSON.stringify(screen.toJSON())).not.toContain("9007199254740993");
  });

  it("switches the actual current vault without reusing the previous profile's snapshot", async () => {
    const fixture = setup();
    seedBudget(fixture);
    let props: SpendingViewProps | undefined;
    await render(
      <Frame fixture={fixture}>
        <SpendingScreen
          observed={(p) => {
            props = p;
          }}
        />
      </Frame>,
    );
    expect(props?.empty).toBe(false);
    await act(() => {
      fixture.device.run(setCurrentVault, { vault: MONEY_VAULT_B });
    });
    expect(props?.empty).toBe(true);
    expect(props?.rows).toEqual([]);
    expect(props?.total.amount.toString()).toBe("0.00");
    await act(() => {
      applyMoneyCommand(fixture.b, addCashExpense, {
        amount: "2.03",
        title: "Synthetic B food",
        category: "groceries",
        currency: "PLN",
        onDate: "2026-09-08",
      });
    });
    expect(props?.total.amount.toString()).toBe("2.03");
    expect(screen.getAllByText(display("2.03", "PLN")).length).toBeGreaterThan(0);
    expect(screen.queryByText(display("24.00", "PLN"))).toBeNull();
  });
});
