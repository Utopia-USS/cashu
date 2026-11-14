// The Investments tab over the real synchronous store: the shell hook (header, review slot, the Signals
// count), the Portfolio, Signals and Strategy section hooks and their Views, on the companion fixture's
// synthetic portfolio (`investmentsStore()`), plus every View story. Only the platform controls
// (@expo/ui) are stand-ins; useQuery, the queries, SQLite and the domain math stay real. The calendar
// is pinned to Thu 12 Nov 2026 (only `Date` is faked; timers stay real).
import { setLanguageForTests } from "@cashu/i18n";
import { saveReview } from "@cashu/store/investments/review-screen";
import { signalsOwnerCommands } from "@cashu/store/investments/signals-screen";
import { runQuery } from "@cashu/store/query";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { type ComponentType, type ReactElement, type ReactNode, useEffect } from "react";
import { ServicesProvider } from "../../services/ServicesProvider";
import {
  INVESTMENTS_TODAY,
  type InvestmentsStore,
  type InvestmentsStoreOptions,
  investmentsStore,
} from "../testing/investmentsStore";
import { dayRange } from "./format";
import { InvestmentsView } from "./InvestmentsView";
import investmentsMeta, * as investmentsStories from "./InvestmentsView.stories";
import type {
  InvestmentsViewName,
  InvestmentsViewProps,
  PortfolioViewProps,
  SignalsViewProps,
  StrategyViewProps,
} from "./investments-contracts";
import { PortfolioView } from "./portfolio/PortfolioView";
import portfolioMeta, * as portfolioStories from "./portfolio/PortfolioView.stories";
import { allocationProps, usePortfolioSection } from "./portfolio/usePortfolioSection";
import { SignalsView } from "./signals/SignalsView";
import signalsMeta, * as signalsStories from "./signals/SignalsView.stories";
import { signalsProps, useSignalsSection } from "./signals/useSignalsSection";
import { StrategyView } from "./strategy/StrategyView";
import strategyMeta, * as strategyStories from "./strategy/StrategyView.stories";
import { useStrategySection } from "./strategy/useStrategySection";
import { waitsForDecision } from "./useInvestmentSignals";
import { useInvestmentsScreen } from "./useInvestmentsScreen";

jest.mock("@expo/ui", () => require("../testing/expoUiMock").default);

// The kit builds the synthetic vault through the real commands once per file and option set, and each
// test gets its own copy; the first build is slow under a full parallel run, so the default 5 s can run
// out on a loaded machine.
jest.setTimeout(30_000);

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

function setup(options?: InvestmentsStoreOptions): InvestmentsStore {
  const kit = investmentsStore(options);
  closers.push(() => kit.close());
  return kit;
}

