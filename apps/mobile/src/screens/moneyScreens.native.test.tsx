// Actual screen hooks + Views over isolated event stores. Only navigation/native control internals
// may be isolated; useQuery, the query closures, SQLite and domain money calculations stay real.
// The calendar is pinned to Thu 12 Nov 2026 (only `Date` is faked; timers stay real).
import { D } from "@cashu/domain";
import { toCurrency } from "@cashu/domain/investments";
import { setLanguageForTests } from "@cashu/i18n";
import { formatDecimalValue } from "@cashu/i18n/values";
import {
  addCashExpense,
  betterSqlite3Driver,
  recordBalance,
  setModules,
  setTransactionCategory,
} from "@cashu/store";
import { setCurrentVault } from "@cashu/store/device";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { createUiLoan } from "@cashu/store/loans/screen";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import Database from "better-sqlite3";
import { type ReactNode, useEffect } from "react";
import { ServicesProvider } from "../services/ServicesProvider";
import { LoanView } from "./loan/LoanView";
import { useLoanScreen } from "./loan/useLoanScreen";
import type { LoanViewProps, NetWorthViewProps, SpendingViewProps } from "./money-contracts";
import { NetWorthView } from "./networth/NetWorthView";
import { useNetWorthScreen } from "./networth/useNetWorthScreen";
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

jest.mock("@expo/ui", () => require("./testing/expoUiMock").default);

const NOT_DATE = [
  "hrtime",
  "nextTick",
  "performance",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "setImmediate",
  "clearImmediate",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
] as const;

const closers: (() => void)[] = [];
beforeEach(() => {
  jest.useFakeTimers({ now: new Date(2026, 10, 12, 12), doNotFake: [...NOT_DATE] });
  setLanguageForTests("en");
});
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
  jest.useRealTimers();
  setLanguageForTests("en");
});

