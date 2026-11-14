// The cash expense sheet's hook + View over isolated real event stores (the moneyStore kit): the keypad
// drives the amount, a save appends the cash expense on the chosen day to the cash wallet, refusals
// map to the sheet's own messages. Its stories render through the native View. All values are invented.
import { setLanguageForTests } from "@cashu/i18n";
import { addCashExpense } from "@cashu/store";
import { overviewCashWallet } from "@cashu/store/overview/cash";
import { ProfileProvider, StoreProvider, useProfile } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { type ComponentType, useEffect } from "react";
import { ServicesProvider } from "../../services/ServicesProvider";
import { applyMoneyCommand, type MoneyStore, moneyStore } from "../testing/moneyStore";
import { unknownOnce } from "../testing/unknownOnce";
import { S } from "./Cash.strings";
import { CashSheetView } from "./CashSheetView";
import cashMeta, { EmptyWallet, Incognito, NotSaved, TypedAmount } from "./CashSheetView.stories";
import { type CashSheetState, useCashSheet } from "./useCashSheet";

jest.mock("@expo/ui", () => require("../testing/expoUiMock").default);

const TODAY = "2026-11-12";

const close = jest.fn();
const closers: (() => void)[] = [];
beforeEach(() => {
  setLanguageForTests("en");
  close.mockClear();
});
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
});

function setup(): MoneyStore {
  const fixture = moneyStore();
  closers.push(() => fixture.close());
  return fixture;
}

function Sheet({ observed }: { observed: (state: CashSheetState) => void }) {
  const state = useCashSheet({ vault: useProfile(), today: TODAY, lang: "en", close });
  useEffect(() => observed(state));
  return <CashSheetView {...state} />;
}

async function open(fixture: MoneyStore, privacy = false) {
  const seen: { state?: CashSheetState } = {};
  await render(
    <ServicesProvider services={fixture.services}>
      <StoreProvider client={fixture.client}>
        <ProfileProvider>
          <UiEnvProvider locale="en-US" privacy={privacy}>
            <Sheet
              observed={(state) => {
                seen.state = state;
              }}
            />
          </UiEnvProvider>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>,
  );
  return {
    get state(): CashSheetState {
      if (seen.state === undefined) throw new Error("the sheet did not render");
      return seen.state;
    },
  };
}

const key = (name: string) => fireEvent.press(screen.getByRole("button", { name }));

describe("cash expense sheet with the real synchronous store", () => {
  it("types the amount on the keypad and starts a first wallet in the base currency", async () => {
    const fixture = setup();
    const sheet = await open(fixture);
    expect(sheet.state.wallet.exists).toBe(false);
    expect(sheet.state.grid.selected).toBe("groceries");
    expect(sheet.state.title.value).toBe("");
    expect(sheet.state.date.selected).toBe(TODAY);
    expect(sheet.state.date.options.map((o) => o.label)).toEqual([
      "Today",
      "Yesterday",
      "Tue",
      "Mon",
      "Sun",
      "Sat",
      "Fri",
    ]);
    expect(screen.getByText("A cash wallet is created with the first expense")).toBeOnTheScreen();
    for (const k of ["0", "4", "5", ".", "5", "0", "9"]) await key(k);
    expect(sheet.state.amount.text).toBe("45.50");
    await key("Delete");
    expect(sheet.state.amount.text).toBe("45.5");
    expect(sheet.state.amount.money?.amount.toString()).toBe("45.5");
    expect(sheet.state.amount.money?.currency).toBe("PLN");
    // Intl puts a no-break space between the currency and the digits.
    expect(sheet.state.addLabel.replace(/\s/gu, " ")).toBe("Add -PLN 45.50");
    expect(sheet.state.canSave).toBe(false);
  });

  it("adds the expense on the chosen day to the cash wallet and closes", async () => {
    const fixture = setup();
    const sheet = await open(fixture);
    for (const k of ["1", "2", ".", "4"]) await key(k);
    await fireEvent.changeText(screen.getByLabelText("What it was"), "Synthetic market stall");
    await key("Transport");
    // The day Seg is a tab list.
    await fireEvent.press(screen.getByRole("tab", { name: "Yesterday" }));
    expect(sheet.state.canSave).toBe(true);
    await key("Add -PLN 12.40");
    expect(close).toHaveBeenCalled();
    const wallet = fixture.a.store.read<{ n: number }>("SELECT count(*) AS n FROM transactions")[0];
    expect(wallet?.n).toBe(1);
    const view = fixture.a.store.read.bind(fixture.a.store);
    const cash = overviewCashWallet.run(view, {});
    expect(
      cash.transactions.map((r) => [r.date, r.amount.toString(), r.title, r.category]),
    ).toEqual([["2026-11-11", "-12.4", "Synthetic market stall", "transport"]]);
  });

  it("starts from the last cash expense and shows the wallet's balance", async () => {
    const fixture = setup();
    applyMoneyCommand(fixture.a, addCashExpense, {
      amount: "20.00",
      title: "Synthetic farm stand",
      category: "transport",
      onDate: "2026-11-10",
    });
    const sheet = await open(fixture);
    expect(sheet.state.wallet.exists).toBe(true);
    expect(sheet.state.wallet.balance.amount.toString()).toBe("-20.00");
    expect(sheet.state.grid.selected).toBe("transport");
    expect(sheet.state.title.value).toBe("Synthetic farm stand");
    expect(screen.getByText(/From your cash wallet/)).toBeOnTheScreen();
  });

  it("maps a refused save to the sheet's message and stays open", async () => {
    const fixture = setup();
    const sheet = await open(fixture);
    await key("5");
    await fireEvent.changeText(screen.getByLabelText("What it was"), "   ");
    // canSave guards the button; the hook still maps the command's refusal when called.
    await act(() => sheet.state.onSave());
    expect(sheet.state.error).toBe("Say what it was.");
    expect(screen.getByText("Say what it was.")).toBeOnTheScreen();
    expect(close).not.toHaveBeenCalled();
  });

  it("shows the typed digits, not bananas, while amounts are hidden", async () => {
    const fixture = setup();
    const sheet = await open(fixture, true);
    for (const k of ["4", "5"]) await key(k);
    expect(sheet.state.addLabel).toBe("Add expense");
    expect(screen.getByText("PLN 45")).toBeOnTheScreen();
  });
});