function Frame({
  kit,
  privacy = false,
  children,
}: {
  kit: InvestmentsStore;
  privacy?: boolean;
  children: ReactNode;
}) {
  return (
    <ServicesProvider services={kit.services}>
      <StoreProvider client={kit.client}>
        <ProfileProvider>
          <UiEnvProvider locale="en-GB" privacy={privacy}>
            {children}
          </UiEnvProvider>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}

const openPosition = jest.fn();
const openAlert = jest.fn();
const openNote = jest.fn();
const openReview = jest.fn();

interface Seen {
  shell?: Omit<InvestmentsViewProps, "children">;
  portfolio?: PortfolioViewProps;
  signals?: SignalsViewProps;
  strategy?: StrategyViewProps;
}

type Recorder = (part: Seen) => void;

function Portfolio({ record }: { record: Recorder }) {
  const props = usePortfolioSection({ openPosition });
  useEffect(() => {
    record({ portfolio: props });
  });
  return <PortfolioView {...props} />;
}
function Signals({ record }: { record: Recorder }) {
  const props = useSignalsSection({ openAlert, openNote });
  useEffect(() => {
    record({ signals: props });
  });
  return <SignalsView {...props} />;
}
function Strategy({ record }: { record: Recorder }) {
  const props = useStrategySection();
  useEffect(() => {
    record({ strategy: props });
  });
  return <StrategyView {...props} />;
}

/** The route's composition with the view fixed by the test. */
function Tab({ view, record }: { view: InvestmentsViewName; record: Recorder }) {
  const props = useInvestmentsScreen({
    view,
    onViewChanged: () => {},
    openReview,
    openProfile: () => {},
  });
  useEffect(() => {
    record({ shell: props });
  });
  return (
    <InvestmentsView {...props}>
      {view === "portfolio" ? (
        <Portfolio record={record} />
      ) : view === "signals" ? (
        <Signals record={record} />
      ) : (
        <Strategy record={record} />
      )}
    </InvestmentsView>
  );
}

async function show(kit: InvestmentsStore, view: InvestmentsViewName, privacy = false) {
  const seen: Seen = {};
  await render(
    <Frame kit={kit} privacy={privacy}>
      <Tab view={view} record={(part) => Object.assign(seen, part)} />
    </Frame>,
  );
  return seen;
}

describe("the Investments shell", () => {
  it("offers the due weekly review on top and counts the decision waiting", async () => {
    const kit = setup();
    const seen = await show(kit, "portfolio");
    expect(seen.shell?.review).toMatchObject({ kind: "due", title: "Weekly review" });
    const review = seen.shell?.review;
    if (review?.kind !== "due") throw new Error("review not due");
    // The range comes from the runtime's Intl.formatRange, whose spacing differs by ICU version
    // ("9-15 Nov" / "9 - 15 Nov"): expect what the same formatter gives here.
    expect(review.meta).toBe(
      `${dayRange("2026-11-09", "2026-11-15", "en-GB")} · 6 cards · due Sunday`,
    );
    expect(review.teaser).toContain("one decision waiting");
    expect(review.teaser).toContain("one idea outside the portfolio");
    expect(seen.shell?.signalsCount).toBe(1);
    expect(screen.getByRole("tab", { name: "Signals · 1" })).toBeOnTheScreen();
    expect(screen.getByText("Prices not fetched yet")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Start the review"));
    expect(openReview).toHaveBeenCalled();
  });

  it("names this phone's own price fetch time, never live", async () => {
    const kit = setup({ pricesFetchedAt: new Date(2026, 10, 12, 7, 31).toISOString() });
    await show(kit, "portfolio");
    expect(screen.getByText("Prices from 07:31 · fetched by this phone")).toBeOnTheScreen();
    expect(screen.queryByText(/live/i)).toBeNull();
  });

  it("reads a flagged saved review as done with the cards waiting on the Mac, and undoes it", async () => {
    const kit = setup();
    const seen = await show(kit, "strategy");
    await act(async () => {
      kit.apply(saveReview, {
        notes: null,
        session: {
          cards: [
            { id: "world", verdict: "keep" },
            { id: "events", verdict: "flag" },
            { id: "ideas", verdict: "flag" },
          ],
          agenda: [
            { card: "events", note: null },
            { card: "ideas", note: null },
          ],
          decisions: [],
          skipped: [],
          minutes: 4,
        },
      });
    });
    expect(seen.shell?.review).toEqual({
      kind: "done",
      sub: "2 cards wait on your Mac",
      canUndo: true,
    });
    expect(screen.getByText("Review done")).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText("Undo the saved review"));
    await act(async () => {});
    expect(seen.shell?.review?.kind).toBe("due");
  });
});

describe("the Portfolio view", () => {
  it("values the portfolio, opens every held position and rings the one waiting for a decision", async () => {
    const kit = setup();
    const seen = await show(kit, "portfolio");
    const props = seen.portfolio;
    if (props?.status !== "ready") throw new Error(`portfolio ${props?.status}`);
    expect(props.positions.map((p) => p.ticker).sort()).toEqual(
      ["BETA", "CDR", "DBND", "EDO", "VT", "VWCE"].sort(),
    );
    expect(props.positions.filter((p) => p.risk).map((p) => p.ticker)).toEqual(["CDR"]);
    const cdr = props.positions.find((p) => p.ticker === "CDR");
    expect(cdr?.weekPct?.toFloat()).toBeCloseTo(-0.094, 3);
    expect(cdr?.value.toString()).toBe(
      props.positions.find((p) => p.ticker === "CDR")?.value.toString(),
    );
    // Each position in its own currency; the foreign ones listed beside the converted value.
    expect(props.positions.find((p) => p.ticker === "VT")?.value.currency).toBe("USD");
    expect(props.value.incl.map((m) => m.currency).sort()).toEqual(["EUR", "USD"]);
    expect(props.positions.find((p) => p.ticker === "EDO")?.resultPct).toBeNull();
    expect(props.value.total.amount.gt(props.facts.added.amount)).toBe(true);
    // Eleven PLN 1,000 deposits in 2026, against eleven months of the PLN 2,500 plan.
    expect(props.facts.added.amount.toString()).toBe("11000");
    expect(props.facts.planToDate?.amount.toString()).toBe("27500");
    expect(props.chart.series[0]?.values.length).toBeLessThanOrEqual(52);
    expect(props.chart.series[0]?.values.length).toBeGreaterThan(40);
    expect(props.allocation.rows.map((r) => r.label)).toEqual([
      "Global equities",
      "Bond ETFs",
      "Treasury bonds",
      "Cash",
      "Not in a bucket",
    ]);
    expect(props.allocation.drift).toEqual({
      label: "Treasury bonds 7% below target",
      tone: "warn",
    });
    for (const p of props.positions) {
      await fireEvent.press(screen.getByLabelText(`${p.name}, open the position`));
      expect(openPosition).toHaveBeenLastCalledWith(p.gid);
    }
    expect(openPosition).toHaveBeenCalledWith(kit.instrument("CDR"));
  });

  it("shows today's change once this phone fetched prices today", async () => {
    const kit = setup({ pricesFetchedAt: new Date(2026, 10, 12, 7, 31).toISOString() });
    const props = (await show(kit, "portfolio")).portfolio;
    if (props?.status !== "ready") throw new Error(`portfolio ${props?.status}`);
    expect(props.value.day).not.toBeNull();
    expect(screen.getByText("today")).toBeOnTheScreen();
  });

  it("hides today's change until this phone fetched prices today", async () => {
    const kit = setup({ pricesFetchedAt: new Date(2026, 10, 11, 18, 5).toISOString() });
    const props = (await show(kit, "portfolio")).portfolio;
    if (props?.status !== "ready") throw new Error(`portfolio ${props?.status}`);
    expect(props.value.day).toBeNull();
    expect(screen.queryByText("today")).toBeNull();
  });

  it("shows an empty portfolio when the strategy is synced but nothing is bought", async () => {
    const kit = setup({ content: "strategy" });
    const seen = await show(kit, "portfolio");
    expect(seen.portfolio?.status).toBe("ready");
    expect(screen.getByText("Nothing here yet")).toBeOnTheScreen();
  });

  it("shows the portfolio without a strategy from the Mac, as the Mac does", async () => {
    const kit = setup({ content: "none" });
    const seen = await show(kit, "portfolio");
    expect(seen.portfolio?.status).toBe("ready");
  });

  it("hides the money in incognito", async () => {
    const kit = setup();
    const seen = await show(kit, "portfolio", true);
    const props = seen.portfolio;
    if (props?.status !== "ready") throw new Error("not ready");
    expect(screen.queryByText("incl.")).toBeNull();
    expect(screen.getAllByLabelText("Amount hidden").length).toBeGreaterThan(0);
  });
});

describe("the Signals view", () => {
  it("lists the fired alert, the rule, the research and the decisions, and opens them", async () => {
    const kit = setup();
    const seen = await show(kit, "signals");
    const props = seen.signals;
    if (props?.status !== "ready") throw new Error("signals not ready");
    expect(props.since).toBe("New in the last week");
    // The % move reads as the title; the other alert keeps its own title and reads its facts below it.
    // Only the action alert waits for a decision; the info alert (the average) is a fact.
    expect(props.fired).toEqual([
      expect.objectContaining({
        title: "CDR below its 5-session average",
        sub: "CD Projekt closed below its 5-session average (PLN\u00a0214.60 vs PLN\u00a0223.33)",
        decided: false,
      }),
      expect.objectContaining({ title: "CD Projekt fell 9.4% in 5 sessions", decided: false }),
    ]);
    expect(props.fired[1]?.sub).toMatch(/^risk · .+ · waiting for a decision$/);
    expect(props.rules.map((r) => r.message)).toEqual([
      "CD Projekt is 7.5% of the portfolio (your limit 5%)",
    ]);
    expect(props.research.map((r) => [r.title, r.tag])).toEqual([
      ["Q3 and the 2027 slate", "weakens your thesis"],
      ["Polish bonds after the rate cut", "background"],
      ["USD/PLN: what moved it this month", "background"],
    ]);
    expect(props.research[0]?.sub).toBe("weakens your thesis · 4 sources");
    expect(props.decisions.map((d) => d.title)).toEqual([
      "Beta ETF S&P 500 - bought more",
      "Polish Bond ETF - nothing",
    ]);
    await fireEvent.press(screen.getByLabelText("CD Projekt fell 9.4% in 5 sessions, decide"));
    expect(openAlert).toHaveBeenCalledWith(props.fired[1]?.gid);
    await fireEvent.press(screen.getByLabelText("Q3 and the 2027 slate, open the note"));
    expect(openNote).toHaveBeenCalledWith(props.research[0]?.gid);
  });

  it("drops the count once the alert is decided later, and says it comes back in the review", async () => {
    const kit = setup();
    const seen = await show(kit, "signals");
    const props = seen.signals;
    if (props?.status !== "ready") throw new Error("signals not ready");
    const signal = props.fired.find((f) => f.title === "CD Projekt fell 9.4% in 5 sessions")?.gid;
    await act(async () => {
      kit.apply(signalsOwnerCommands.acknowledge, { signal });
    });
    expect(seen.shell?.signalsCount).toBe(0);
    expect(screen.getByRole("tab", { name: "Signals" })).toBeOnTheScreen();
    const after = seen.signals;
    if (after?.status !== "ready") throw new Error("signals not ready");
    expect(after.fired).toEqual([
      expect.objectContaining({ title: "CDR below its 5-session average", decided: false }),
      {
        gid: signal,
        title: "CD Projekt - noted",
        sub: "Decide later - back in your review",
        decided: true,
        marked: false,
      },
    ]);
  });
});

describe("the Signals view's rules", () => {
  it("never lists or counts an allocation drift of the owner's own bucket, and names a generic one", () => {
    const kit = setup();
    const queries = kit.services.moneyQueries.investments;
    const signals = runQuery(kit.store, queries.signals, {
      now: kit.now,
      today: kit.today,
      timeZone: "UTC",
      lang: "en",
      privacy: false,
    }).value;
    if (signals.status !== "ready") throw new Error("signals not ready");
    const notes = runQuery(kit.store, queries.research.notes, {
      today: kit.today,
      lang: "en",
    }).value;
    const rule = signals.open.find((s) => s.kind === "position_concentration");
    if (rule === undefined) throw new Error("no rule signal");
    // A stored flag says generic, the id is the owner's own: the phone still hides it (as the desktop).
    const drift = (bucket: string) => ({
      ...rule,
      gid: `drift-${bucket}`,
      kind: "allocation_drift",
      instrument: null,
      instrumentLabel: null,
      severity: "action",
      payload: {
        bucket_id: bucket,
        bucket_generic: true,
        weight: 0.42,
        target: 0.35,
        drift_pp: 0.07,
        drift_value_base: "700",
        currency: "PLN",
      },
    });
    const props = signalsProps(
      { ...signals, open: [...signals.open, drift("core"), drift("global_equity")] },
      notes,
      {
        today: kit.today,
        now: new Date(kit.now),
        env: { locale: "en-GB", privacy: false },
        onAlertPressed: () => {},
        onNotePressed: () => {},
        marked: [],
      },
    );
    expect(props.rules.map((r) => r.message)).toEqual([
      "CD Projekt is 7.5% of the portfolio (your limit 5%)",
      "Global equities: 42.0% of the portfolio against a 35% target (PLN\u00a0700 over)",
    ]);
    expect(props.rules.some((r) => r.message.includes("core"))).toBe(false);
    expect(waitsForDecision(drift("core"))).toBe(false);
    expect(waitsForDecision(drift("global_equity"))).toBe(true);
  });

  it("shows an alert's own title without the owner's bucket id, masked in incognito", () => {
    const kit = setup();
    const queries = kit.services.moneyQueries.investments;
    const signals = runQuery(kit.store, queries.signals, {
      now: kit.now,
      today: kit.today,
      timeZone: "UTC",
      lang: "en",
      privacy: false,
    }).value;
    if (signals.status !== "ready") throw new Error("signals not ready");
    const notes = runQuery(kit.store, queries.research.notes, {
      today: kit.today,
      lang: "en",
    }).value;
    const fired = signals.signals.find((s) => s.alert !== null && s.kind === "alert:sma_cross");
    if (fired === undefined) throw new Error("no average alert");
    const titled = {
      ...fired,
      kind: "alert:weight_above",
      messageParams: { ...fired.messageParams, title: "Bucket core above 40%" },
      message: "Bucket core: 42% (above 40%)",
      payload: { bucket_id: "core" },
    };
    const read = (privacy: boolean) =>
      signalsProps({ ...signals, signals: [titled] }, notes, {
        today: kit.today,
        now: new Date(kit.now),
        env: { locale: "en-GB", privacy },
        onAlertPressed: () => {},
        onNotePressed: () => {},
        marked: [],
      }).fired[0];
    expect(read(false)?.title).toBe("Bucket above 40%");
    expect(read(true)?.title).toBe("Bucket above •••%");
    expect(JSON.stringify(read(false))).not.toContain("core");
  });
});

describe("the Portfolio allocation", () => {
  const bucket = (bucket_id: string, weight: number, target: number, generic?: boolean) => ({
    bucket_id,
    weight,
    target,
    drift_pp: (weight - target) * 100,
    ...(generic === undefined ? {} : { generic }),
  });

  it("shows the targets and the drift while every bucket is generic", () => {
    const allocation = allocationProps({
      buckets: [bucket("global_equity", 0.62, 0.6), bucket("bonds", 0.33, 0.4)],
      buckets_generic: true,
      unclassified: { weight: 0.05 },
    });
    expect(allocation.rows.map((r) => r.label)).toEqual([
      "Global equities",
      "Bonds",
      "Not in a bucket",
    ]);
    expect(allocation.drift).toEqual({ label: "Bonds 7% below target", tone: "warn" });
  });

  it("hides the whole block and the drift of the owner's own buckets, as the desktop", () => {
    const own = allocationProps({
      buckets: [bucket("core", 0.66, 0.6), bucket("bonds", 0.34, 0.4)],
      unclassified: { weight: 0.05 },
    });
    expect(own).toEqual({ rows: [], drift: null });
    // A generic id the server marks as the owner's own counts as the owner's own.
    expect(
      allocationProps({
        buckets: [bucket("global_equity", 0.6, 0.6, false), bucket("bonds", 0.4, 0.4)],
        unclassified: null,
      }),
    ).toEqual({ rows: [], drift: null });
  });
});

describe("the Strategy view", () => {
  it("renders the synced strategy text and what watches it", async () => {
    const kit = setup();
    const seen = await show(kit, "strategy");
    const props = seen.strategy;
    expect(props?.document?.blocks.length).toBeGreaterThan(3);
    expect(props?.document?.updated).toBe("2023-11-17");
    expect(props?.rules.map((r) => [r.name, r.tag.label])).toEqual([
      ["Buckets within their bands", "ok"],
      ["One position at most 5%", "fired"],
      ["Cash at most 15%", "ok"],
      ["Fall from the high above 20%", "ok"],
      ["A deposit at least every 31 days", "ok"],
      ["Akcje globalne poniżej celu, a gotówka czeka na zainwestowanie", "ok"],
    ]);
    expect(props?.alertsCount).toBe(2);
    expect(screen.getByText("6 rules · 2 alerts")).toBeOnTheScreen();
  });

  it("says there is no strategy yet before one is synced", async () => {
    const kit = setup({ content: "none" });
    await show(kit, "strategy");
    expect(screen.getByText("No strategy yet")).toBeOnTheScreen();
  });
});

// Every story renders through its native View (cashu-ui: stories are the render tests).
const STORIES: [string, ComponentType<never>, object, Record<string, unknown>][] = [
  ["InvestmentsView", investmentsMeta.component, investmentsMeta.args, investmentsStories],
  ["PortfolioView", portfolioMeta.component, portfolioMeta.args, portfolioStories],
  ["SignalsView", signalsMeta.component, signalsMeta.args, signalsStories],
  ["StrategyView", strategyMeta.component, strategyMeta.args, strategyStories],
];

describe.each(STORIES)("%s stories", (_view, component, base, module) => {
  const Component = component as ComponentType<object>;
  const stories = Object.entries(module).filter(([name]) => name !== "default") as [
    string,
    { args: object; decorators?: ((story: ComponentType) => ReactElement)[] },
  ][];
  it.each(stories)("%s renders", async (_name, story) => {
    const element = <Component {...base} {...story.args} />;
    const [decorate] = story.decorators ?? [];
    await render(
      decorate === undefined ? (
        <UiEnvProvider locale="en-US" privacy={false}>
          {element}
        </UiEnvProvider>
      ) : (
        decorate(() => element)
      ),
    );
    expect(screen.root).toBeOnTheScreen();
  });
});

it("keeps the portfolio's money out of the incognito story", async () => {
  const [decorate] = portfolioStories.Incognito.decorators;
  if (decorate === undefined) throw new Error("missing privacy decorator");
  await render(decorate(() => <PortfolioView {...portfolioStories.Incognito.args} />));
  expect(JSON.stringify(screen.toJSON())).not.toContain("129,825");
  expect(screen.getByText("Value, in bananas")).toBeOnTheScreen();
  expect(screen.queryByText("incl.")).toBeNull();
});

it("pins the kit's calendar day", () => {
  expect(INVESTMENTS_TODAY).toBe("2026-11-12");
});
