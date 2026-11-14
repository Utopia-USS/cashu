import { describe, expect, it } from "vitest";
import {
  canKeep,
  currentCard,
  type DeckDecideItem,
  type DeckState,
  deckProgress,
  deckSession,
  initialDeck,
  type ReviewCardId,
  reduceDeck,
  summaryOf,
} from "./reviewDeckState.js";

const T0 = Date.parse("2026-11-15T09:00:00Z");
const CARDS: ReviewCardId[] = ["world", "positions", "events", "ideas", "decide"];
const DECIDE: DeckDecideItem[] = [
  { key: "s:alpha", kind: "subject", title: "Alpha SA", lead: { gid: "sig-1" } },
  { key: "t:beta", kind: "thesis", title: "Beta ETF" },
  { key: "p:gamma", kind: "proposal", title: "Raise the bond target", lead: { gid: "sig-2" } },
];

const deck = (cards: readonly ReviewCardId[] = CARDS) =>
  initialDeck(cards, T0, {
    decide: DECIDE,
    skipped: [{ id: "sectors", reason: "no_sectors" }],
  });
const run = (state: DeckState, ...events: Parameters<typeof reduceDeck>[1][]) =>
  events.reduce(reduceDeck, state);

describe("initialDeck", () => {
  it("starts on the first card with nothing decided; only lead items that are not proposals need a choice", () => {
    const state = deck();
    expect(state.index).toBe(0);
    expect(currentCard(state)).toEqual({ id: "world" });
    expect(state.required).toEqual(["s:alpha"]);
    expect(state.verdicts).toEqual({});
    expect(state.choices).toEqual({});
    expect(state.startedAt).toBe(T0);
  });

  it("an empty deck opens on the summary", () => {
    expect(currentCard(initialDeck([], T0))).toEqual({ id: "summary" });
  });
});

describe("reduceDeck", () => {
  it("keep and flag record the verdict and advance", () => {
    const state = run(deck(), { type: "keep" }, { type: "flag" });
    expect(state.index).toBe(2);
    expect(state.verdicts).toEqual({ world: "keep", positions: "flag" });
    expect(state.history).toEqual([0, 1]);
    expect(deckProgress(state)).toEqual({ done: 2, total: 5, flagged: ["positions"] });
  });

  it("back returns to the card left last and clears its verdict", () => {
    const state = run(deck(), { type: "keep" }, { type: "flag" }, { type: "back" });
    expect(state.index).toBe(1);
    expect(state.verdicts).toEqual({ world: "keep" });
    expect(state.history).toEqual([0]);
    const start = deck();
    expect(reduceDeck(start, { type: "back" })).toBe(start);
  });

  it("the decide card cannot be kept until every lead item has a choice", () => {
    const atDecide = run(deck(), { type: "jump", index: 4 });
    expect(currentCard(atDecide)).toEqual({ id: "decide" });
    expect(canKeep(atDecide)).toBe(false);
    expect(reduceDeck(atDecide, { type: "keep" })).toBe(atDecide);
    const chosen = reduceDeck(atDecide, { type: "choose", key: "s:alpha", choice: "held" });
    expect(canKeep(chosen)).toBe(true);
    const kept = reduceDeck(chosen, { type: "keep" });
    expect(currentCard(kept)).toEqual({ id: "summary" });
    expect(kept.verdicts.decide).toBe("keep");
  });

  it("flagging the decide card is allowed without a choice and decides nothing", () => {
    const state = run(deck(), { type: "jump", index: 4 }, { type: "flag" });
    expect(state.verdicts.decide).toBe("flag");
    expect(state.choices).toEqual({});
    expect(currentCard(state)).toEqual({ id: "summary" });
  });

  it("a choice can be changed and cleared", () => {
    const state = run(
      deck(),
      { type: "choose", key: "s:alpha", choice: "bought" },
      { type: "choose", key: "s:alpha", choice: "sold" },
    );
    expect(state.choices).toEqual({ "s:alpha": "sold" });
    expect(reduceDeck(state, { type: "choose", key: "s:alpha", choice: null }).choices).toEqual({});
  });

  it("notes are kept per shown card; a blank note removes it; an unknown card is ignored", () => {
    const state = run(
      deck(),
      { type: "note", card: "events", text: "Check the call" },
      { type: "note", card: "world", text: "x" },
      { type: "note", card: "world", text: "   " },
    );
    expect(state.notes).toEqual({ events: "Check the call" });
    expect(reduceDeck(state, { type: "note", card: "calendar", text: "no" })).toBe(state);
  });

  it("jump clamps to the summary and records the way back", () => {
    const state = reduceDeck(deck(), { type: "jump", index: 99 });
    expect(state.index).toBe(5);
    expect(currentCard(state)).toEqual({ id: "summary" });
    expect(reduceDeck(state, { type: "back" }).index).toBe(0);
    expect(reduceDeck(deck(), { type: "jump", index: -3 }).index).toBe(0);
    const same = deck();
    expect(reduceDeck(same, { type: "jump", index: 0 })).toBe(same);
    expect(reduceDeck(same, { type: "jump", index: Number.NaN })).toBe(same);
  });

  it("keep and flag on the summary change nothing", () => {
    const summary = reduceDeck(deck(), { type: "jump", index: 5 });
    expect(reduceDeck(summary, { type: "keep" })).toBe(summary);
    expect(reduceDeck(summary, { type: "flag" })).toBe(summary);
  });
});

