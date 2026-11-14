// The Today hook and the month-closed state over the real synchronous store (moneyStore kit: real
// queries, SQLite and domain math; only `Date` is pinned to Thu 12 Nov 2026), then every story of
// both Views through the native renderer.
import { D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { setLanguageForTests } from "@cashu/i18n";
import { importStatement, setModules, setTransactionCategory } from "@cashu/store";
import { setMonthClosedSeen } from "@cashu/store/device";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { type ComponentType, type ReactNode, useEffect } from "react";
import { ServicesProvider } from "../../services/ServicesProvider";
import type { VaultSyncStatus } from "../../services/vaultEngine";
import monthClosedMeta, * as monthClosedStories from "../monthClosed/MonthClosedView.stories";
import {
  applyMoneyCommand,
  MONEY_OWN_A,
  MONEY_VAULT_A,
  type MoneyStore,
  moneyStore,
} from "../testing/moneyStore";
import { TodayView } from "./TodayView";
import todayMeta, * as todayStories from "./TodayView.stories";
import type { TodayState } from "./today-contracts";
import { useTodayScreen } from "./useTodayScreen";

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
  jest.clearAllMocks();
  jest.useFakeTimers({ now: new Date(2026, 10, 12, 12), doNotFake: [...NOT_DATE] });
  setLanguageForTests("en");
});
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
  jest.useRealTimers();
  setLanguageForTests("en");
});

function setup() {
  const fixture = moneyStore();
  closers.push(() => fixture.close());
  return fixture;
}