function setup(prices?: SqlPriceCache) {
  const fixture = prices === undefined ? moneyStore() : moneyStore({ prices, changes: prices });
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

const openLoan = jest.fn();
function NetWorthScreen({ observed }: { observed: (props: NetWorthViewProps) => void }) {
  const props = useNetWorthScreen({ today: "2026-11-12", openLoan, openProfile: () => {} });
  useEffect(() => observed(props));
  return <NetWorthView {...props} />;
}
function LoanScreen({ gid, observed }: { gid: string; observed: (props: LoanViewProps) => void }) {
  const props = useLoanScreen({ gid, today: "2026-11-12" });
  useEffect(() => observed(props));
  return <LoanView {...props} />;
}
const picked = jest.fn();
const closed = jest.fn();
function SpendingScreen({ observed }: { observed: (props: SpendingViewProps) => void }) {
  const props = useSpendingScreen({
    today: "2026-11-12",
    onCategoryPicked: picked,
    onMonthClosePressed: closed,
  });
  useEffect(() => observed(props));
  return <SpendingView {...props} />;
}

const display = (amount: string, currency: string, locale = "en-US") =>
  formatDecimalValue(D(amount), locale, { currency }).text;

function balances(fixture: MoneyStore) {
  const pln = importMoneyFacts(fixture.a, "PLN", MONEY_OWN_A, []);
  const eur = importMoneyFacts(fixture.a, "EUR", MONEY_EURO, []);
  applyMoneyCommand(fixture.a, recordBalance, {
    account: pln,
    date: "2026-11-01",
    amount: "1000.00",
  });
  applyMoneyCommand(fixture.a, recordBalance, {
    account: eur,
    date: "2026-11-01",
    amount: "100.00",
  });
  return { pln, eur };
}

function categorize(fixture: MoneyStore, reference: string, category: string) {
  const txn = fixture.a.store.read<{ gid: string }>(
    "SELECT gid FROM transactions WHERE reference = ?",
    reference,
  )[0]?.gid;
  if (!txn) throw new Error(`missing synthetic transaction ${reference}`);
  applyMoneyCommand(fixture.a, setTransactionCategory, { txn, category });
}

/** Four closed months of groceries 100 and travel 50, then November: groceries 100, travel 200,
 * an own-account transfer and EUR 86 in the euro account. */
function seedMonths(fixture: MoneyStore) {
  const months = ["2026-07", "2026-08", "2026-09", "2026-10"];
  importMoneyFacts(fixture.a, "PLN", MONEY_OWN_A, [
    ...months.flatMap((m) => [
      { date: `${m}-01`, amount: "-100.00", key: `food-${m}` },
      { date: `${m}-02`, amount: "-50.00", key: `trip-${m}` },
    ]),
    { date: "2026-11-02", amount: "-100.00", key: "food-2026-11" },
    { date: "2026-11-03", amount: "-200.00", key: "trip-2026-11" },
    // A transfer to the owner's other account is not spending.
    { date: "2026-11-05", amount: "-500.00", key: "own-out", iban: MONEY_OWN_B },
  ]);
  importMoneyFacts(fixture.a, "PLN", MONEY_OWN_B, [
    // The second PLN account is covered from July too, so the closed months make the usual month.
    { date: "2026-07-01", amount: "10.00", key: "own-b-opened" },
    { date: "2026-11-05", amount: "500.00", key: "own-in", iban: MONEY_OWN_A },
  ]);
  importMoneyFacts(fixture.a, "EUR", MONEY_EURO, [
    { date: "2026-11-04", amount: "-86.00", key: "euro-2026-11" },
  ]);
  for (const m of [...months, "2026-11"]) {
    categorize(fixture, `food-${m}`, "groceries");
    categorize(fixture, `trip-${m}`, "travel");
  }
}

describe("net worth tab with the real synchronous store", () => {
  it("shows the headline currency alone with the other currency beside it until NBP rates exist", async () => {
    const fixture = setup();
    const { pln } = balances(fixture);
    let props: NetWorthViewProps | undefined;
    const view = await render(
      <Frame fixture={fixture}>
        <NetWorthScreen
          observed={(p) => {
            props = p;
          }}
        />
      </Frame>,
    );
    expect(props?.hero.label).toBe("net");
    expect(props?.hero.value?.amount.toString()).toBe("1000.00");
    expect(props?.hero.otherCurrencies.map((o) => o.amount.amount.toString())).toEqual(["100.00"]);
    expect(props?.hero.missingRate).toEqual(["EUR"]);
    expect(props?.partnerFirst).toBe(true);
    expect(props?.accounts.map((a) => [a.bank, a.amount?.amount.toString()])).toEqual([
      ["mBank", "1000.00"],
      ["mBank", "100.00"],
    ]);
    expect(screen.getAllByText("Net worth").length).toBeGreaterThan(0);
    expect(screen.getByText("EUR: no NBP rate on this phone yet, not counted")).toBeOnTheScreen();
    await act(() => {
      applyMoneyCommand(fixture.a, recordBalance, {
        account: pln,
        date: "2026-11-11",
        amount: "1200.00",
      });
    });
    expect(props?.hero.value?.amount.toString()).toBe("1200.00");
    await fireEvent(screen.getByTestId("money-currency"), "valueChange", "EUR");
    expect(props?.hero.value?.amount.toString()).toBe("100.00");
    expect(props?.facts).toEqual([]);
    await view.rerender(
      <Frame fixture={fixture} privacy>
        <NetWorthScreen
          observed={(p) => {
            props = p;
          }}
        />
      </Frame>,
    );
    // Hidden amounts without a banana scale: dots, and no "in bananas" label.
    expect(screen.queryByText("Net worth, in bananas")).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toContain("1,200.00");
  });

  it("converts at the NBP rate the device holds, labelled with the table's own date", async () => {
    const cacheDb = new Database(":memory:");
    closers.push(() => cacheDb.close());
    const prices = new SqlPriceCache(betterSqlite3Driver(cacheDb));
    const fixture = setup(prices);
    balances(fixture);
    let props: NetWorthViewProps | undefined;
    await render(
      <Frame fixture={fixture}>
        <NetWorthScreen
          observed={(p) => {
            props = p;
          }}
        />
      </Frame>,
    );
    expect(props?.hero.label).toBe("net");
    await act(() => {
      prices.upsertRates(
        "nbp",
        toCurrency("EUR"),
        [{ date: "2026-11-10", rate: D("4.2386"), fetchedAt: null }],
        { date: "2026-11-12", hour: 13, minute: 0, second: 0, microsecond: 0, offsetSeconds: 0 },
      );
    });
    expect(props?.hero.label).toBe("converted");
    expect(props?.hero.value?.amount.toString()).toBe("1423.86");
    expect(props?.hero.parts.map((p) => p.amount.amount.toString())).toEqual(["100.00"]);
    expect(props?.hero.missingRate).toEqual([]);
    expect(screen.getByText("Net worth, converted to PLN")).toBeOnTheScreen();
    expect(screen.getByText("converted at the NBP mid rate of Tue, Nov 10")).toBeOnTheScreen();
    expect(screen.getAllByText(display("100.00", "EUR")).length).toBeGreaterThan(0);
  });

  it("lists a loan that opens its page with the next installment from the schedule", async () => {
    const fixture = setup();
    balances(fixture);
    applyMoneyCommand(fixture.a, setModules, { moduleIds: ["budget", "loans"] });
    applyMoneyCommand(fixture.a, createUiLoan, {
      name: "Synthetic mortgage",
      principal: "12000",
      annualRate: "6",
      termMonths: 12,
      startDate: "2026-06-30",
      originationDate: null,
    });
    let props: NetWorthViewProps | undefined;
    await render(
      <Frame fixture={fixture}>
        <NetWorthScreen
          observed={(p) => {
            props = p;
          }}
        />
      </Frame>,
    );
    const loan = props?.loans[0];
    expect(props?.loans).toHaveLength(1);
    expect(loan?.outstanding.amount.lt(D("0"))).toBe(true);
    expect(loan?.share).toBeGreaterThan(0);
    expect(loan?.share).toBeLessThan(1);
    expect(
      screen.getByText("Values and loan terms are updated on the Mac, a few times a year."),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Open loan Synthetic mortgage" }));
    expect(openLoan).toHaveBeenCalledWith(loan?.gid);

    let page: LoanViewProps | undefined;
    await render(
      <Frame fixture={fixture}>
        <LoanScreen
          gid={loan?.gid ?? ""}
          observed={(p) => {
            page = p;
          }}
        />
      </Frame>,
    );
    expect(page?.loan?.next?.date).toBe("2026-11-30");
    expect(page?.loan?.next?.account).toBeNull();
    expect(page?.loan?.annualRate.toString()).toBe("0.06");
    expect(page?.loan?.repaidLine.replace(/\s/gu, " ")).toMatch(/^\d+% of PLN 12,000 repaid$/u);
    expect(page?.loan?.outstanding.amount.toString()).toBe(
      loan?.outstanding.amount.neg().toString(),
    );
    expect(screen.getByText("Next installment")).toBeOnTheScreen();
    expect(screen.getByText("Loan terms are edited on the Mac.")).toBeOnTheScreen();
  });
});

describe("spending with the real synchronous store", () => {
  it("compares this month with the usual, per category, and steps to a closed month", async () => {
    const fixture = setup();
    seedMonths(fixture);
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
    expect(props?.periodLabel).toBe("November 2026");
    expect(props?.onNext).toBeNull();
    expect(props?.total.amount.toString()).toBe("300.00");
    expect(props?.closedMonth).toBeNull();
    const byKey = Object.fromEntries((props?.rows ?? []).map((r) => [r.key, r.vsUsual]));
    expect(byKey.travel).toEqual({ kind: "over", text: "+300%" });
    expect(byKey.groceries).toEqual({ kind: "usual" });
    expect(props?.vsUsual).not.toBeNull();
    expect(screen.getByText("+300% vs usual")).toBeOnTheScreen();
    expect(screen.getByText("as usual")).toBeOnTheScreen();
    expect(props?.otherCurrencies.map((m) => m.amount.toString())).toEqual(["86.00"]);
    await fireEvent.press(screen.getByText("Travel"));
    expect(picked).toHaveBeenCalledWith("travel");

    await fireEvent.press(screen.getByRole("button", { name: "Previous period" }));
    expect(props?.periodLabel).toBe("October 2026");
    expect(props?.total.amount.toString()).toBe("150.00");
    expect(props?.closedMonth).toEqual({ month: "2026-10", label: "October 2026 closed" });
    await fireEvent.press(screen.getByText("October 2026 closed"));
    expect(closed).toHaveBeenCalledWith("2026-10");

    await fireEvent.press(screen.getByRole("tab", { name: "Quarter" }));
    expect(props?.kind).toBe("quarter");
    expect(props?.periodLabel).toBe("Q4 2026");
    expect(props?.vsUsual).toBeNull();
    expect(props?.rows.every((r) => r.vsUsual === null)).toBe(true);
    expect(props?.total.amount.toString()).toBe("450.00");
  });

  it("updates from a native cash append and switches vaults without the previous snapshot", async () => {
    const fixture = setup();
    seedMonths(fixture);
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
    await act(() => {
      applyMoneyCommand(fixture.a, addCashExpense, {
        amount: "0.11",
        title: "Synthetic extra food",
        category: "groceries",
        currency: "PLN",
        onDate: "2026-11-08",
      });
    });
    expect(props?.total.amount.toString()).toBe("300.11");
    await act(() => {
      fixture.device.run(setCurrentVault, { vault: MONEY_VAULT_B });
    });
    expect(props?.empty).toBe(true);
    expect(props?.total.amount.isZero()).toBe(true);
  });
});
