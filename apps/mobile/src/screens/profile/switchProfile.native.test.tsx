// A profile switch never lets a sheet or modal of the previous profile write into the new one (K1, rule 7):
// the switch dismisses every sheet and modal and resets the tab stacks before the vault changes (the
// notification tap goes through it), a switch from elsewhere is caught by the tabs layout and by the pinned
// route, and each sheet's commands write to the vault it was opened with. Real route files (the tabs layout,
// the review modal, the cash and payment sheets) under expo-router's test router over real synthetic stores.
import { setLanguageForTests } from "@cashu/i18n";
import { setCurrentVault } from "@cashu/store/device";
import { lastReview } from "@cashu/store/investments/queries";
import { ProfileProvider, StoreProvider, useProfile } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import { render } from "@testing-library/react-native";
import { type Href, router, Stack } from "expo-router";
import { act, renderRouter, screen } from "expo-router/testing-library";
import { type ReactNode, useEffect } from "react";
import { Text } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import TabsLayout from "../../../app/(tabs)/_layout";
import ReviewRoute from "../../../app/modal/review";
import TriageRoute from "../../../app/modal/triage";
import AlertSheetRoute from "../../../app/sheet/alert/[gid]";
import CashSheetRoute from "../../../app/sheet/cash";
import PaymentSheetRoute from "../../../app/sheet/payment/[gid]";
import { useNotificationResponse } from "../../notifications/useNotificationResponse";
import { ServicesProvider } from "../../services/ServicesProvider";
import type { Services } from "../../services/services";
import type { CashSheetState } from "../cash/useCashSheet";
import type { ReviewDeckState } from "../review/useReviewDeck";
import { useReviewDeck } from "../review/useReviewDeck";
import {
  INVESTMENTS_OTHER_VAULT,
  INVESTMENTS_VAULT,
  investmentsStore,
} from "../testing/investmentsStore";
import {
  importMoneyFacts,
  MONEY_OWN_A,
  MONEY_VAULT_A,
  MONEY_VAULT_B,
  moneyStore,
} from "../testing/moneyStore";
import { freshNavigationState, usePinnedVault, useSwitchProfile } from "./switchProfile";

jest.mock("@expo/ui", () => require("../testing/expoUiMock").default);
// The investments kit builds its synthetic vault once per file: slow on a loaded machine.
jest.setTimeout(60_000);

/** The kits' calendar day, for every route (the real clock would move the decks' content). */
jest.mock("../../shell/useNow", () => ({
  useNow: () => ({ today: "2026-11-12", now: "2026-11-12T08:40:00.000Z" }),
}));

