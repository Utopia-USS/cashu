// The payment sheet's hook and View over isolated real event stores (synthetic payees only): the
// category written on tap, the payee pinned by the rule toggle, transfers, inflows and the payee's
// history; and every story of the View. The calendar is pinned to Thu 12 Nov 2026.
import { D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { setLanguageForTests } from "@cashu/i18n";
import { importStatement, setLlmCategories } from "@cashu/store";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import type { VaultHandle } from "@cashu/store-react/local";
import { UiEnvProvider } from "@cashu/ui/native";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { type ComponentType, type ReactNode, useEffect } from "react";
import { ServicesProvider } from "../../services/ServicesProvider";
import {
  applyMoneyCommand,
  MONEY_OWN_A,
  MONEY_OWN_B,
  type MoneyStore,
  moneyStore,
} from "../testing/moneyStore";
import { PaymentSheetView } from "./PaymentSheetView";
import paymentMeta, {
  CategorizedRuleFixed,
  CouldNotSave,
  FirstPayment,
  Income,
  Missing,
  Transfer,
  UncategorizedWithSuggestion,
} from "./PaymentSheetView.stories";
import { type PaymentSheetState, usePaymentSheet } from "./usePaymentSheet";

jest.mock("@expo/ui", () => require("../testing/expoUiMock").default);

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
});

interface Payment {
  readonly date: string;
  readonly amount: string;
  readonly payee: string;
  readonly ref: string;
  readonly iban?: string;
}

function importPayments(handle: VaultHandle, number: string, payments: readonly Payment[]) {
  const transactions: RawTransaction[] = payments.map((p) => ({
    bookingDate: p.date,
    valueDate: null,
    amount: D(p.amount),
    currency: "PLN",
    counterpartyName: p.payee,
    counterpartyIban: p.iban ?? null,
    description: p.ref,
    reference: p.ref,
    bankTransactionId: null,
    source: "csv",
    raw: { synthetic: p.ref },
  }));
  applyMoneyCommand(handle, importStatement, {
    statement: {
      bank: "mbank",
      accountNumber: number,
      accountName: "Synthetic account",
      currency: "PLN",
      transactions,
      balances: [],
      closingBalances: [],
    },
    newestDayRule: false,
  });
}

function seed(fixture: MoneyStore) {
  importPayments(fixture.a, MONEY_OWN_A, [
    { date: "2026-09-02", amount: "-60.00", payee: "QUUX STUDIO", ref: "quux-1" },
    { date: "2026-11-11", amount: "-317.53", payee: "QUUX STUDIO", ref: "quux-2" },
    { date: "2026-11-10", amount: "-12.00", payee: "FOOBAR KIOSK", ref: "foobar" },
    { date: "2026-11-10", amount: "8200.00", payee: "SYNTHETIC EMPLOYER", ref: "pay" },
    { date: "2026-11-11", amount: "-500.00", payee: "Own", ref: "own-out", iban: MONEY_OWN_B },
  ]);
  importPayments(fixture.a, MONEY_OWN_B, [
    { date: "2026-11-11", amount: "500.00", payee: "Own", ref: "own-in", iban: MONEY_OWN_A },
  ]);
}

const gidOf = (fixture: MoneyStore, ref: string): string => {
  const gid = fixture.a.store.read<{ gid: string }>(
    "SELECT gid FROM transactions WHERE reference = ?",
    ref,
  )[0]?.gid;
  if (!gid) throw new Error(`missing synthetic transaction ${ref}`);
  return gid;
};

