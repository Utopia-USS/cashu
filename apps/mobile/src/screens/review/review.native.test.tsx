// The weekly review deck's hook + View over the real synthetic investments vault (the investmentsStore
// kit: Anna's portfolio, the CD Projekt alert fired, Saturday's research with a candidate): keep, flag
// and back, the decide card's guard and its journal write, the saved review with its agenda and its
// undo, the live idea state, and every story through the native View. All data is invented.
import { setLanguageForTests } from "@cashu/i18n";
import { lastReview } from "@cashu/store/investments/queries";
import { readReviewDue, undoSavedReview } from "@cashu/store/investments/review-screen";
import { runQuery } from "@cashu/store/query";
import { ProfileProvider, StoreProvider, useProfile } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import { act, cleanup, render, screen } from "@testing-library/react-native";
import { type ComponentType, type ReactNode, useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ServicesProvider } from "../../services/ServicesProvider";
import { type InvestmentsStore, investmentsStore } from "../testing/investmentsStore";
import { ReviewDeckView } from "./ReviewDeckView";
import reviewMeta, * as stories from "./ReviewDeckView.stories";
import { type ReviewDeckState, shownDecideItems, useReviewDeck } from "./useReviewDeck";

jest.mock("@expo/ui", () => require("../testing/expoUiMock").default);
// The first kit of the file builds the synthetic vault (the rest copy it): slow on a loaded machine.
jest.setTimeout(30_000);

const closers: (() => void)[] = [];
beforeEach(() => setLanguageForTests("en"));
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
});

function setup(): InvestmentsStore {
  const kit = investmentsStore();
  closers.push(() => kit.close());
  return kit;
}

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
function Deck({
  today,
  step,
  observed,
}: {
  today: string;
  step: number | null;
  observed: (state: ReviewDeckState) => void;
}) {
  const state = useReviewDeck({ vault: useProfile(), today, lang: "en", step, close });
  useEffect(() => observed(state));
  return <ReviewDeckView {...state} />;
}

async function open(kit: InvestmentsStore, step: number | null = null) {
  const seen: { state?: ReviewDeckState } = {};
  await render(
    <ServicesProvider services={kit.services}>
      <StoreProvider client={kit.client}>
        <ProfileProvider>
          <Env>
            <Deck
              today={kit.today}
              step={step}
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
    get state(): ReviewDeckState {
      if (seen.state === undefined) throw new Error("the deck did not render");
      return seen.state;
    },
    get card(): Extract<ReviewDeckState, { kind: "card" }> {
      const state = seen.state;
      if (state?.kind !== "card") throw new Error(`expected a card, got ${state?.kind}`);
      return state;
    },
    get summary(): Extract<ReviewDeckState, { kind: "summary" }> {
      const state = seen.state;
      if (state?.kind !== "summary") throw new Error(`expected the summary, got ${state?.kind}`);
      return state;
    },
  };
}

const press = (run: () => Promise<void> | void) =>
  act(async () => {
    await run();
  });

/** The deck's cards on the kit: the phone has no calendar source, so the calendar card is absent. */
const CARDS = ["world", "sectors", "positions", "events", "ideas", "decide"];