/** The `reviewSessionSchema` contract, asserted by hand (this package does not depend on the store). */
function expectSessionShape(session: ReturnType<typeof deckSession>) {
  const cards = new Set(["world", "sectors", "positions", "events", "ideas", "calendar", "decide"]);
  expect(session.cards.length).toBeLessThanOrEqual(7);
  for (const c of session.cards) {
    expect(cards.has(c.id)).toBe(true);
    expect(["keep", "flag"]).toContain(c.verdict);
  }
  expect(session.agenda.length).toBeLessThanOrEqual(7);
  for (const a of session.agenda) {
    expect(cards.has(a.card)).toBe(true);
    expect(a.note === null || a.note.trim().length <= 4000).toBe(true);
  }
  for (const d of session.decisions) {
    expect(d.subject.length).toBeLessThanOrEqual(200);
    expect(d.choice.length).toBeLessThanOrEqual(80);
  }
  for (const s of session.skipped) {
    expect(cards.has(s.id)).toBe(true);
    expect(s.reason.length).toBeLessThanOrEqual(200);
  }
  expect(Number.isInteger(session.minutes)).toBe(true);
  expect(session.minutes).toBeGreaterThanOrEqual(0);
  expect(session.minutes).toBeLessThanOrEqual(525600);
  expect(Object.keys(session).sort()).toEqual([
    "agenda",
    "cards",
    "decisions",
    "minutes",
    "skipped",
  ]);
}

describe("deckSession", () => {
  it("is the saveReview session: verdicts, flagged or noted cards as the agenda, choices, skipped, minutes", () => {
    const state = run(
      deck(),
      { type: "keep" },
      { type: "flag" },
      { type: "note", card: "events", text: "  Ask about the delay  " },
      { type: "keep" },
      { type: "keep" },
      { type: "choose", key: "s:alpha", choice: "held" },
      { type: "keep" },
    );
    const session = deckSession(state, DECIDE, T0 + 7 * 60_000 + 20_000);
    expect(session).toEqual({
      cards: [
        { id: "world", verdict: "keep" },
        { id: "positions", verdict: "flag" },
        { id: "events", verdict: "keep" },
        { id: "ideas", verdict: "keep" },
        { id: "decide", verdict: "keep" },
      ],
      agenda: [
        { card: "positions", note: null },
        { card: "events", note: "Ask about the delay" },
      ],
      decisions: [{ subject: "Alpha SA", choice: "held" }],
      skipped: [{ id: "sectors", reason: "no_sectors" }],
      minutes: 7,
    });
    expectSessionShape(session);
  });

  it("counts at least one minute, caps long subjects and treats unseen cards as kept", () => {
    const long: DeckDecideItem = {
      key: "s:long",
      kind: "subject",
      title: "x".repeat(260),
      lead: {},
    };
    const state = run(initialDeck(["world", "decide"], T0, { decide: [long] }), {
      type: "choose",
      key: "s:long",
      choice: "bought",
    });
    const session = deckSession(state, [long], T0 + 5_000);
    expect(session.minutes).toBe(1);
    expect(session.decisions[0]?.subject).toHaveLength(200);
    expect(session.cards).toEqual([
      { id: "world", verdict: "keep" },
      { id: "decide", verdict: "keep" },
    ]);
    expectSessionShape(session);
  });
});

describe("summaryOf", () => {
  it("without flags the review is done; the lead items list their choice", () => {
    const state = run(
      deck(),
      { type: "keep" },
      { type: "keep" },
      { type: "keep" },
      { type: "keep" },
      { type: "choose", key: "s:alpha", choice: "bought" },
      { type: "keep" },
    );
    expect(summaryOf(state, DECIDE)).toEqual({
      clear: 5,
      flagged: [],
      decisions: [{ title: "Alpha SA", choice: "bought" }],
      done: true,
    });
  });

  it("with flags it is not done and names the flagged cards in deck order", () => {
    const state = run(
      deck(),
      { type: "flag" },
      { type: "keep" },
      { type: "flag" },
      { type: "keep" },
      { type: "flag" },
    );
    expect(summaryOf(state, DECIDE)).toEqual({
      clear: 2,
      flagged: ["world", "events", "decide"],
      decisions: [{ title: "Alpha SA", choice: null }],
      done: false,
    });
  });
});
