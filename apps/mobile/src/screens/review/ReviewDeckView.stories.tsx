// Stories of the weekly review deck (CSF 3, invented portfolio): one story per card kind (world,
// sectors, positions, events, ideas, calendar, decide without and with a choice), the summary done and
// saved with flagged cards, a refused save and the unavailable state.
import { D, Money } from "@cashu/domain";
import { ReviewDeckView, type ReviewDeckViewProps } from "./ReviewDeckView";
import type { CardModel, DecideRow, IdeaRow } from "./useReviewDeck";

type CardState = Extract<ReviewDeckViewProps, { kind: "card" }>;
type SummaryState = Extract<ReviewDeckViewProps, { kind: "summary" }>;

const noop = () => {};
const later = async () => {};

const world: CardModel = {
  id: "world",
  eyebrow: "The world this week",
  title: "A calm week, behind the market",
  body: {
    kind: "world",
    move: D("0.0043"),
    change: new Money(D("1547.81"), "PLN"),
    benchmark: D("0.046"),
    drawdown: D("-0.0956"),
    maxDrawdown: D("-0.1198"),
    sigma: D("0.0101"),
  },
};

const sectors: CardModel = {
  id: "sectors",
  eyebrow: "Sectors",
  title: "Global equities carried the week",
  body: {
    kind: "sectors",
    rows: [
      {
        key: "equity_global",
        label: "Global equities",
        weight: D("0.389"),
        contribution: D("0.0166"),
      },
      { key: "unassigned", label: "No topic", weight: D("0.478"), contribution: D("-0.014") },
      { key: "bonds", label: "Bonds and rates", weight: D("0.079"), contribution: D("0") },
      { key: "currency", label: "Exchange rates", weight: null, contribution: D("0.0016") },
    ],
  },
};

const positions: CardModel = {
  id: "positions",
  eyebrow: "Your positions",
  title: "3 of 6 positions moved more than 3%",
  body: {
    kind: "positions",
    down: [
      { id: "cdr", label: "CDR", ret: D("-0.094") },
      { id: "beta", label: "BETA", ret: D("-0.0356") },
    ],
    up: [
      { id: "vwce", label: "VWCE", ret: D("0.0428") },
      { id: "vt", label: "VT", ret: D("0.0326") },
    ],
  },
};

const events: CardModel = {
  id: "events",
  eyebrow: "News that touches you",
  title: "CD Projekt: the picture weakened",
  body: {
    kind: "events",
    rows: [
      {
        id: "n1",
        subject: "CDR",
        title: "Q3 and the 2027 slate",
        relation: { text: "weakens the thesis", tone: "warning" },
      },
      { id: "n2", subject: "VWCE", title: "Index rebalancing in December", relation: null },
    ],
    brief: "Rates stay higher for longer; risk appetite is steady.",
  },
};

const idea = (state: IdeaRow["state"], canWatch = true): IdeaRow => ({
  id: "idea-1",
  title: "Beta ETF mWIG40TR: Polish mid caps",
  body: "A Warsaw-listed ETF on the mWIG40 total return index. It would add Polish mid caps, which the portfolio holds only through CD Projekt.",
  state,
  canWatch,
  onWatch: later,
  onDismiss: later,
});

const ideas: CardModel = {
  id: "ideas",
  eyebrow: "An idea outside the portfolio",
  title: "Beta ETF mWIG40TR: Polish mid caps",
  body: { kind: "ideas", rows: [idea("open")], error: null },
};

const calendar: CardModel = {
  id: "calendar",
  eyebrow: "Coming up",
  title: "2 dates touch your portfolio",
  body: {
    kind: "calendar",
    rows: [
      { key: "a", date: "2026-11-18", title: "NBP rate decision" },
      { key: "b", date: "2026-11-26", title: "CD Projekt Q4 call" },
    ],
  },
};

const decideRow = (choice: DecideRow["choice"]): DecideRow => ({
  key: "s:cdr",
  title: "CDR",
  why: "CDR -8% in 5 sessions: -9.4% in 5 sessions (236.87 on 5 Nov to 214.60 on 12 Nov).",
  facts: ["CDR: 7.5% of the portfolio (max 5.0%)."],
  mode: "choose",
  choice,
  saved: false,
  reason: "",
  onChoose: noop,
  onReason: noop,
});

const decideCard = (choice: DecideRow["choice"]): CardModel => ({
  id: "decide",
  eyebrow: "A decision waiting",
  title: "CDR: what do you do?",
  body: {
    kind: "decide",
    choices: [
      ["Nothing", "held"],
      ["Buy more", "bought"],
      ["Sell", "sold"],
    ],
    rows: [decideRow(choice)],
  },
});

const cardState = (card: CardModel, index: number, extra: Partial<CardState> = {}): CardState => ({
  kind: "card",
  progress: { total: 7, done: index, flagged: index > 1 ? [1] : [] },
  step: `${index + 1} / 7`,
  card,
  next: { eyebrow: "Next", title: "The next card" },
  canKeep: true,
  keepLabel: "Got it, next",
  isSaving: false,
  error: null,
  onKeep: later,
  onFlag: later,
  onBack: index > 0 ? noop : null,
  onClose: noop,
  ...extra,
});

const summaryDone: SummaryState = {
  kind: "summary",
  progress: { total: 7, done: 7, flagged: [] },
  summary: {
    title: "Review done",
    clear: 7,
    waiting: null,
    decisions: [{ title: "CDR", choice: "Nothing" }],
    skipped: null,
  },
  primaryLabel: "Mark review done",
  isSaving: false,
  error: null,
  onDone: later,
  onBack: noop,
  onClose: noop,
};

const meta = { title: "Mobile/ReviewDeck", component: ReviewDeckView, args: cardState(world, 0) };
export default meta;

export const World = { args: cardState(world, 0) };
export const Sectors = { args: cardState(sectors, 1) };
export const Positions = { args: cardState(positions, 2) };
export const Events = { args: cardState(events, 3) };
export const Ideas = { args: cardState(ideas, 4) };
export const IdeaWatchOnMac = {
  args: cardState(
    { ...ideas, body: { kind: "ideas", rows: [idea("open", false)], error: null } },
    4,
  ),
};
export const IdeaWatching = {
  args: cardState({ ...ideas, body: { kind: "ideas", rows: [idea("watching")], error: null } }, 4),
};
export const Calendar = { args: cardState(calendar, 5) };
export const DecideWithoutChoice = {
  args: cardState(decideCard(null), 6, {
    canKeep: false,
    keepLabel: "Save and next",
    next: null,
  }),
};
export const DecideChosen = {
  args: cardState(decideCard("held"), 6, { keepLabel: "Save and next", next: null }),
};
export const DecideNotSaved = {
  args: cardState(decideCard("bought"), 6, {
    keepLabel: "Save and next",
    next: null,
    error: "Could not save. Try again.",
  }),
};
export const SummaryDone = { args: summaryDone };
export const SummarySaved = {
  args: {
    ...summaryDone,
    progress: { total: 7, done: 7, flagged: [1, 3] },
    summary: {
      title: "Saved",
      clear: 5,
      waiting: "2 cards wait for you on your Mac",
      decisions: [{ title: "CDR", choice: "no decision yet" }],
      skipped: "Skipped this week: calendar",
    },
    primaryLabel: "Done",
  } satisfies SummaryState,
};
export const SummaryNotSaved = {
  args: { ...summaryDone, error: "Could not save. Try again." } satisfies SummaryState,
};
export const Unavailable = {
  args: { kind: "unavailable", onClose: noop } satisfies ReviewDeckViewProps,
};
