// The position page's hook and View over the synthetic investments vault (the companion fixture's own
// builders): chart values converted from the store's Decimals, the owner's levels and figures masked
// while amounts are hidden, the range re-querying the history, the waiting alert leading to its sheet
// and noted once decided, research notes and decisions; and every story of the View. The calendar is
// pinned to Thu 12 Nov 2026.
import { D } from "@cashu/domain";
import { setLanguageForTests } from "@cashu/i18n";
import { signalsOwnerCommands } from "@cashu/store/investments/signals-screen";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { type ComponentType, type ReactNode, useEffect } from "react";
import { ServicesProvider } from "../../services/ServicesProvider";
import { type InvestmentsStore, investmentsStore } from "../testing/investmentsStore";
import { PositionView } from "./PositionView";
import positionMeta, {
  Decided,
  EtfWithoutThesis,
  HeldWithAlert,
  Incognito,
  NoStrategyYet,
  Unknown,
  WatchedNotHeld,
} from "./PositionView.stories";
import { type PositionState, quantityText, usePositionScreen } from "./usePositionScreen";

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
  jest.useFakeTimers({ now: new Date(2026, 10, 12, 9, 45), doNotFake: [...NOT_DATE] });
  setLanguageForTests("en");
});
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
  jest.useRealTimers();
});