const stories: [
  string,
  { args: object; decorators?: readonly ((s: ComponentType) => unknown)[] },
][] = [
  ["empty wallet", EmptyWallet],
  ["typed amount", TypedAmount],
  ["not saved", NotSaved],
];

it.each(stories)("renders the %s story through the native View", async (_name, story) => {
  const View = cashMeta.component as ComponentType<object>;
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <View {...story.args} />
    </UiEnvProvider>,
  );
  expect(screen.root).toBeOnTheScreen();
});

it("renders the incognito story with the typed digits and no amount on the button", async () => {
  const View = cashMeta.component as ComponentType<object>;
  const [decorate] = Incognito.decorators;
  if (decorate === undefined) throw new Error("missing privacy decorator");
  await render(decorate(() => <View {...Incognito.args} />));
  expect(screen.getByText("PLN 45.5")).toBeOnTheScreen();
  expect(screen.getByText("Add expense")).toBeOnTheScreen();
  expect(screen.getAllByLabelText("Amount hidden").length).toBeGreaterThan(0);
});

describe("a save whose outcome was unknown (K2)", () => {
  async function openUnknownOnce() {
    const fixture = setup();
    const durable = unknownOnce(fixture);
    closers.push(() => durable.client.dispose());
    const seen: { state?: CashSheetState } = {};
    await render(
      <ServicesProvider services={durable.services}>
        <StoreProvider client={durable.client}>
          <ProfileProvider>
            <UiEnvProvider locale="en-US" privacy={false}>
              <Sheet
                observed={(state) => {
                  seen.state = state;
                }}
              />
            </UiEnvProvider>
          </ProfileProvider>
        </StoreProvider>
      </ServicesProvider>,
    );
    const state = () => {
      if (seen.state === undefined) throw new Error("the sheet did not render");
      return seen.state;
    };
    const rows = () =>
      overviewCashWallet
        .run(fixture.a.store.read.bind(fixture.a.store), {})
        .transactions.map((r) => r.amount.toString());
    return { durable, state, rows };
  }

  it("saving the same input again reports the first save and writes nothing twice", async () => {
    const { durable, state, rows } = await openUnknownOnce();
    for (const k of ["4", "2"]) await key(k);
    await fireEvent.changeText(screen.getByLabelText("What it was"), "Synthetic kiosk");
    await key("Add -PLN 42.00");
    expect(state().error).toBe("Could not save. Try again.");
    expect(close).not.toHaveBeenCalled();
    await key("Add -PLN 42.00");
    expect(close).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual(["-42"]);
    expect(durable.executed).toHaveLength(1);
  });

  it("a corrected input is neither reported as saved nor written on top; the sheet keeps it", async () => {
    const { durable, state, rows } = await openUnknownOnce();
    for (const k of ["4", "2"]) await key(k);
    await fireEvent.changeText(screen.getByLabelText("What it was"), "Synthetic kiosk");
    await key("Add -PLN 42.00");
    expect(state().error).toBe("Could not save. Try again.");
    // The owner corrects the amount after "Could not save".
    await key("5");
    await key("Add -PLN 425.00");
    expect(close).not.toHaveBeenCalled();
    expect(state().error).toBe("The first save went through. Check the entry before saving again.");
    expect(state().amount.text).toBe("425");
    expect(rows()).toEqual(["-42"]);
    expect(durable.executed).toHaveLength(1);
    // Saving the correction on purpose writes it once.
    await key("Add -PLN 425.00");
    expect(close).toHaveBeenCalledTimes(1);
    expect(rows().sort()).toEqual(["-42", "-425"]);
    expect(durable.executed).toHaveLength(2);
  });

  it("says it in Polish too", () => {
    setLanguageForTests("pl");
    expect(S.firstSaveWent).toBe(
      "Pierwszy zapis się udał. Sprawdź wpis przed ponownym zapisaniem.",
    );
  });
});