/** The platform half replaced by a tap the test sets (no expo-notifications in Jest). */
jest.mock("../../platform/notifications", () => {
  const { useSyncExternalStore } = require("react");
  let tap: { key: string; data: Record<string, string> } | null = null;
  const listeners = new Set<() => void>();
  const set = (next: typeof tap) => {
    tap = next;
    for (const listener of listeners) listener();
  };
  return {
    useNotificationTap: () =>
      useSyncExternalStore(
        (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => tap,
      ),
    clearNotificationTap: jest.fn(() => set(null)),
    mockSetTap: set,
  };
});
const platform = jest.requireMock("../../platform/notifications") as {
  mockSetTap(tap: { key: string; data: Record<string, string> } | null): void;
};

/** The latest props each sheet's View rendered with (the real Views render them); set by the mocks. */
interface Shown {
  review?: ReviewDeckState;
  cash?: CashSheetState;
}
const holder = globalThis as { switchProfileShown?: Shown };
holder.switchProfileShown ??= {};
const shown: Shown = holder.switchProfileShown;
jest.mock("../review/ReviewDeckView", () => {
  const actual = jest.requireActual("../review/ReviewDeckView");
  const { createElement } = require("react");
  return {
    ...actual,
    ReviewDeckView: (props: ReviewDeckState) => {
      const holder = globalThis as { switchProfileShown?: { review?: unknown } };
      holder.switchProfileShown ??= {};
      holder.switchProfileShown.review = props;
      return createElement(actual.ReviewDeckView, props);
    },
  };
});
jest.mock("../cash/CashSheetView", () => {
  const actual = jest.requireActual("../cash/CashSheetView");
  const { createElement } = require("react");
  return {
    ...actual,
    CashSheetView: (props: CashSheetState) => {
      const holder = globalThis as { switchProfileShown?: { cash?: unknown } };
      holder.switchProfileShown ??= {};
      holder.switchProfileShown.cash = props;
      return createElement(actual.CashSheetView, props);
    },
  };
});

const closers: (() => void)[] = [];
beforeEach(() => {
  setLanguageForTests("en");
  delete shown.review;
  delete shown.cash;
});
afterEach(() => {
  for (const close of closers.splice(0)) close();
  platform.mockSetTap(null);
});

function Taps() {
  useNotificationResponse();
  return <Text>{`profile ${useProfile()}`}</Text>;
}

const tabRoutes = {
  "(tabs)/_layout": TabsLayout,
  "(tabs)/today/_layout": () => <Stack />,
  "(tabs)/today/index": () => <Text>today root</Text>,
  "(tabs)/today/closed": () => <Text>closed page</Text>,
  "(tabs)/activity/index": () => <Text>activity root</Text>,
  "(tabs)/investments/index": () => <Text>investments root</Text>,
  "(tabs)/networth/index": () => <Text>networth root</Text>,
};

async function show(services: Services, routes: Record<string, () => ReactNode>, url: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GestureHandlerRootView>
      <ServicesProvider services={services}>
        <StoreProvider client={services.client}>
          <ProfileProvider>
            <UiEnvProvider locale="en-US" privacy={false}>
              {children}
            </UiEnvProvider>
          </ProfileProvider>
        </StoreProvider>
      </ServicesProvider>
    </GestureHandlerRootView>
  );
  await renderRouter(
    {
      _layout: () => (
        <>
          <Taps />
          <Stack />
        </>
      ),
      ...tabRoutes,
      ...routes,
    },
    { initialUrl: "/today", wrapper },
  );
  // Opened over the tabs, as in the app (the start redirects to Today first).
  await act(() => router.push(url as Href));
}

const tap = (vault: string, kind: string, extra: Record<string, string> = {}) =>
  act(async () => {
    platform.mockSetTap({ key: `cashu.${vault}.${kind}@1`, data: { vault, kind, ...extra } });
  });

const press = (run: () => Promise<void> | void) =>
  act(async () => {
    await run();
  });