function Frame({ fixture, children }: { fixture: MoneyStore; children: ReactNode }) {
  return (
    <ServicesProvider services={fixture.services}>
      <StoreProvider client={fixture.client}>
        <ProfileProvider>
          <UiEnvProvider locale="en-US" privacy={false}>
            {children}
          </UiEnvProvider>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}

const closed = jest.fn();
function PaymentSheet({
  gid,
  observed,
}: {
  gid: string;
  observed: (props: PaymentSheetState) => void;
}) {
  const props = usePaymentSheet({ gid, lang: "en", today: "2026-11-12", close: closed });
  useEffect(() => observed(props));
  return <PaymentSheetView {...props} />;
}

async function show(ref: string) {
  const fixture = moneyStore();
  closers.push(() => fixture.close());
  seed(fixture);
  let props: PaymentSheetState | undefined;
  await render(
    <Frame fixture={fixture}>
      <PaymentSheet
        gid={ref === "missing" ? "0".repeat(32) : gidOf(fixture, ref)}
        observed={(p) => {
          props = p;
        }}
      />
    </Frame>,
  );
  const ready = () => {
    if (props?.kind !== "ready") throw new Error("the payment sheet is not ready");
    return props;
  };
  return { fixture, ready, current: () => props };
}

describe("the payment sheet over the real synchronous store", () => {
  it("writes the category on tap, then pins the payee with the rule toggle", async () => {
    const { fixture, ready } = await show("quux-2");
    expect(ready().category?.selected).toBeNull();
    expect(ready().rule).toMatchObject({ on: false, fixed: null, count: 2, enabled: false });
    expect(ready().earlier).toEqual({
      rows: [
        { gid: gidOf(fixture, "quux-1"), dateLabel: "Sep 2, 2026", amount: expect.anything() },
      ],
    });
    await fireEvent.press(screen.getByRole("button", { name: "All categories" }));
    await fireEvent.press(screen.getByRole("button", { name: "Travel" }));
    expect(ready().category?.selected).toBe("travel");
    expect(ready().error).toBeNull();
    expect(ready().rule?.enabled).toBe(true);
    await act(async () => {
      ready().rule?.onToggle(true);
    });
    expect(fixture.a.store.read("SELECT category, source, locked FROM category_rules")).toEqual([
      { category: "travel", source: "manual", locked: 1 },
    ]);
    expect(ready().rule).toMatchObject({ on: true, fixed: "Travel" });
    expect(screen.getByText("Always filed under Travel")).toBeOnTheScreen();
    expect(screen.getByText("Same for every QUUX STUDIO payment")).toBeOnTheScreen();
  });

  it("keeps a tap made while the first write runs, so the last tap wins", async () => {
    const { fixture, ready } = await show("foobar");
    await act(async () => {
      ready().category?.onPick("travel");
      ready().category?.onPick("groceries");
    });
    expect(
      fixture.a.store.read("SELECT category FROM transactions WHERE reference = 'foobar'"),
    ).toEqual([{ category: "groceries" }]);
    expect(ready().category?.selected).toBe("groceries");
    expect(ready().error).toBeNull();
  });

  it("never pins the engine's suggestion: the rule waits for a confirmed category", async () => {
    const { fixture, ready } = await show("quux-2");
    applyMoneyCommand(fixture.a, setLlmCategories, {
      items: [{ txn: gidOf(fixture, "quux-2"), category: "travel" }],
    });
    await act(async () => {});
    expect(ready().category).toMatchObject({ selected: null, suggested: "travel" });
    expect(ready().rule?.enabled).toBe(false);
    for (const toggle of screen.getAllByRole("switch")) expect(toggle).toBeDisabled();
    await act(async () => {
      ready().rule?.onToggle(true);
    });
    expect(fixture.a.store.read("SELECT category FROM category_rules")).toEqual([]);
  });

  it("explains an own transfer and offers no category", async () => {
    const { ready } = await show("own-out");
    expect(ready().transfer).toEqual({ counterpart: "Synthetic account" });
    expect(ready().category).toBeNull();
    expect(ready().rule).toBeNull();
    expect(screen.getByText("Between your own accounts")).toBeOnTheScreen();
  });

  it("shows an inflow without a category section", async () => {
    const { ready } = await show("pay");
    expect(ready().income).toBe(true);
    expect(ready().category).toBeNull();
    expect(screen.queryByText("Category")).toBeNull();
  });

  it("notes a first payment to a payee and the import it came with", async () => {
    const { ready } = await show("foobar");
    expect(ready().earlier).toEqual({ first: true });
    expect(ready().batch).toMatch(/^Imported .+ · statement file$/);
    expect(screen.getByText("First payment to FOOBAR KIOSK in your history.")).toBeOnTheScreen();
  });

  it("is gone when the payment is", async () => {
    const { current } = await show("missing");
    expect(current()?.kind).toBe("missing");
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(closed).toHaveBeenCalled();
  });
});

const stories: [string, object][] = [
  ["uncategorized with suggestion", UncategorizedWithSuggestion.args],
  ["categorized with the rule fixed", CategorizedRuleFixed.args],
  ["transfer", Transfer.args],
  ["income", Income.args],
  ["first payment", FirstPayment.args],
  ["could not save", CouldNotSave.args],
  ["missing", Missing.args],
];

it.each(stories)("renders the %s story", async (_name, args) => {
  const View = paymentMeta.component as ComponentType<object>;
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <View {...paymentMeta.args} {...args} />
    </UiEnvProvider>,
  );
  expect(screen.root).toBeOnTheScreen();
});
