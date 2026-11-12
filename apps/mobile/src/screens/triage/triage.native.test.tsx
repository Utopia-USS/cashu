// The categorize deck's hook + View over isolated real event stores (the moneyStore kit): picks file the
// payment and advance, the toggle pins the merchant, Skip moves a card to the end, and the deck ends
// on the done state. Its stories render through the native View. All payments are invented.
import { D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { setLanguageForTests } from "@cashu/i18n";
import { importStatement, setTransactionCategory } from "@cashu/store";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import type { VaultHandle } from "@cashu/store-react/local";
import { UiEnvProvider } from "@cashu/ui/native";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { type ComponentType, type ReactNode, useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ServicesProvider } from "../../services/ServicesProvider";
import { applyMoneyCommand, MONEY_OWN_A, type MoneyStore, moneyStore } from "../testing/moneyStore";
import { TriageView } from "./TriageView";
import triageMeta, {
  Done,
  DoneMoreLeft,
  Empty,
  LongDeck,
  NotSaved,
  WithoutSuggestion,
  WithSuggestion,
} from "./TriageView.stories";
import { type TriageScope, type TriageState, useTriageScreen } from "./useTriageScreen";

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

function setup(): MoneyStore {
  const fixture = moneyStore();
  closers.push(() => fixture.close());
  return fixture;
}

interface Payment {
  readonly date: string;
  readonly amount: string;
  readonly name: string;
  readonly key: string;
}

/** Bank payments with their own counterparty (the merchant), none categorized. */
function importPayments(handle: VaultHandle, payments: readonly Payment[]): void {
  const transactions: RawTransaction[] = payments.map((p) => ({
    bookingDate: p.date,
    valueDate: null,
    amount: D(p.amount),
    currency: "PLN",
    counterpartyName: p.name,
    counterpartyIban: null,
    description: p.key,
    reference: p.key,
    bankTransactionId: null,
    source: "csv",
    raw: { synthetic: p.key },
  }));
  applyMoneyCommand(handle, importStatement, {
    statement: {
      bank: "mbank",
      accountNumber: MONEY_OWN_A,
      accountName: "Synthetic account",
      currency: "PLN",
      transactions,
      balances: [],
      closingBalances: [],
    },
    newestDayRule: false,
  });
}

function categoryOf(fixture: MoneyStore, key: string) {
  return fixture.a.store.read<{ category: string | null; source: string }>(
    "SELECT category, category_source AS source FROM transactions WHERE reference = ?",
    key,
  )[0];
}

function gidOf(fixture: MoneyStore, key: string): string {
  const gid = fixture.a.store.read<{ gid: string }>(
    "SELECT gid FROM transactions WHERE reference = ?",
    key,
  )[0]?.gid;
  if (!gid) throw new Error(`missing synthetic payment ${key}`);
  return gid;
}

/** The app's root gives the card stack its gesture root; the tests do the same. */
function Env({ children }: { children: ReactNode }) {
  return (
    <GestureHandlerRootView>
      <UiEnvProvider locale="en-US" privacy={false}>
        {children}
      </UiEnvProvider>
    </GestureHandlerRootView>
  );
}

const close = jest.fn();
function Triage({
  scope,
  observed,
}: {
  scope: TriageScope;
  observed: (state: TriageState) => void;
}) {
  const state = useTriageScreen({ lang: "en", today: "2026-11-12", scope, close });
  useEffect(() => observed(state));
  return <TriageView {...state} />;
}

async function open(fixture: MoneyStore, scope: TriageScope = null) {
  const seen: { state?: TriageState } = {};
  await render(
    <ServicesProvider services={fixture.services}>
      <StoreProvider client={fixture.client}>
        <ProfileProvider>
          <Env>
            <Triage
              scope={scope}
              observed={(state) => {
                seen.state = state;
              }}
            />
          </Env>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>,
  );
  return {
    get state(): TriageState {
      if (seen.state === undefined) throw new Error("the deck did not render");
      return seen.state;
    },
    get card(): Extract<TriageState, { kind: "card" }> {
      const state = seen.state;
      if (state?.kind !== "card") throw new Error(`expected a card, got ${state?.kind}`);
      return state;
    },
  };
}

const THREE: Payment[] = [
  { date: "2026-11-11", amount: "-64.90", name: "Synthetic Alder", key: "alder-1" },
  { date: "2026-11-10", amount: "-129.99", name: "Synthetic Birch", key: "birch-1" },
  { date: "2026-11-09", amount: "-18.50", name: "Synthetic Cedar", key: "cedar-1" },
];

describe("categorize deck with the real synchronous store", () => {
  it("files the picked category and advances to the next card", async () => {
    const fixture = setup();
    importPayments(fixture.a, THREE);
    const deck = await open(fixture);
    expect(deck.card.card.payee).toBe("Synthetic Alder");
    expect(deck.card.card.amount.amount.toString()).toBe("-64.90");
    expect(deck.card.card.suggestion).toBeNull();
    expect(deck.card.next?.payee).toBe("Synthetic Birch");
    expect([deck.card.done, deck.card.total, deck.card.dots]).toEqual([0, 3, true]);
    expect(screen.getByText("1 of 3")).toBeOnTheScreen();
    expect(screen.getByText("Pick a category")).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole("button", { name: "Groceries" }));
    expect(categoryOf(fixture, "alder-1")).toEqual({ category: "groceries", source: "manual_txn" });
    expect(deck.card.card.payee).toBe("Synthetic Birch");
    expect([deck.card.done, deck.card.total]).toEqual([1, 3]);
    expect(screen.getByText("2 of 3")).toBeOnTheScreen();
  });

  it("offers the merchant's earlier category and files it with Use it", async () => {
    const fixture = setup();
    importPayments(fixture.a, [
      { date: "2026-11-11", amount: "-42.00", name: "Synthetic Alder", key: "alder-new" },
      { date: "2026-10-20", amount: "-38.00", name: "Synthetic Alder", key: "alder-old" },
    ]);
    applyMoneyCommand(fixture.a, setTransactionCategory, {
      txn: gidOf(fixture, "alder-old"),
      category: "dining",
    });
    const deck = await open(fixture);
    expect(deck.card.card.suggestion?.key).toBe("dining");
    expect(deck.card.grid.suggested).toBe("dining");
    expect(screen.getByText("Or pick another")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Use it"));
    expect(categoryOf(fixture, "alder-new")).toEqual({ category: "dining", source: "manual_txn" });
    expect(deck.state.kind).toBe("done");
  });

  it("pins the merchant with the toggle, which files its other payments too", async () => {
    const fixture = setup();
    importPayments(fixture.a, [
      { date: "2026-11-11", amount: "-12.00", name: "Synthetic Maple", key: "maple-1" },
      { date: "2026-11-10", amount: "-50.00", name: "Synthetic Birch", key: "birch-1" },
      { date: "2026-11-09", amount: "-9.00", name: "Synthetic Maple", key: "maple-2" },
    ]);
    const deck = await open(fixture);
    const rule = deck.card.rule;
    expect(rule?.label).toBe("Same for every Synthetic Maple payment");
    expect(rule?.sub).toBe("Also past and future ones (2 so far)");
    await act(() => rule?.onToggle(true));
    expect(deck.card.rule?.on).toBe(true);
    await fireEvent.press(screen.getByRole("button", { name: "Groceries" }));

    const rules = fixture.a.store.read<{ category: string; locked: number; source: string }>(
      "SELECT category, locked, source FROM category_rules",
    );
    expect(rules).toEqual([{ category: "groceries", locked: 1, source: "manual" }]);
    expect(categoryOf(fixture, "maple-2")?.category).toBe("groceries");
    // The other Maple payment left the deck with the rule: only the Birch payment is left.
    expect(deck.card.card.payee).toBe("Synthetic Birch");
    expect([deck.card.done, deck.card.total]).toEqual([2, 3]);
    expect(deck.card.rule?.on).toBe(false);
  });

  it("moves a skipped card to the end of the deck", async () => {
    const fixture = setup();
    importPayments(fixture.a, THREE);
    const deck = await open(fixture);
    await fireEvent.press(screen.getByText("Skip"));
    expect(deck.card.card.payee).toBe("Synthetic Birch");
    expect(deck.card.done).toBe(0);
    await fireEvent.press(screen.getByRole("button", { name: "Transport" }));
    expect(deck.card.card.payee).toBe("Synthetic Cedar");
    expect(deck.card.next?.payee).toBe("Synthetic Alder");
    await fireEvent.press(screen.getByRole("button", { name: "Transport" }));
    expect(deck.card.card.payee).toBe("Synthetic Alder");
    expect(deck.card.next).toBeNull();
  });

  it("ends on the done state after the last card", async () => {
    const fixture = setup();
    importPayments(fixture.a, [THREE[0] as Payment]);
    const deck = await open(fixture);
    await fireEvent.press(screen.getByRole("button", { name: "Transport" }));
    expect(deck.state).toMatchObject({ kind: "done", count: 1 });
    expect(screen.getByText("All categorized")).toBeOnTheScreen();
    expect(
      screen.getByText("1 payment done. Your other devices see it at the next sync."),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Done"));
    expect(close).toHaveBeenCalled();
  });

  it("deals only the month and currency Today counted, with the scope's total", async () => {
    const fixture = setup();
    importPayments(fixture.a, [
      ...THREE,
      { date: "2026-10-30", amount: "-77.00", name: "Synthetic Elm", key: "elm-old" },
    ]);
    const deck = await open(fixture, { month: "2026-11", currency: "PLN" });
    expect([deck.card.done, deck.card.total]).toEqual([0, 3]);
    for (const _ of THREE) await fireEvent.press(screen.getByRole("button", { name: "Transport" }));
    expect(deck.state).toMatchObject({ kind: "done", count: 3, left: 0, onContinue: null });
    expect(categoryOf(fixture, "elm-old")).toEqual({ category: "other", source: "default" });
  });

  it("shows a long deck without dots and deals the next page when the first runs out", async () => {
    const fixture = setup();
    const many: Payment[] = Array.from({ length: 52 }, (_, i) => ({
      date: `2026-11-${String((i % 11) + 1).padStart(2, "0")}`,
      amount: `-${i + 1}.00`,
      name: `Synthetic Shop ${i}`,
      key: `shop-${i}`,
    }));
    importPayments(fixture.a, many);
    const deck = await open(fixture);
    expect([deck.card.total, deck.card.dots]).toEqual([52, false]);
    expect(screen.getByText("1 of 52")).toBeOnTheScreen();
    for (let i = 0; i < 50; i += 1) {
      await fireEvent.press(screen.getByRole("button", { name: "Transport" }));
    }
    const done = deck.state;
    if (done.kind !== "done") throw new Error(`expected the done state, got ${done.kind}`);
    expect([done.count, done.left]).toEqual([50, 2]);
    expect(screen.getByText(/2 more payments are still without a category\./u)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Continue"));
    expect([deck.card.done, deck.card.total]).toEqual([50, 52]);
    expect(screen.getByText("51 of 52")).toBeOnTheScreen();
  });

  it("is empty when nothing waits for a category", async () => {
    const fixture = setup();
    const deck = await open(fixture);
    expect(deck.state.kind).toBe("empty");
    expect(screen.getByText("Nothing to categorize")).toBeOnTheScreen();
  });
});

const stories: [string, { args: object }][] = [
  ["with suggestion", WithSuggestion],
  ["without suggestion", WithoutSuggestion],
  ["not saved", NotSaved],
  ["long deck", LongDeck],
  ["done", Done],
  ["done with more left", DoneMoreLeft],
  ["empty", Empty],
];

it.each(stories)("renders the %s story through the native View", async (_name, story) => {
  const View = triageMeta.component as ComponentType<object>;
  await render(
    <Env>
      <View {...story.args} />
    </Env>,
  );
  expect(screen.root).toBeOnTheScreen();
});

it("puts the grid right under the amount when there is no suggestion", async () => {
  const View = triageMeta.component as ComponentType<object>;
  await render(
    <Env>
      <View {...WithoutSuggestion.args} />
    </Env>,
  );
  expect(screen.queryByText("Use it")).toBeNull();
  expect(screen.getByText("No suggestion yet - pick one below")).toBeOnTheScreen();
  expect(screen.getByText("Pick a category")).toBeOnTheScreen();
  expect(screen.queryByRole("switch")).toBeNull();
});