function Frame({
  fixture,
  privacy,
  children,
}: {
  fixture: InvestmentsStore;
  privacy: boolean;
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

const openAlert = jest.fn();
const openNote = jest.fn();

function Page({
  fixture,
  gid,
  observed,
}: {
  fixture: InvestmentsStore;
  gid: string;
  observed(props: PositionState): void;
}) {
  const props = usePositionScreen({
    gid,
    lang: "en",
    today: fixture.today,
    now: fixture.now,
    openAlert,
    openNote,
  });
  useEffect(() => observed(props));
  return <PositionView {...props} />;
}

async function show(symbol: string | null, options: { privacy?: boolean } = {}) {
  const fixture = investmentsStore();
  closers.push(() => fixture.close());
  let props: PositionState | undefined;
  await render(
    <Frame fixture={fixture} privacy={options.privacy ?? false}>
      <Page
        fixture={fixture}
        gid={symbol === null ? "0".repeat(32) : fixture.instrument(symbol)}
        observed={(p) => {
          props = p;
        }}
      />
    </Frame>,
  );
  const ready = () => {
    if (props?.kind !== "ready") throw new Error("the position page is not ready");
    return props;
  };
  return { fixture, ready, current: () => props };
}

const textOf = (value: unknown) => String(value).replace(/\s/g, " ");

describe("the position page over the real synchronous store", () => {
  it("shows the held stock with its chart as plot numbers and the owner's levels", async () => {
    const { ready } = await show("CDR");
    const { hero, chart } = ready();
    expect(ready().title).toBe("CD Projekt");
    expect(hero).toMatchObject({ ticker: "CDR", risk: true, place: "Warsaw · Brokerage" });
    expect(hero.share).toMatch(/^7\.5% of the portfolio$/);
    expect(hero.value?.amount.toString()).toBe("9657.00");
    expect(hero.week?.toFloat()).toBeCloseTo(-0.094, 3);
    expect(textOf(hero.perUnit)).toBe("PLN 214.60 a share");
    expect(hero.fromHigh).toBe("29% under the 52-week high");
    if (chart === null) throw new Error("no chart");
    const values = chart.series[0]?.values ?? [];
    expect(values.length).toBeGreaterThan(40);
    expect(values.every((v) => typeof v === "number")).toBe(true);
    expect(values.at(-1)).toBe(214.6);
    const cost = chart.levels?.find((l) => l.kind === "cost");
    expect(cost).toMatchObject({ y: 245.5, muted: true });
    expect(textOf(cost?.label)).toBe("avg. cost · PLN 245.50");
    expect(chart.levels?.some((l) => l.kind === "rule" && l.y === 302.94)).toBe(true);
    expect(ready().facts).toEqual({
      quantity: "45 units",
      averageCost: expect.stringMatching(/^PLN\s245\.50$/),
    });
    expect(ready().thesis).toMatchObject({
      why: "a full release pipeline through 2028 at a fair price",
      wrongIf: "the 2027 release slips again",
    });
  });

  it("masks the quantity and the average cost and draws no cost level while amounts are hidden", async () => {
    const { ready } = await show("CDR", { privacy: true });
    expect(ready().facts).toEqual({ quantity: "•••", averageCost: "•••" });
    const levels = ready().chart?.levels ?? [];
    expect(levels.length).toBeGreaterThan(0);
    // The average-cost line and every cost-basis threshold would show the cost by their position.
    expect(levels.some((l) => l.kind === "cost")).toBe(false);
    expect(levels.some((l) => String(l.label).includes("•••"))).toBe(false);
    // Public prices stay visible.
    expect(textOf(ready().hero.perUnit)).toBe("PLN 214.60 a share");
  });

  it("shows a fractional quantity in its own scale", () => {
    expect(quantityText(D("0.25"), "en-US")).toBe("0.25");
    expect(quantityText(D("1.5"), "en-US")).toBe("1.5");
    expect(quantityText(D("1.50000000"), "en-US")).toBe("1.5");
    expect(quantityText(D("45"), "en-US")).toBe("45");
    expect(quantityText(D("0.123456789"), "en-US")).toBe("0.12345679");
  });

  it("re-reads the history for another range", async () => {
    const { ready } = await show("CDR");
    const threeMonths = ready().chart?.series[0]?.values.length ?? 0;
    await act(async () => {
      ready().range.onChange("1y");
    });
    expect(ready().range.value).toBe("1y");
    expect(ready().chart?.series[0]?.values.length ?? 0).toBeGreaterThan(threeMonths * 3);
  });

  it("lists the waiting alert, the research and notes the decision once made", async () => {
    const { fixture, ready } = await show("CDR");
    const alert = ready().rows.find(
      (r) => r.kind === "signal" && r.title === "CD Projekt fell 9.4% in 5 sessions",
    );
    expect(alert).toMatchObject({ tag: { text: "open", tone: "negative" } });
    const note = ready().rows.find((r) => r.kind === "note");
    expect(note).toMatchObject({
      title: "Q3 and the 2027 slate",
      tag: { text: "weakens", tone: "negative" },
    });
    await fireEvent.press(screen.getByText("CD Projekt fell 9.4% in 5 sessions"));
    expect(openAlert).toHaveBeenCalledWith(alert?.key);
    await fireEvent.press(screen.getByText("Q3 and the 2027 slate"));
    expect(openNote).toHaveBeenCalledWith(note?.key);

    await act(async () => {
      fixture.apply(signalsOwnerCommands.positionDecision, {
        instrument: fixture.instrument("CDR"),
        signals: [alert?.key],
        action: "held",
        reason: "results first",
      });
    });
    const noted = ready().rows.find((r) => r.key === alert?.key);
    expect(noted).toMatchObject({ tag: { text: "noted", tone: "positive" }, onPress: null });
    expect(ready().hero.risk).toBe(false);
    expect(ready().rows.find((r) => r.kind === "decision")).toMatchObject({
      title: "Nothing for now - “results first”",
      sub: "Nov 12, 2026",
    });
  });

  it("opens every held instrument, a thesis only where one exists", async () => {
    const { ready } = await show("VWCE");
    expect(ready().hero).toMatchObject({ ticker: "VWCE", risk: false, place: "Xetra · IKE" });
    expect(ready().thesis).toBeNull();
    expect(ready().facts?.quantity).toMatch(/^\d+ units$/);
  });

  it("is missing for an instrument the vault does not know", async () => {
    const { current } = await show(null);
    expect(current()).toEqual({ kind: "missing", reason: "unknown" });
  });
});

const stories: [string, object][] = [
  ["held with alert", HeldWithAlert.args],
  ["decided", Decided.args],
  ["ETF without thesis", EtfWithoutThesis.args],
  ["incognito", Incognito.args],
  ["watched, not held", WatchedNotHeld.args],
  ["unknown", Unknown.args],
  ["no strategy yet", NoStrategyYet.args],
];

it.each(stories)("renders the %s story", async (_name, args) => {
  const View = positionMeta.component as ComponentType<object>;
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <View {...positionMeta.args} {...args} />
    </UiEnvProvider>,
  );
  expect(screen.root).toBeOnTheScreen();
});