const count = (read: (sql: string) => { n: number }[], table: string) =>
  read(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0;

describe("a notification of the other profile while the review deck is open", () => {
  it("dismisses the deck before the switch; finishing it afterwards writes nothing into the new profile", async () => {
    const kit = investmentsStore({ otherProfile: true });
    closers.push(() => kit.close());
    const other = kit.other;
    if (other === null) throw new Error("expected the second profile");
    const readOther = (sql: string) => other.read<{ n: number }>(sql);
    const otherDecisions = count(readOther, "inv_decisions");

    await show(kit.services, { "modal/review": ReviewRoute }, "/modal/review?step=5");
    expect(screen).toHavePathname("/modal/review");
    // The decide card: a choice, then the summary of profile A's deck.
    await press(() => {
      const state = shown.review;
      if (state?.kind !== "card" || state.card.body.kind !== "decide") throw new Error("decide");
      state.card.body.rows[0]?.onChoose("held");
    });
    await press(() => {
      if (shown.review?.kind !== "card") throw new Error("card");
      return shown.review.onKeep();
    });
    const summary = shown.review;
    if (summary?.kind !== "summary") throw new Error(`expected the summary, got ${summary?.kind}`);

    await tap(INVESTMENTS_OTHER_VAULT, "month_closed", { month: "2026-10" });
    expect(screen.getByText(`profile ${INVESTMENTS_OTHER_VAULT}`)).toBeOnTheScreen();
    expect(screen).toHavePathname("/today/closed");
    expect(screen.queryByText("Weekly review")).toBeNull();

    // A tap on the summary's primary that was already on its way: it lands in A, the deck's profile.
    await press(summary.onDone);
    expect(lastReview(other.read.bind(other), "investments")).toBeUndefined();
    expect(count(readOther, "inv_decisions")).toBe(otherDecisions);
    expect(lastReview(kit.store.read.bind(kit.store), "investments")).toBeDefined();
  });
});

describe("the cash sheet with typed input when the profile changes", () => {
  it("is dismissed by a notification tap of the other profile and books nothing anywhere", async () => {
    const fixture = moneyStore();
    closers.push(() => fixture.close());
    await show(fixture.services, { "sheet/cash": CashSheetRoute }, "/sheet/cash");
    await press(() => {
      const cash = shown.cash;
      if (cash === undefined) throw new Error("the cash sheet did not render");
      for (const key of ["4", "2"] as const) cash.amount.onKey(key);
    });
    await press(() => shown.cash?.title.onChange("Synthetic kiosk"));
    expect(shown.cash?.canSave).toBe(true);

    await tap(MONEY_VAULT_B, "weekly");
    expect(screen.getByText(`profile ${MONEY_VAULT_B}`)).toBeOnTheScreen();
    expect(screen).toHavePathname("/today");
    expect(screen.queryByLabelText("What it was")).toBeNull();
    for (const vault of [fixture.a, fixture.b])
      expect(count((sql) => vault.store.read<{ n: number }>(sql), "transactions")).toBe(
        vault === fixture.a ? countA : countB,
      );
  });

  it("is dismissed by a switch from anywhere else (the device command alone)", async () => {
    const fixture = moneyStore();
    closers.push(() => fixture.close());
    await show(fixture.services, { "sheet/cash": CashSheetRoute }, "/sheet/cash");
    expect(screen.getByLabelText("What it was")).toBeOnTheScreen();
    await act(() => {
      fixture.device.run(setCurrentVault, { vault: MONEY_VAULT_B });
    });
    expect(screen).toHavePathname("/today");
    expect(screen.queryByLabelText("What it was")).toBeNull();
  });
});

// The transactions each money vault starts with (the fixture's imports), read once.
let countA = 0;
let countB = 0;
beforeAll(() => {
  const fixture = moneyStore();
  countA = count((sql) => fixture.a.store.read<{ n: number }>(sql), "transactions");
  countB = count((sql) => fixture.b.store.read<{ n: number }>(sql), "transactions");
  fixture.close();
});

describe("the payment sheet when a notification of the other profile is tapped", () => {
  it("is dismissed and its category was never written into the other profile", async () => {
    const fixture = moneyStore();
    closers.push(() => fixture.close());
    importMoneyFacts(fixture.a, "PLN", MONEY_OWN_A, [
      { date: "2026-11-10", amount: "-12.00", key: "synthetic-kiosk-1" },
    ]);
    const gid = fixture.a.store.read<{ gid: string }>(
      "SELECT gid FROM transactions WHERE reference = ?",
      "synthetic-kiosk-1",
    )[0]?.gid;
    if (gid === undefined) throw new Error("expected a synthetic payment");
    await show(
      fixture.services,
      { "sheet/payment/[gid]": PaymentSheetRoute },
      `/sheet/payment/${gid}`,
    );
    expect(screen).toHavePathname(`/sheet/payment/${gid}`);
    const before = fixture.b.store.read<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions WHERE category IS NOT NULL",
    )[0]?.n;
    await tap(MONEY_VAULT_B, "weekly");
    expect(screen).toHavePathname("/today");
    expect(
      fixture.b.store.read<{ n: number }>(
        "SELECT COUNT(*) AS n FROM transactions WHERE category IS NOT NULL",
      )[0]?.n,
    ).toBe(before);
  });
});

/** Hands the test the app's one switch. */
function Switcher() {
  const switchProfile = useSwitchProfile();
  const vault = useProfile();
  useEffect(() => {
    (globalThis as { switchTo?: (v: string) => unknown }).switchTo = switchProfile.run;
  });
  return <Text>{`profile ${vault}`}</Text>;
}