function Frame({
  fixture,
  privacy = false,
  children,
}: {
  fixture: MoneyStore;
  privacy?: boolean;
  children: ReactNode;
}) {
  return (
    <ServicesProvider services={fixture.services}>
      <StoreProvider client={fixture.client}>
        <ProfileProvider>
          <UiEnvProvider locale="en-US" privacy={privacy}>
            {children}
          </UiEnvProvider>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}

const openTriage = jest.fn();
const openSpending = jest.fn();
function TodayScreen({
  today,
  now,
  observed,
}: {
  today: string;
  now: string;
  observed: (state: TodayState) => void;
}) {
  const state = useTodayScreen({
    today,
    now,
    openTriage,
    openSpending,
    openProfile: () => {},
    openClosed: () => {},
  });
  useEffect(() => observed(state));
  return <TodayView state={state} />;
}

function categorize(fixture: MoneyStore, reference: string, category: string) {
  const txn = fixture.a.store.read<{ gid: string }>(
    "SELECT gid FROM transactions WHERE reference = ?",
    reference,
  )[0]?.gid;
  if (!txn) throw new Error(`missing synthetic transaction ${reference}`);
  applyMoneyCommand(fixture.a, setTransactionCategory, { txn, category });
}

interface Fact {
  readonly date: string;
  readonly amount: string;
  readonly key: string;
  readonly payee: string;
}

/** One statement of the PLN account with a payee per row (the kit's facts share one payee). */
function importFacts(fixture: MoneyStore, facts: readonly Fact[]) {
  const transactions: RawTransaction[] = facts.map((fact) => ({
    bookingDate: fact.date,
    valueDate: null,
    amount: D(fact.amount),
    currency: "PLN",
    counterpartyName: fact.payee,
    counterpartyIban: null,
    description: fact.key,
    reference: fact.key,
    bankTransactionId: null,
    source: "csv",
    raw: { synthetic: fact.key },
  }));
  applyMoneyCommand(fixture.a, importStatement, {
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

const CLOSED = ["2026-07", "2026-08", "2026-09", "2026-10"];

/**
 * Four closed months (July to October) of pay 1000 on the 20th, groceries 100 on the 1st and a train
 * 50 on the 2nd; November so far: groceries 100, a flight 200 and one small payment without a
 * category, no pay yet.
 */
function seedMonths(fixture: MoneyStore, extra: readonly Fact[] = []) {
  importFacts(fixture, [
    ...CLOSED.flatMap((m) => [
      { date: `${m}-20`, amount: "1000.00", key: `pay-${m}`, payee: "Northwind" },
      { date: `${m}-01`, amount: "-100.00", key: `food-${m}`, payee: "Biedronka" },
      { date: `${m}-02`, amount: "-50.00", key: `trip-${m}`, payee: "PKP Intercity" },
    ]),
    { date: "2026-11-02", amount: "-100.00", key: "food-2026-11", payee: "Biedronka" },
    { date: "2026-11-03", amount: "-200.00", key: "trip-2026-11", payee: "LOT" },
    { date: "2026-11-04", amount: "-5.00", key: "small-2026-11", payee: "Kiosk" },
    ...extra,
  ]);
  for (const m of [...CLOSED, "2026-11"]) {
    categorize(fixture, `food-${m}`, "groceries");
    categorize(fixture, `trip-${m}`, "travel");
  }
  for (const m of CLOSED) categorize(fixture, `pay-${m}`, "income_salary");
}

/** An hour after the newest import: the bank data is fresh. */
function freshNow(fixture: MoneyStore): string {
  const at = fixture.a.store.read<{ at: string }>(
    "SELECT finished_at AS at FROM import_batches ORDER BY finished_at DESC LIMIT 1",
  )[0]?.at;
  if (at === undefined) throw new Error("no synthetic import batch");
  return new Date(Date.parse(at) + 3_600_000).toISOString();
}

const plain = (text: string) => text.replace(/[  ]/gu, " ");

function ready(state: TodayState | undefined) {
  if (state?.kind !== "ready") throw new Error(`expected the running month, got ${state?.kind}`);
  return state;
}
function closedState(state: TodayState | undefined) {
  if (state?.kind !== "closed") throw new Error(`expected the closed month, got ${state?.kind}`);
  return state;
}

describe("Today over the real store", () => {
  it("projects the month, its pace and the quiet uncategorized line", async () => {
    const fixture = setup();
    // A monthly bill on the 15th: still due on the 12th.
    seedMonths(
      fixture,
      CLOSED.map((m) => ({
        date: `${m}-15`,
        amount: "-43.00",
        key: `bill-${m}`,
        payee: "Synthetic Stream",
      })),
    );
    for (const m of CLOSED) categorize(fixture, `bill-${m}`, "subscriptions");
    let state: TodayState | undefined;
    await render(
      <Frame fixture={fixture}>
        <TodayScreen
          today="2026-11-12"
          now={freshNow(fixture)}
          observed={(s) => {
            state = s;
          }}
        />
      </Frame>,
    );
    const today = ready(state);
    expect(today.title).toBe("November");
    expect(today.hero.daysLeftLabel).toBe("18 days to go");
    expect(today.hero.kpis.map((k) => [k.label, k.value.amount.toString()])).toEqual([
      ["Income", "0.00"],
      ["Spent", "305.00"],
      ["Bills still due", "43.00"],
    ]);
    // Pay of 1000 still expected (usual pay day 20), spent 305, nothing more usual to come.
    expect(today.hero.subLine).toBe(
      "by November 30, if the rest of the month goes like usual · incl. your usual pay on the 20th",
    );
    // Pay 1000 still expected, minus 305 spent and the bill of 43 still due.
    expect(today.hero.keep.amount.toString()).toBe("652.00");
    expect(today.hero.negative).toBe(false);
    expect(plain(today.hero.pace?.right ?? "")).toBe("PLN 155 over usual so far");
    expect(today.hero.pace?.rightTone).toBe("default");
    expect(today.attention).toEqual([]);
    expect(today.uncategorized?.count).toBe(1);
    expect(today.uncategorized?.sum.amount.toString()).toBe("5.00");
    expect(today.spent.rows.map((r) => [r.category, r.share])).toEqual([
      ["travel", 1],
      ["groceries", 0.5],
      ["other", 0.025],
    ]);
    expect(today.spent.more).toBeNull();
    expect(today.note).toBe(
      "Bank data comes from your Mac once a day - this phone never asks your bank on its own. Prices it fetches itself.",
    );
    expect(screen.getByText("On track to keep")).toBeOnTheScreen();
    expect(screen.queryByText("Worth a look")).toBeNull();
    await fireEvent.press(screen.getByText("Categorize"));
    expect(openTriage).toHaveBeenCalledWith({ month: "2026-11", currency: "PLN" });
    await fireEvent.press(screen.getByText("All categories"));
    expect(openSpending).toHaveBeenCalledWith("2026-11");
  });

  it("raises a large uncategorized sum to Worth a look and drops the quiet line", async () => {
    const fixture = setup();
    seedMonths(fixture, [
      { date: "2026-11-10", amount: "-200.00", key: "big-2026-11", payee: "Synthetic shop" },
    ]);
    let state: TodayState | undefined;
    await render(
      <Frame fixture={fixture}>
        <TodayScreen
          today="2026-11-12"
          now={freshNow(fixture)}
          observed={(s) => {
            state = s;
          }}
        />
      </Frame>,
    );
    const today = ready(state);
    expect(today.attention.map((r) => [r.icon, r.tone, plain(r.title), r.magnitude])).toEqual([
      ["tag", "warn", "PLN 205 not categorized", "41%"],
    ]);
    expect(today.uncategorized).toBeNull();
    await fireEvent.press(screen.getByText(today.attention[0]?.title ?? ""));
    expect(openTriage).toHaveBeenCalledWith({ month: "2026-11", currency: "PLN" });
  });

  it("shows the stale banner, fades the hero and says as of when", async () => {
    const fixture = setup();
    seedMonths(fixture);
    let state: TodayState | undefined;
    await render(
      <Frame fixture={fixture}>
        <TodayScreen
          today="2026-11-12"
          now="2026-11-12T12:00:00.000Z"
          observed={(s) => {
            state = s;
          }}
        />
      </Frame>,
    );
    const today = ready(state);
    expect(today.stale).toBe(true);
    expect(today.banner?.title).toMatch(/^Bank data is \d+ days old$/u);
    expect(today.hero.subLine).toMatch(/ · as of /u);
    expect(today.hero.pace?.right).toMatch(/^pace as of /u);
    expect(screen.getByText(today.banner?.title ?? "")).toBeOnTheScreen();
  });

  it("hides the money of the copy in privacy mode", async () => {
    const fixture = setup();
    seedMonths(fixture);
    let state: TodayState | undefined;
    await render(
      <Frame fixture={fixture} privacy>
        <TodayScreen
          today="2026-11-12"
          now={freshNow(fixture)}
          observed={(s) => {
            state = s;
          }}
        />
      </Frame>,
    );
    expect(ready(state).hero.pace?.right).toBe("••• over usual so far");
    expect(JSON.stringify(screen.toJSON())).not.toContain("305");
  });
});

describe("the month-closed state over the real store", () => {
  it("takes Today's place in the first days and leaves it on request", async () => {
    const fixture = setup();
    seedMonths(fixture);
    let state: TodayState | undefined;
    await render(
      <Frame fixture={fixture}>
        <TodayScreen
          today="2026-11-02"
          now="2026-11-02T08:00:00.000Z"
          observed={(s) => {
            state = s;
          }}
        />
      </Frame>,
    );
    const closed = closedState(state);
    expect(closed.month).toBe("2026-10");
    expect(closed.title).toBe("October closed");
    expect(closed.hero.label).toBe("Kept in October");
    expect(closed.hero.surplus.amount.toString()).toBe("850.00");
    expect(closed.hero.savingsRate).toBe("savings rate 85%");
    expect(closed.strategy.kind).toBe("off");
    expect(screen.getByText(/Investing is not set up for this profile/u)).toBeOnTheScreen();
    expect(closed.categories.rows.map((r) => [r.key, r.vsUsual])).toEqual([
      ["groceries", { kind: "usual" }],
      ["travel", { kind: "usual" }],
    ]);
    await fireEvent.press(screen.getByText("Show the running month"));
    expect(state?.kind).toBe("ready");
    expect(
      fixture.device.read("SELECT value FROM device_settings WHERE key = 'monthClosedSeen'"),
    ).toEqual([{ value: JSON.stringify({ [MONEY_VAULT_A]: "2026-10" }) }]);
  });

  it("gives way to a sync state that asks the owner (QA: sync turned off on the Mac)", async () => {
    const fixture = setup();
    seedMonths(fixture);
    // The relay refused this phone on the last pass (403): the Mac turned sync off or removed it.
    const refused: VaultSyncStatus = {
      vault: MONEY_VAULT_A,
      phase: "ready",
      syncing: false,
      remote: true,
      unpushed: false,
      failure: "relay_unreachable",
      relay: {
        lastOk: Date.parse("2026-11-01T18:00:00Z"),
        lastError: "forbidden",
        lastErrorAt: Date.parse("2026-11-02T07:00:00Z"),
      },
    };
    const synced: MoneyStore = {
      ...fixture,
      services: {
        ...fixture.services,
        vaults: {
          ...fixture.services.vaults,
          unavailable: (vault) => (vault === MONEY_VAULT_A ? refused : undefined),
        },
      },
    };
    let state: TodayState | undefined;
    await render(
      <Frame fixture={synced}>
        <TodayScreen
          today="2026-11-02"
          now="2026-11-02T08:00:00.000Z"
          observed={(s) => {
            state = s;
          }}
        />
      </Frame>,
    );
    expect(ready(state).sync.notice?.kind).toBe("syncOff");
    expect(
      screen.getByText(
        "Sync for Synthetic A was turned off on your Mac. The copy on this phone stays until you remove it.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Keep for now" })).toBeOnTheScreen();
  });

  it("keeps the quiet sync line under its header (QA: paused never showed in a month's first days)", async () => {
    const fixture = setup();
    seedMonths(fixture);
    // The relay was out on the last pass: a paused line, not a notice, so the closed month stays.
    const out: VaultSyncStatus = {
      vault: MONEY_VAULT_A,
      phase: "ready",
      syncing: false,
      remote: true,
      unpushed: false,
      relay: {
        lastOk: new Date(2026, 10, 2, 7, 5).getTime(),
        lastError: "unavailable",
        lastErrorAt: new Date(2026, 10, 2, 7, 30).getTime(),
      },
    };
    const paused: MoneyStore = {
      ...fixture,
      services: {
        ...fixture.services,
        vaults: {
          ...fixture.services.vaults,
          unavailable: (vault) => (vault === MONEY_VAULT_A ? out : undefined),
        },
      },
    };
    let state: TodayState | undefined;
    await render(
      <Frame fixture={paused}>
        <TodayScreen
          today="2026-11-02"
          now="2026-11-02T08:00:00.000Z"
          observed={(s) => {
            state = s;
          }}
        />
      </Frame>,
    );
    expect(closedState(state).title).toBe("October closed");
    expect(screen.getByText("Sync paused since 07:05 · cashU works as usual")).toBeOnTheScreen();
  });

  it("remembers the running month on this device until a later month closes", async () => {
    const fixture = setup();
    seedMonths(fixture);
    applyMoneyCommand(fixture.a, setModules, { moduleIds: ["budget", "investments"] });
    fixture.device.run(setMonthClosedSeen, { vault: MONEY_VAULT_A, month: "2026-10" });
    let state: TodayState | undefined;
    const observed = (s: TodayState) => {
      state = s;
    };
    const view = await render(
      <Frame fixture={fixture}>
        <TodayScreen today="2026-11-02" now="2026-11-02T08:00:00.000Z" observed={observed} />
      </Frame>,
    );
    // Put away for October although no plan is saved: the running month on every start.
    expect(state?.kind).toBe("ready");
    importFacts(fixture, [
      { date: "2026-11-20", amount: "1000.00", key: "pay-2026-11", payee: "Northwind" },
    ]);
    await view.rerender(
      <Frame fixture={fixture}>
        <TodayScreen today="2026-12-02" now="2026-12-02T08:00:00.000Z" observed={observed} />
      </Frame>,
    );
    expect(closedState(state).month).toBe("2026-11");
  });

  it("turns into the closed month when the day crosses into a new month", async () => {
    const fixture = setup();
    seedMonths(fixture);
    let state: TodayState | undefined;
    const observed = (s: TodayState) => {
      state = s;
    };
    const view = await render(
      <Frame fixture={fixture}>
        <TodayScreen today="2026-10-31" now="2026-10-31T20:00:00.000Z" observed={observed} />
      </Frame>,
    );
    expect(ready(state).title).toBe("October");
    await view.rerender(
      <Frame fixture={fixture}>
        <TodayScreen today="2026-11-01" now="2026-11-01T00:00:01.000Z" observed={observed} />
      </Frame>,
    );
    expect(closedState(state).month).toBe("2026-10");
  });

  it("is gone after the third day when there is nothing to plan", async () => {
    const fixture = setup();
    seedMonths(fixture);
    let state: TodayState | undefined;
    await render(
      <Frame fixture={fixture}>
        <TodayScreen
          today="2026-11-04"
          now="2026-11-04T08:00:00.000Z"
          observed={(s) => {
            state = s;
          }}
        />
      </Frame>,
    );
    expect(state?.kind).toBe("ready");
  });

  it("with investing, stays until the plan for the month is saved", async () => {
    const fixture = setup();
    seedMonths(fixture);
    applyMoneyCommand(fixture.a, setModules, { moduleIds: ["budget", "investments"] });
    let state: TodayState | undefined;
    await render(
      <Frame fixture={fixture}>
        <TodayScreen
          today="2026-11-12"
          now={freshNow(fixture)}
          observed={(s) => {
            state = s;
          }}
        />
      </Frame>,
    );
    const open = closedState(state).strategy;
    if (open.kind !== "open") throw new Error(`expected an open plan, got ${open.kind}`);
    expect(plain(open.planLabel ?? "")).toBe("Plan PLN 850");
    await fireEvent.press(screen.getByText(open.planLabel ?? ""));
    expect(
      fixture.a.store.read(
        "SELECT amount, planned_date AS date, currency FROM inv_planned_deposits",
      ),
    ).toEqual([{ amount: "850.00", date: "2026-11-01", currency: "PLN" }]);
    // Saved after the third day: Today shows the running month.
    expect(ready(state).title).toBe("November");
  });

  it("quotes the saved plan in the first days; Undo cancels it", async () => {
    const fixture = setup();
    seedMonths(fixture);
    applyMoneyCommand(fixture.a, setModules, { moduleIds: ["budget", "investments"] });
    let state: TodayState | undefined;
    await render(
      <Frame fixture={fixture}>
        <TodayScreen
          today="2026-11-02"
          now="2026-11-02T08:00:00.000Z"
          observed={(s) => {
            state = s;
          }}
        />
      </Frame>,
    );
    await fireEvent.press(screen.getByText(/^Plan /u));
    const quoted = closedState(state).strategy;
    if (quoted.kind !== "planned") throw new Error(`expected a plan, got ${quoted.kind}`);
    expect(plain(quoted.quote)).toBe("Planned PLN 850 for November.");
    await fireEvent.press(screen.getByText("Undo"));
    expect(closedState(state).strategy.kind).toBe("open");
    expect(fixture.a.store.read("SELECT status FROM inv_planned_deposits")).toEqual([
      { status: "cancelled" },
    ]);
  });

  it("saves another amount and refuses an empty one", async () => {
    const fixture = setup();
    seedMonths(fixture);
    applyMoneyCommand(fixture.a, setModules, { moduleIds: ["budget", "investments"] });
    let state: TodayState | undefined;
    await render(
      <Frame fixture={fixture}>
        <TodayScreen
          today="2026-11-02"
          now="2026-11-02T08:00:00.000Z"
          observed={(s) => {
            state = s;
          }}
        />
      </Frame>,
    );
    await fireEvent.press(screen.getByText("Other amount"));
    await fireEvent.press(screen.getByText("Save"));
    expect(screen.getByText("Enter an amount above zero")).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText("Amount"), "300");
    await fireEvent.press(screen.getByText("Save"));
    const quoted = closedState(state).strategy;
    expect(quoted.kind).toBe("planned");
    if (quoted.kind === "planned")
      expect(plain(quoted.quote)).toBe("Planned PLN 300 for November.");
  });
});

// Every story of both Views by name: a new story must be added here (CSF named exports).
const STORIES: [string, ComponentType<never>, object, Record<string, unknown>][] = [
  ["TodayView", todayMeta.component, todayMeta.args, todayStories],
  ["MonthClosedView", monthClosedMeta.component, monthClosedMeta.args, monthClosedStories],
];

describe.each(STORIES)("%s stories", (_view, component, base, stories) => {
  const Component = component as ComponentType<object>;
  const named = Object.entries(stories).filter(([name]) => name !== "default") as [
    string,
    { args: object; decorators?: unknown[] },
  ][];
  it.each(named)("%s renders", async (_name, story) => {
    // The only decorator of these stories hides amounts.
    await render(
      <UiEnvProvider locale="en-US" privacy={story.decorators !== undefined}>
        <Component {...base} {...story.args} />
      </UiEnvProvider>,
    );
    expect(screen.root).toBeOnTheScreen();
  });
});