describe("weekly review deck with the real synchronous store", () => {
  it("keeps, flags and goes back through the cards; the calendar is absent without a calendar", async () => {
    const kit = setup();
    const deck = await open(kit);
    expect(deck.card.card.id).toBe("world");
    expect(deck.card.step).toBe("1 / 6");
    expect(deck.card.progress).toEqual({ total: 6, done: 0, flagged: [] });
    expect(deck.card.onBack).toBeNull();
    expect(screen.getByText("Weekly review")).toBeOnTheScreen();

    await press(deck.card.onKeep);
    expect(deck.card.card.id).toBe("sectors");
    await press(deck.card.onFlag);
    expect(deck.card.card.id).toBe("positions");
    expect(deck.card.progress).toEqual({ total: 6, done: 2, flagged: [1] });
    expect(deck.card.card.title).toBe("4 of 5 positions moved more than 3%");

    await press(() => deck.card.onBack?.());
    expect(deck.card.card.id).toBe("sectors");
    expect(deck.card.progress.flagged).toEqual([]);
    await press(deck.card.onKeep);
    await press(deck.card.onKeep);
    expect(deck.card.card.id).toBe("events");
    expect(deck.card.card.title).toBe("CD Projekt: the picture weakened");
    expect(CARDS).toContain(deck.card.card.id);
  });

  it("holds the decide card until the alert has a choice, then journals it and reaches the summary", async () => {
    const kit = setup();
    const deck = await open(kit, CARDS.indexOf("decide"));
    const card = deck.card;
    expect(card.card.id).toBe("decide");
    expect(card.canKeep).toBe(false);
    expect(card.keepLabel).toBe("Save and next");
    expect(card.card.title).toBe("CD Projekt: what do you do?");
    const body = card.card.body;
    if (body.kind !== "decide") throw new Error("expected the decide body");
    expect(body.rows.map((r) => [r.mode, r.choice, r.saved])).toEqual([["choose", null, false]]);
    // The signals read as sentences with the instrument's name, never the engine's machine text.
    expect(body.rows.map((r) => [r.why, r.facts])).toEqual([
      [
        "CD Projekt fell 9.4% in 5 sessions (PLN\u00a0236.87 → PLN\u00a0214.60)",
        [
          "CD Projekt closed below its 5-session average (PLN\u00a0214.60 vs PLN\u00a0223.33)",
          "CD Projekt is 7.5% of the portfolio (your limit 5%)",
        ],
      ],
    ]);

    await press(card.onKeep);
    expect(deck.card.card.id).toBe("decide");

    const journalBefore = kit.store.read<{ n: number }>(
      "SELECT COUNT(*) AS n FROM inv_decisions",
    )[0]?.n;
    await press(() => {
      const row = (deck.card.card.body as typeof body).rows[0];
      row?.onReason("Waiting for the Q4 call");
      row?.onChoose("held");
    });
    expect(deck.card.canKeep).toBe(true);
    await press(deck.card.onKeep);
    expect(deck.state.kind).toBe("summary");
    const journal = kit.store.read<{ action: string; reason: string | null }>(
      "SELECT action, reason FROM inv_decisions ORDER BY id DESC LIMIT 1",
    );
    expect(kit.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM inv_decisions")[0]?.n).toBe(
      (journalBefore ?? 0) + 1,
    );
    expect(journal[0]).toEqual({ action: "held", reason: "Waiting for the Q4 call" });
    expect(deck.summary.summary.decisions).toEqual([{ title: "CD Projekt", choice: "Nothing" }]);
  });

  it("journals the decide card once for a double tap, and saves the review once", async () => {
    const kit = setup();
    const deck = await open(kit, CARDS.indexOf("decide"));
    const count = () =>
      kit.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM inv_decisions")[0]?.n ?? 0;
    const before = count();
    await press(() => {
      const body = deck.card.card.body;
      if (body.kind === "decide") body.rows[0]?.onChoose("held");
    });
    await press(async () => {
      const keep = deck.card.onKeep;
      await Promise.all([keep(), keep()]);
    });
    expect(deck.state.kind).toBe("summary");
    expect(count()).toBe(before + 1);

    close.mockClear();
    await press(async () => {
      const done = deck.summary.onDone;
      await Promise.all([done(), done()]);
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("saves a flagged review with its agenda as done, and the review can be undone in the window", async () => {
    const kit = setup();
    const deck = await open(kit);
    await press(deck.card.onFlag); // world
    for (const _ of CARDS.slice(1, -1)) await press(deck.card.onKeep);
    expect(deck.card.card.id).toBe("decide");
    await press(deck.card.onFlag); // decide flagged without a choice: nothing is journaled
    const summary = deck.summary;
    expect(summary.summary).toEqual({
      title: "Saved",
      clear: 4,
      waiting: "2 cards wait for you on your Mac",
      decisions: [{ title: "CD Projekt", choice: "no decision yet" }],
      skipped: "Skipped this week: calendar",
    });
    expect(summary.primaryLabel).toBe("Done");
    expect(summary.progress.flagged).toEqual([0, 5]);

    close.mockClear();
    await press(summary.onDone);
    expect(close).toHaveBeenCalledTimes(1);
    const read = kit.store.read.bind(kit.store);
    const saved = lastReview(read, "investments");
    expect(saved?.stats.session).toMatchObject({
      cards: CARDS.map((id) => ({
        id,
        verdict: id === "world" || id === "decide" ? "flag" : "keep",
      })),
      agenda: [
        { card: "world", note: null },
        { card: "decide", note: null },
      ],
      decisions: [],
      skipped: [{ id: "calendar", reason: "source_unbound" }],
    });
    expect(readReviewDue(read, { today: kit.today, timeZone: "Europe/Warsaw" })).toMatchObject({
      due: false,
      last: { gid: saved?.gid, agenda: 2 },
    });

    if (saved === undefined) throw new Error("expected the saved review");
    await press(() => {
      kit.apply(undoSavedReview, { review: saved.gid });
    });
    expect(lastReview(read, "investments")).toBeUndefined();
  });

  it("marks the review done when nothing is flagged", async () => {
    const kit = setup();
    const deck = await open(kit, CARDS.indexOf("decide"));
    await press(() => {
      const body = deck.card.card.body;
      if (body.kind === "decide") body.rows[0]?.onChoose("sold");
    });
    await press(deck.card.onKeep);
    expect(deck.summary.summary.title).toBe("Review done");
    expect(deck.summary.primaryLabel).toBe("Mark review done");
    expect(screen.getByText("Mark review done")).toBeOnTheScreen();
    await press(deck.summary.onDone);
    const saved = lastReview(kit.store.read.bind(kit.store), "investments");
    expect(saved?.stats.session).toMatchObject({
      agenda: [],
      decisions: [{ subject: "CDR", choice: "sold" }],
    });
  });

  it("watches the candidate idea and shows its live state without reshuffling the deck", async () => {
    const kit = setup();
    const deck = await open(kit, CARDS.indexOf("ideas"));
    const body = deck.card.card.body;
    if (body.kind !== "ideas") throw new Error("expected the ideas body");
    expect(body.rows.map((r) => [r.state, r.canWatch])).toEqual([["open", true]]);
    await press(() => body.rows[0]?.onWatch());
    const after = deck.card.card.body;
    if (after.kind !== "ideas") throw new Error("expected the ideas body");
    expect(after.rows.map((r) => r.state)).toEqual(["watching"]);
    expect(after.error).toBeNull();
    expect(deck.card.progress.total).toBe(6);
  });
});

const storyList: [string, { args: object }][] = Object.entries(stories).flatMap(([name, story]) =>
  name === "default" ? [] : [[name, story as { args: object }]],
);

it.each(storyList)("renders the %s story through the native View", async (_name, story) => {
  const View = reviewMeta.component as ComponentType<object>;
  await render(
    <Env>
      <View {...story.args} />
    </Env>,
  );
  expect(screen.root).toBeOnTheScreen();
});

describe("the decide rows without the owner's own bucket drift", () => {
  it("drops a hidden signal per signal: the lead gives way, the facts and the journal lose it", () => {
    const kit = setup();
    const result = runQuery(kit.store, kit.services.moneyQueries.investments.review, {
      today: kit.today,
      lang: "en",
      open: true,
    }).value;
    if (result.status !== "current") throw new Error("review not current");
    const item = result.decide.items.find((i) => i.lead !== undefined);
    if (item?.lead === undefined) throw new Error("no signal-led decide item");
    const hidden = {
      ...item.lead,
      gid: "drift-core",
      kind: "allocation_drift",
      message: "Bucket core: 42% against a 35% target",
      payload: { bucket_id: "core", bucket_generic: false },
    };
    const shown = { ...item.lead, gid: "drift-equity", kind: "allocation_drift" };
    const generic = {
      ...shown,
      payload: { bucket_id: "global_equity", bucket_generic: true },
    };
    const led = {
      ...item,
      lead: hidden,
      supporting: [generic],
      signals: ["drift-core", "drift-equity", "ladder-core"],
    };
    // The open read knows the ladder row too (an older drift of the same bucket).
    const open = [hidden, generic, { ...hidden, gid: "ladder-core" }];
    const [kept] = shownDecideItems([led], open);
    expect(kept?.lead?.gid).toBe("drift-equity");
    expect(kept?.supporting).toEqual([]);
    expect(kept?.signals).toEqual(["drift-equity"]);
    expect(kept?.why).toBe(generic.message);
    // An item of hidden signals only is left out; an item without a hidden one stays as it is.
    expect(shownDecideItems([{ ...led, supporting: [] }], open)).toEqual([]);
    expect(shownDecideItems([item], open)).toEqual([item]);
  });
});