describe("the alert sheet and the categorize deck when a notification of the other profile is tapped", () => {
  it("dismisses the alert sheet; the other profile gets no decision and no mark", async () => {
    const kit = investmentsStore({ otherProfile: true });
    closers.push(() => kit.close());
    const other = kit.other;
    if (other === null) throw new Error("expected the second profile");
    const gid = kit.store.read<{ gid: string }>(
      "SELECT gid FROM inv_signals WHERE rule_id LIKE 'alert:%'",
    )[0]?.gid;
    if (gid === undefined) throw new Error("the synthetic alert did not fire");
    const readOther = (sql: string) => other.read<{ n: number }>(sql);
    const before = [count(readOther, "inv_decisions"), count(readOther, "inv_signals")];
    await show(kit.services, { "sheet/alert/[gid]": AlertSheetRoute }, `/sheet/alert/${gid}`);
    expect(screen).toHavePathname(`/sheet/alert/${gid}`);
    await tap(INVESTMENTS_OTHER_VAULT, "weekly");
    expect(screen.getByText(`profile ${INVESTMENTS_OTHER_VAULT}`)).toBeOnTheScreen();
    expect(screen).toHavePathname("/today");
    expect([count(readOther, "inv_decisions"), count(readOther, "inv_signals")]).toEqual(before);
  });

  it("dismisses the categorize deck; the other profile's payments keep their categories", async () => {
    const fixture = moneyStore();
    closers.push(() => fixture.close());
    const categorized = () =>
      fixture.b.store.read<{ n: number }>(
        "SELECT COUNT(*) AS n FROM transactions WHERE category IS NOT NULL",
      )[0]?.n;
    const before = categorized();
    await show(fixture.services, { "modal/triage": TriageRoute }, "/modal/triage");
    expect(screen).toHavePathname("/modal/triage");
    await tap(MONEY_VAULT_B, "weekly");
    expect(screen).toHavePathname("/today");
    expect(categorized()).toBe(before);
  });
});

describe("the one profile switch", () => {
  it("dismisses an unpinned sheet itself before it switches (no tabs layout, no pin)", async () => {
    const fixture = moneyStore();
    closers.push(() => fixture.close());
    await renderRouter(
      {
        _layout: () => (
          <>
            <Switcher />
            <Stack />
          </>
        ),
        index: () => <Text>start</Text>,
        "sheet/plain": () => <Text>plain sheet</Text>,
      },
      {
        initialUrl: "/sheet/plain",
        wrapper: ({ children }: { children: ReactNode }) => (
          <ServicesProvider services={fixture.services}>
            <StoreProvider client={fixture.client}>
              <ProfileProvider>{children}</ProfileProvider>
            </StoreProvider>
          </ServicesProvider>
        ),
      },
    );
    expect(screen.getByText("plain sheet")).toBeOnTheScreen();
    // Not awaited inside act: the switch waits for the navigation to take the reset, which act holds.
    let switched: Promise<unknown> = Promise.resolve();
    await act(async () => {
      switched = (globalThis as unknown as { switchTo: (v: string) => Promise<unknown> }).switchTo(
        MONEY_VAULT_B,
      );
    });
    await act(() => switched);
    expect(screen.getByText(`profile ${MONEY_VAULT_B}`)).toBeOnTheScreen();
    expect(screen.queryByText("plain sheet")).toBeNull();
    expect(screen.getByText("start")).toBeOnTheScreen();
  });
});

const deckSeen: { state?: ReviewDeckState } = {};
function PinnedDeck({ vault, today }: { vault: string; today: string }) {
  const state = useReviewDeck({ vault, today, lang: "en", step: 5, close: () => {} });
  useEffect(() => {
    deckSeen.state = state;
  });
  return null;
}

/** Every render of a pinned test sheet: the pin it got and the current profile then. */
const pinRenders: { pin: string | null; current: string }[] = [];
function PinnedProbe() {
  const pin = usePinnedVault();
  pinRenders.push({ pin, current: useProfile() });
  return <Text>{pin === null ? "nothing" : `pinned ${pin}`}</Text>;
}

