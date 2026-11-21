// The weekly review deck as a pure state machine, shared by the phone deck (and, later, the desktop
// one): the cards of one review in order, where the owner is, the verdict of each card passed (keep =
// "Got it, next", flag = "Come back to this"), free notes per card, the decide card's choices and the
// way back. Typed on the store's native review result (`ReviewScreenResult["cards"]`, its `skipped`
// and `ReviewDecideItem`) through the structural shapes below, so this package needs no store
// dependency; `deckSession` builds exactly the session `saveReview` stores. No React, no clock: the
// caller passes `now` (epoch ms).
import type { ReviewCardId } from "@cashu/domain/investments/review-deck";

export type { ReviewCardId };

/** A card of the deck: a review card, or the summary after the last one. */
export type DeckCard = { readonly id: ReviewCardId } | { readonly id: "summary" };

/** The decide choices the phone offers (the journal's actions; a decision never places a trade). */
export type DecideChoice = "held" | "bought" | "sold";

/** The part of the store's `ReviewDecideItem` the deck reads (the store type fits it). */
export interface DeckDecideItem {
  readonly key: string;
  readonly kind: "subject" | "thesis" | "proposal" | "rules";
  readonly title: string;
  /** The item's lead signal; an item with one needs a choice before the decide card is kept. */
  readonly lead?: unknown;
}

/** A card the review skipped this week and why (the store's `skipped` rows, or the phone's own). */
export interface DeckSkip {
  readonly id: ReviewCardId;
  readonly reason: string;
}

export interface DeckState {
  /** The shown cards in order; the summary follows the last one. */
  readonly cards: readonly ReviewCardId[];
  /** The current card; `cards.length` = the summary. */
  readonly index: number;
  readonly verdicts: Partial<Record<ReviewCardId, "keep" | "flag">>;
  readonly notes: Partial<Record<ReviewCardId, string>>;
  /** Decide item key -> choice. */
  readonly choices: Readonly<Record<string, DecideChoice>>;
  /** The indexes left, newest last (`back` returns to the last one). */
  readonly history: readonly number[];
  /** Epoch ms the deck opened. */
  readonly startedAt: number;
  /** Decide item keys that need a choice before the decide card is kept (items with a lead signal). */
  readonly required: readonly string[];
  /** The cards not shown and why; they go to the session as `skipped`. */
  readonly skipped: readonly DeckSkip[];
}

export type DeckEvent =
  | { readonly type: "keep" }
  | { readonly type: "flag" }
  | { readonly type: "back" }
  | { readonly type: "note"; readonly card: ReviewCardId; readonly text: string }
  | { readonly type: "choose"; readonly key: string; readonly choice: DecideChoice | null }
  | { readonly type: "jump"; readonly index: number };

/** The session `saveReview` stores (`reviewSessionSchema` of `@cashu/store/investments/review-screen`). */
export interface ReviewSession {
  cards: { id: ReviewCardId; verdict: "keep" | "flag" }[];
  agenda: { card: ReviewCardId; note: string | null }[];
  decisions: { subject: string; choice: string }[];
  skipped: { id: ReviewCardId; reason: string }[];
  minutes: number;
}

/** The session schema's limits. */
const MAX_SUBJECT = 200;
const MAX_REASON = 200;
const MAX_MINUTES = 525_600;
const MINUTE_MS = 60_000;

/** Whether a decide item needs a choice on the phone (it has a lead signal; proposals wait on the Mac). */
export function needsChoice(item: DeckDecideItem): boolean {
  return item.kind !== "proposal" && item.lead !== undefined;
}

export function initialDeck(
  cards: readonly ReviewCardId[],
  now: number,
  extra: {
    readonly decide?: readonly DeckDecideItem[];
    readonly skipped?: readonly DeckSkip[];
  } = {},
): DeckState {
  return {
    cards: [...cards],
    index: 0,
    verdicts: {},
    notes: {},
    choices: {},
    history: [],
    startedAt: now,
    required: (extra.decide ?? []).filter(needsChoice).map((item) => item.key),
    skipped: [...(extra.skipped ?? [])],
  };
}

/** The current card: a review card, or the summary once every card is passed. */
export function currentCard(state: DeckState): DeckCard {
  const id = state.cards[state.index];
  return id === undefined ? { id: "summary" } : { id };
}

