// The Activity hook and View over isolated real event stores (synthetic payees only), and every story
// of the View. The calendar is pinned to Thu 12 Nov 2026 (only `Date` is faked; timers stay real).
import { D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { setLanguageForTests } from "@cashu/i18n";
import { importStatement } from "@cashu/store";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import type { VaultHandle } from "@cashu/store-react/local";
import { UiEnvProvider } from "@cashu/ui/native";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { type ComponentType, useEffect, useState } from "react";
import { ServicesProvider } from "../../services/ServicesProvider";
import {
  applyMoneyCommand,
  MONEY_OWN_A,
  MONEY_OWN_B,
  type MoneyStore,
  moneyStore,
} from "../testing/moneyStore";
import { ActivityView } from "./ActivityView";
import activityMeta, {
  Browse,
  CategoryFromSpending,
  Empty,
  LoadingMore,
  LongestPage,
  PartnerWithoutCash,
  SearchNoMatch,
  SearchWithSummary,
} from "./ActivityView.stories";
import { type ActivityParams, type ActivityState, useActivityScreen } from "./useActivityScreen";

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

/** Imports invented payments into the account `number` (each with its own payee). */
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
    { date: "2026-11-10", amount: "8200.00", payee: "SYNTHETIC EMPLOYER", ref: "pay" },
    { date: "2026-11-10", amount: "-45.00", payee: "QUUX STUDIO", ref: "quux-1" },
    { date: "2026-11-11", amount: "-86.40", payee: "BIEDRONKA", ref: "groceries" },
    { date: "2026-11-11", amount: "-317.53", payee: "QUUX STUDIO", ref: "quux-2" },
    { date: "2026-11-11", amount: "-500.00", payee: "Own", ref: "own-out", iban: MONEY_OWN_B },
    { date: "2024-03-15", amount: "-1101.85", payee: "WARTA SA", ref: "warta-2024" },
    { date: "2025-03-12", amount: "-1190.00", payee: "WARTA SA", ref: "warta-2025" },
    { date: "2026-03-14", amount: "-1284.00", payee: "WARTA SA", ref: "warta-2026" },
  ]);
  importPayments(fixture.a, MONEY_OWN_B, [
    { date: "2026-11-11", amount: "500.00", payee: "Own", ref: "own-in", iban: MONEY_OWN_A },
  ]);
}