describe("usePinnedVault", () => {
  it("gives the sheet no vault once the current profile is another one, and dismisses it", async () => {
    const fixture = moneyStore();
    closers.push(() => fixture.close());
    pinRenders.length = 0;
    await renderRouter(
      {
        _layout: () => <Stack />,
        index: () => <Text>start</Text>,
        "sheet/probe": PinnedProbe,
      },
      {
        initialUrl: "/sheet/probe",
        wrapper: ({ children }: { children: ReactNode }) => (
          <ServicesProvider services={fixture.services}>
            <StoreProvider client={fixture.client}>
              <ProfileProvider>{children}</ProfileProvider>
            </StoreProvider>
          </ServicesProvider>
        ),
      },
    );
    expect(screen.getByText(`pinned ${MONEY_VAULT_A}`)).toBeOnTheScreen();
    // A switch that did not go through the one switch (nothing dismissed first).
    await act(() => {
      fixture.device.run(setCurrentVault, { vault: MONEY_VAULT_B });
    });
    expect(screen.queryByText(`pinned ${MONEY_VAULT_A}`)).toBeNull();
    expect(screen.getByText("start")).toBeOnTheScreen();
    expect(pinRenders.filter((r) => r.current === MONEY_VAULT_B && r.pin !== null)).toEqual([]);
  });
});

describe("a sheet's commands write to the vault it was opened with (defence in depth)", () => {
  it("the review deck still mounted after a switch saves into its own profile, never the new one", async () => {
    const kit = investmentsStore({ otherProfile: true });
    closers.push(() => kit.close());
    const other = kit.other;
    if (other === null) throw new Error("expected the second profile");
    // Pinned to A by hand (no route guard here): the deck re-renders under B, as a guard that failed would.
    await render(
      <ServicesProvider services={kit.services}>
        <StoreProvider client={kit.client}>
          <ProfileProvider>
            <UiEnvProvider locale="en-US" privacy={false}>
              <PinnedDeck vault={INVESTMENTS_VAULT} today={kit.today} />
            </UiEnvProvider>
          </ProfileProvider>
        </StoreProvider>
      </ServicesProvider>,
    );
    await press(() => {
      const state = deckSeen.state;
      if (state?.kind !== "card" || state.card.body.kind !== "decide") throw new Error("decide");
      state.card.body.rows[0]?.onChoose("held");
    });
    await press(() => {
      if (deckSeen.state?.kind !== "card") throw new Error("card");
      return deckSeen.state.onKeep();
    });
    await act(() => {
      kit.device.run(setCurrentVault, { vault: INVESTMENTS_OTHER_VAULT });
    });
    // The handlers of the render under B.
    const summary = deckSeen.state;
    if (summary?.kind !== "summary") throw new Error(`expected the summary, got ${summary?.kind}`);
    await press(summary.onDone);
    expect(lastReview(other.read.bind(other), "investments")).toBeUndefined();
    expect(lastReview(kit.store.read.bind(kit.store), "investments")).toBeDefined();
  });
});

describe("freshNavigationState", () => {
  it("keeps the start and the tabs, drops every sheet and modal, and opens each tab on its root", () => {
    const state = {
      key: "root",
      index: 3,
      routes: [
        { key: "i", name: "index" },
        {
          key: "t",
          name: "(tabs)",
          state: {
            index: 1,
            routes: [
              {
                key: "t1",
                name: "today",
                state: { index: 1, routes: [{ name: "index" }, { name: "closed" }] },
              },
              { key: "t2", name: "activity", params: { filter: "x" } },
            ],
          },
        },
        { key: "s", name: "sheet/cash" },
        { key: "m", name: "modal/review", params: { step: "2" } },
      ],
    };
    expect(freshNavigationState(state)).toEqual({
      key: "root",
      index: 1,
      routes: [
        { key: "i", name: "index" },
        {
          key: "t",
          name: "(tabs)",
          state: {
            index: 1,
            routes: [
              { key: "t1", name: "today", params: undefined },
              { key: "t2", name: "activity", params: { filter: "x" } },
            ],
          },
        },
      ],
    });
  });

  it("walks through a navigator above the one that holds the tabs", () => {
    const state = {
      index: 0,
      routes: [
        {
          name: "__root",
          state: { index: 1, routes: [{ name: "(tabs)" }, { name: "sheet/alert/[gid]" }] },
        },
      ],
    };
    expect(freshNavigationState(state)).toEqual({
      index: 0,
      routes: [{ name: "__root", state: { index: 0, routes: [{ name: "(tabs)" }] } }],
    });
  });
});

it("keeps the investments kit's two profiles apart (oracle sanity)", () => {
  expect(INVESTMENTS_VAULT).not.toBe(INVESTMENTS_OTHER_VAULT);
  expect(MONEY_VAULT_A).not.toBe(MONEY_VAULT_B);
});