/** Whether the current card may be kept: the decide card only with a choice for every required item. */
export function canKeep(state: DeckState): boolean {
  const id = state.cards[state.index];
  if (id === undefined) return false;
  return id !== "decide" || state.required.every((key) => state.choices[key] !== undefined);
}

function advance(state: DeckState, id: ReviewCardId, verdict: "keep" | "flag"): DeckState {
  return {
    ...state,
    verdicts: { ...state.verdicts, [id]: verdict },
    history: [...state.history, state.index],
    index: state.index + 1,
  };
}

export function reduceDeck(state: DeckState, event: DeckEvent): DeckState {
  switch (event.type) {
    case "keep": {
      const id = state.cards[state.index];
      if (id === undefined || !canKeep(state)) return state;
      return advance(state, id, "keep");
    }
    case "flag": {
      const id = state.cards[state.index];
      // Flagging the decide card does not decide: its choices stay as they are.
      return id === undefined ? state : advance(state, id, "flag");
    }
    case "back": {
      const previous = state.history.at(-1);
      if (previous === undefined) return state;
      const id = state.cards[previous];
      const verdicts = { ...state.verdicts };
      if (id !== undefined) delete verdicts[id];
      return { ...state, index: previous, history: state.history.slice(0, -1), verdicts };
    }
    case "note": {
      if (!state.cards.includes(event.card)) return state;
      const notes = { ...state.notes };
      if (event.text.trim() === "") delete notes[event.card];
      else notes[event.card] = event.text;
      return { ...state, notes };
    }
    case "choose": {
      const choices = { ...state.choices };
      if (event.choice === null) delete choices[event.key];
      else choices[event.key] = event.choice;
      return { ...state, choices };
    }
    case "jump": {
      const index = Math.min(Math.max(0, Math.floor(event.index)), state.cards.length);
      if (!Number.isFinite(index) || index === state.index) return state;
      return { ...state, index, history: [...state.history, state.index] };
    }
  }
}

/** The cards flagged so far, in deck order. */
function flaggedOf(state: DeckState): ReviewCardId[] {
  return state.cards.filter((id) => state.verdicts[id] === "flag");
}

export function deckProgress(state: DeckState): {
  /** Cards passed (the current card is number `done + 1`). */
  readonly done: number;
  readonly total: number;
  readonly flagged: ReviewCardId[];
} {
  return {
    done: Math.min(state.index, state.cards.length),
    total: state.cards.length,
    flagged: flaggedOf(state),
  };
}

/** The exact `saveReview` session of the deck as it stands. */
export function deckSession(
  state: DeckState,
  decideItems: readonly DeckDecideItem[],
  now: number,
): ReviewSession {
  const elapsed = Math.round((now - state.startedAt) / MINUTE_MS);
  return {
    cards: state.cards.map((id) => ({ id, verdict: state.verdicts[id] ?? "keep" })),
    agenda: state.cards.flatMap((card) => {
      const note = state.notes[card]?.trim() || null;
      return state.verdicts[card] === "flag" || note !== null ? [{ card, note }] : [];
    }),
    decisions: decideItems.flatMap((item) => {
      const choice = state.choices[item.key];
      return choice === undefined ? [] : [{ subject: item.title.slice(0, MAX_SUBJECT), choice }];
    }),
    skipped: state.skipped.map((s) => ({ id: s.id, reason: s.reason.slice(0, MAX_REASON) })),
    minutes: Number.isFinite(elapsed) ? Math.min(MAX_MINUTES, Math.max(1, elapsed)) : 0,
  };
}

/** The summary card: cards clear, cards to come back to, the decide items and their choices. */
export function summaryOf(
  state: DeckState,
  decideItems: readonly DeckDecideItem[],
): {
  readonly clear: number;
  readonly flagged: ReviewCardId[];
  readonly decisions: { readonly title: string; readonly choice: DecideChoice | null }[];
  /** Nothing flagged: the review is done (else it is saved with the flagged cards as its agenda). */
  readonly done: boolean;
} {
  const flagged = flaggedOf(state);
  return {
    clear: state.cards.length - flagged.length,
    flagged,
    decisions: decideItems
      .filter(needsChoice)
      .map((item) => ({ title: item.title, choice: state.choices[item.key] ?? null })),
    done: flagged.length === 0,
  };
}