function Frame({ fixture, children }: { fixture: MoneyStore; children: React.ReactNode }) {
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

const opened = jest.fn();
/** The route's part: params in state, `setParams` merging like `router.setParams`. */
function ActivityScreen({
  initial,
  observed,
}: {
  initial: ActivityParams;
  observed: (props: ActivityState) => void;
}) {
  const [params, setParams] = useState(initial);
  const props = useActivityScreen({
    params,
    today: "2026-11-12",
    openPayment: opened,
    openCash: () => {},
    openProfile: () => {},
    setParams: (next) => setParams((current) => ({ ...current, ...next })),
  });
  useEffect(() => observed(props));
  return <ActivityView {...props} />;
}

async function show(initial: ActivityParams = {}) {
  const fixture = moneyStore();
  closers.push(() => fixture.close());
  seed(fixture);
  let props: ActivityState | undefined;
  await render(
    <Frame fixture={fixture}>
      <ActivityScreen
        initial={initial}
        observed={(p) => {
          props = p;
        }}
      />
    </Frame>,
  );
  return { fixture, current: () => props as ActivityState };
}

describe("Activity over the real synchronous store", () => {
  it("groups the payments by booking day, newest first, with the day's spending", async () => {
    const { current } = await show();
    const state = current();
    expect(state.mode).toBe("browse");
    // No wallet yet: no Cash chip, but the plus button adds the first expense.
    expect(state.showCash).toBe(false);
    expect(state.canAddCash).toBe(true);
    expect(screen.getByRole("button", { name: "Add a cash expense" })).toBeOnTheScreen();
    expect(state.days.slice(0, 2).map((d) => [d.label, d.spent?.amount.toString()])).toEqual([
      ["Wed, Nov 11", "403.93"],
      ["Tue, Nov 10", "45.00"],
    ]);
    const nov11 = state.days[0]?.rows ?? [];
    expect(nov11.find((r) => r.payee === "Own" && r.amount.amount.lt(D("0")))).toMatchObject({
      sub: { kind: "internal" },
      dim: true,
    });
    expect(nov11.find((r) => r.payee === "BIEDRONKA")?.sub).toMatchObject({
      kind: "category",
      label: "Groceries",
      account: "Synthetic account",
    });
    expect(state.days[1]?.rows.find((r) => r.payee === "SYNTHETIC EMPLOYER")?.income).toBe(true);
    expect(state.days.at(-1)?.label).toBe("Fri, Mar 15, 2024");
    expect(state.chips.map((c) => [c.key, c.count, c.active])).toEqual([
      ["all", undefined, true],
      ["uncategorized", 2, false],
      ["income", undefined, false],
    ]);
    expect(screen.getByText("Wed, Nov 11")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("BIEDRONKA"));
    expect(opened).toHaveBeenCalledWith(nov11.find((r) => r.payee === "BIEDRONKA")?.gid);
  });

  it("narrows to the payments still to categorize", async () => {
    const { current } = await show();
    await fireEvent.press(screen.getByRole("button", { name: "To categorize 2" }));
    const state = current();
    expect(state.filter).toBe("uncategorized");
    const rows = state.days.flatMap((d) => d.rows);
    expect(rows.map((r) => r.payee)).toEqual(["QUUX STUDIO", "QUUX STUDIO"]);
    expect(rows.every((r) => r.sub.kind === "uncategorized")).toBe(true);
    expect(screen.getAllByText("To categorize").length).toBeGreaterThan(1);
  });

  it("answers a search with the payee's years first, then the hits by day", async () => {
    const { current } = await show({ q: "warta" });
    const state = current();
    expect(state.mode).toBe("search");
    expect(state.results?.countLabel).toBe("3 payments");
    expect(state.results?.summary?.countLabel).toBe("3 payments since 2024");
    expect(
      state.results?.summary?.rows.map((r) => [r.year, r.amount.amount.toString(), r.vsPrevious]),
    ).toEqual([
      ["2026", "-1284.00", "+7.9% vs the year before"],
      ["2025", "-1190.00", "+8.0% vs the year before"],
      ["2024", "-1101.85", null],
    ]);
    expect(state.days.map((d) => [d.label, d.spent])).toEqual([
      ["Sat, Mar 14", null],
      ["Wed, Mar 12, 2025", null],
      ["Fri, Mar 15, 2024", null],
    ]);
    expect(screen.getByText("all history · searched on this phone")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Clear search" }));
    expect(current().mode).toBe("browse");
  });

  it("says when nothing matches", async () => {
    const { current } = await show({ q: "zzz" });
    expect(current().empty).toBe('No payments match "zzz".');
    expect(screen.getByText('No payments match "zzz".')).toBeOnTheScreen();
  });

  it("filters to a category from Spending until the tag is removed", async () => {
    const { current } = await show({ category: "groceries" });
    expect(current().categoryFilter?.label).toBe("Groceries");
    expect(current().days.flatMap((d) => d.rows.map((r) => r.payee))).toEqual(["BIEDRONKA"]);
    await fireEvent.press(screen.getByRole("button", { name: "Remove the Groceries filter" }));
    expect(current().categoryFilter).toBeNull();
    await act(() => {});
    expect(current().days.flatMap((d) => d.rows).length).toBeGreaterThan(1);
  });
});

const stories: [string, object][] = [
  ["browse", Browse.args],
  ["category from spending", CategoryFromSpending.args],
  ["search with summary", SearchWithSummary.args],
  ["search no match", SearchNoMatch.args],
  ["empty", Empty.args],
  ["partner without cash", PartnerWithoutCash.args],
  ["longest page", LongestPage.args],
  ["loading more", LoadingMore.args],
];

it.each(stories)("renders the %s story", async (_name, args) => {
  const View = activityMeta.component as ComponentType<object>;
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <View {...activityMeta.args} {...args} />
    </UiEnvProvider>,
  );
  expect(screen.root).toBeOnTheScreen();
});
