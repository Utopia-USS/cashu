// The weekly review deck (full-screen modal, prototype `review`): the review query's cards one at a
// time, from the general to the specific, the decide card last, then the summary. The query result is
// frozen on its first ready value, so a write in the middle of the deck (a decision, a watched idea)
// never reshuffles it; the ideas' state alone stays live. Each card is kept ("Got it, next", swipe
// right) or flagged ("Come back to this", swipe left); the decide card is kept only once every item
// with a lead signal has a choice, and its choices are written when the card is left. The summary's
// primary saves the review (`saveReview`, the flagged cards as its agenda); the close button saves
// nothing. The deck state itself is the shared pure reducer (`@cashu/ui-logic`).
import { D, type Decimal, Money } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import { researchScreenCommands } from "@cashu/store/investments/research-screen";
import {
  type ReviewDecideItem,
  type ReviewScreenResult,
  reviewPositionDecision,
  saveReview,
} from "@cashu/store/investments/review-screen";
import { signalsOwnerCommands } from "@cashu/store/investments/signals-screen";
import { useCommand, useQuery } from "@cashu/store-react";
import {
  canKeep,
  currentCard,
  type DecideChoice,
  type DeckEvent,
  type DeckSkip,
  type DeckState,
  deckProgress,
  deckSession,
  initialDeck,
  needsChoice,
  type ReviewCardId,
  reduceDeck,
  summaryOf,
} from "@cashu/ui-logic/investments/v2/reviewDeckState";
import { useRef, useState } from "react";
import { useServices } from "../../services/ServicesProvider";
import { S } from "./Review.strings";

const research = researchScreenCommands();

/** The phone shows at most this many cards (the seven card kinds). */
const MAX_CARDS = 7;
const MAX_EVENTS = 4;
const MAX_CALENDAR = 4;

type Current = Extract<ReviewScreenResult, { status: "current" }>;

// --------------------------------------------------------------------------- card models

type Tone = "positive" | "negative" | "warning" | "neutral";

export interface WorldCard {
  readonly kind: "world";
  /** The week's portfolio move (ratio); null without history. */
  readonly move: Decimal | null;
  /** The portfolio's value change in the base currency this week; null when unknown. */
  readonly change: Money | null;
  readonly benchmark: Decimal | null;
  readonly drawdown: Decimal | null;
  readonly maxDrawdown: Decimal | null;
  readonly sigma: Decimal | null;
}
export interface SectorsCard {
  readonly kind: "sectors";
  readonly rows: readonly {
    readonly key: string;
    readonly label: string;
    readonly weight: Decimal | null;
    readonly contribution: Decimal;
  }[];
}
export interface PositionsCard {
  readonly kind: "positions";
  readonly down: readonly { readonly id: string; readonly label: string; readonly ret: Decimal }[];
  readonly up: readonly { readonly id: string; readonly label: string; readonly ret: Decimal }[];
}
export interface EventsCard {
  readonly kind: "events";
  readonly rows: readonly {
    readonly id: string;
    readonly subject: string | null;
    readonly title: string;
    readonly relation: { readonly text: string; readonly tone: Tone } | null;
  }[];
  readonly brief: string | null;
}
export interface IdeaRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** Live: watched or dismissed since the deck opened. */
  readonly state: "open" | "watching" | "dismissed";
  /** The candidate's instrument is in this vault (else it is watched from the Mac). */
  readonly canWatch: boolean;
  onWatch(): Promise<void>;
  onDismiss(): Promise<void>;
}
export interface IdeasCard {
  readonly kind: "ideas";
  readonly rows: readonly IdeaRow[];
  readonly error: string | null;
}
export interface CalendarCard {
  readonly kind: "calendar";
  readonly rows: readonly { readonly key: string; readonly date: string; readonly title: string }[];
}
export interface DecideRow {
  readonly key: string;
  readonly title: string;
  readonly why: string;
  readonly facts: readonly string[];
  /** `choose`: the decision Seg; `mac`: a proposal that waits on the Mac; `info`: nothing to choose. */
  readonly mode: "choose" | "mac" | "info";
  readonly choice: DecideChoice | null;
  /** Written to the journal already (when the card was left): the choice is locked. */
  readonly saved: boolean;
  readonly reason: string;
  onChoose(choice: DecideChoice): void;
  onReason(text: string): void;
}
export interface DecideCard {
  readonly kind: "decide";
  readonly rows: readonly DecideRow[];
  readonly choices: readonly (readonly [label: string, value: DecideChoice])[];
}

export type CardBody =
  | WorldCard
  | SectorsCard
  | PositionsCard
  | EventsCard
  | IdeasCard
  | CalendarCard
  | DecideCard;

export interface CardModel {
  readonly id: ReviewCardId;
  readonly eyebrow: string;
  readonly title: string;
  readonly body: CardBody;
}

export interface DeckProgress {
  readonly total: number;
  readonly done: number;
  /** Indexes of the cards flagged so far. */
  readonly flagged: readonly number[];
}

export interface SummaryModel {
  readonly title: string;
  readonly clear: number;
  /** "n cards wait for you on your Mac"; null when nothing is flagged. */
  readonly waiting: string | null;
  readonly decisions: readonly { readonly title: string; readonly choice: string }[];
  /** "Skipped this week: ..."; null when nothing was skipped. */
  readonly skipped: string | null;
}

export type ReviewDeckState =
  | { readonly kind: "unavailable"; onClose(): void }
  | {
      readonly kind: "card";
      readonly progress: DeckProgress;
      readonly step: string;
      readonly card: CardModel;
      /** The next card's eyebrow and title, drawn behind the top one. */
      readonly next: { readonly eyebrow: string; readonly title: string } | null;
      /** "Got it, next" (or "Save and next") is allowed; false on the decide card without choices. */
      readonly canKeep: boolean;
      readonly keepLabel: string;
      readonly isSaving: boolean;
      readonly error: string | null;
      onKeep(): Promise<void>;
      onFlag(): Promise<void>;
      onBack: (() => void) | null;
      onClose(): void;
    }
  | {
      readonly kind: "summary";
      readonly progress: DeckProgress;
      readonly summary: SummaryModel;
      readonly primaryLabel: string;
      readonly isSaving: boolean;
      readonly error: string | null;
      onDone(): Promise<void>;
      onBack: (() => void) | null;
      onClose(): void;
    };

// --------------------------------------------------------------------------- pure helpers

const ratio = (value: number | null | undefined): Decimal | null =>
  value === null || value === undefined || !Number.isFinite(value) ? null : D(String(value));

const CARD_NAME: Record<ReviewCardId, () => string> = {
  world: () => S.cardWorld,
  sectors: () => S.cardSectors,
  positions: () => S.cardPositions,
  events: () => S.cardEvents,
  ideas: () => S.cardIdeas,
  calendar: () => S.cardCalendar,
  decide: () => S.cardDecide,
};

const CHOICE_LABEL: Record<DecideChoice, () => string> = {
  held: () => S.choiceHeld,
  bought: () => S.choiceBought,
  sold: () => S.choiceSold,
};

/** The calendar rows that touch the portfolio, when the query has a calendar. */
function calendarRows(result: Current): CalendarCard["rows"] {
  if (result.calendar.status !== "current") return [];
  return result.calendar.value.events
    .filter((e) => e.held !== null || e.note_id !== null)
    .slice(0, MAX_CALENDAR)
    .map((e, i) => ({ key: `${e.date}:${i}`, date: e.date, title: e.label ?? e.title }));
}

/** The deck's cards (in the query's order, at most seven) and what the phone skips with them. */
function deckCardsOf(result: Current): {
  readonly cards: ReviewCardId[];
  readonly skipped: DeckSkip[];
} {
  const skipped: DeckSkip[] = result.skipped.map((s) => ({ id: s.id, reason: s.reason }));
  const cards = result.cards.filter((id) => {
    if (id !== "calendar" || calendarRows(result).length > 0) return true;
    skipped.push({
      id,
      reason: result.calendar.status === "current" ? "no_calendar" : result.calendar.reason,
    });
    return false;
  });
  return { cards: cards.slice(0, MAX_CARDS), skipped };
}

function worldTitle(verdict: Current["world"]["verdict"]): string {
  const { size, vs, down } = verdict;
  const base =
    size === "calm"
      ? down
        ? S.worldCalmDown
        : S.worldCalmUp
      : size === "strong"
        ? down
          ? S.worldStrongDown
          : S.worldStrongUp
        : size === "rare"
          ? down
            ? S.worldRareDown
            : S.worldRareUp
          : down
            ? S.worldDown
            : S.worldUp;
  const versus =
    vs === "inline" ? S.vsInline : vs === "worse" ? S.vsWorse : vs === "better" ? S.vsBetter : null;
  return S.worldTitle(base, versus);
}

function sectorsTitle(verdict: Current["sectorVerdict"]): string {
  switch (verdict.code) {
    case "empty":
      return S.sectorsEmpty;
    case "all_plus":
      return S.sectorsAllPlus;
    case "all_minus":
      return S.sectorsAllMinus;
    case "share":
      return S.sectorsShare(verdict.names.join(", "));
    case "spread":
      return S.sectorsSpread;
  }
}

function relationOf(relation: string): EventsCard["rows"][number]["relation"] {
  switch (relation) {
    case "invalidates":
      return { text: S.relInvalidates, tone: "negative" };
    case "weakens":
      return { text: S.relWeakens, tone: "warning" };
    case "supports":
      return { text: S.relSupports, tone: "positive" };
    case "fulfills":
      return { text: S.relFulfills, tone: "positive" };
    default:
      return null;
  }
}

/** The world, sectors, positions, events and calendar cards: read-only, from the frozen result. */
function staticCard(id: Exclude<ReviewCardId, "ideas" | "decide">, result: Current): CardModel {
  switch (id) {
    case "world": {
      const change = result.digest.value.change;
      return {
        id,
        eyebrow: S.eyebrowWorld,
        title: worldTitle(result.world.verdict),
        body: {
          kind: "world",
          move: ratio(result.world.move),
          change:
            result.hasData && change !== null
              ? new Money(D(change.toString()), result.digest.value.currency)
              : null,
          benchmark: ratio(result.world.benchmark),
          drawdown: ratio(result.world.drawdown),
          maxDrawdown: ratio(result.world.maxDrawdown),
          sigma: ratio(result.world.sigma),
        },
      };
    }
    case "sectors":
      return {
        id,
        eyebrow: S.eyebrowSectors,
        title: sectorsTitle(result.sectorVerdict),
        body: {
          kind: "sectors",
          rows: result.sectors.map((row) => ({
            key: row.key,
            label: row.currency ? S.currencyRow : row.label,
            weight: ratio(row.weight),
            contribution: D(String(row.contribution)),
          })),
        },
      };
    case "positions": {
      const rows = (list: readonly { id: string; label: string; ret: number }[]) =>
        list.map((row) => ({ id: row.id, label: row.label, ret: D(String(row.ret)) }));
      const moved = result.movers.all.filter((row) => Math.abs(row.ret) >= 0.03).length;
      return {
        id,
        eyebrow: S.eyebrowPositions,
        title: S.positionsTitle(moved, result.movers.all.length),
        body: { kind: "positions", down: rows(result.movers.down), up: rows(result.movers.up) },
      };
    }
    case "events": {
      const events = result.events.slice(0, MAX_EVENTS);
      const weakened = events.find(
        (e) => e.note.thesis_relation === "weakens" || e.note.thesis_relation === "invalidates",
      );
      const subject = weakened?.note.instrument?.name ?? weakened?.note.instrument?.label ?? null;
      return {
        id,
        eyebrow: S.eyebrowEvents,
        title: subject === null ? S.eventsTitle(events.length) : S.eventsWeakened(subject),
        body: {
          kind: "events",
          rows: events.map(({ note }) => ({
            id: note.id,
            subject: note.instrument?.label ?? note.segment_label ?? note.theme ?? null,
            title: note.title,
            relation: relationOf(note.thesis_relation),
          })),
          brief: result.riskBrief?.headline ?? result.riskBrief?.why ?? null,
        },
      };
    }
    case "calendar": {
      const rows = calendarRows(result);
      return {
        id,
        eyebrow: S.eyebrowCalendar,
        title: S.calendarTitle(rows.length),
        body: { kind: "calendar", rows },
      };
    }
  }
}

// --------------------------------------------------------------------------- the hook

export function useReviewDeck(args: {
  readonly today: string;
  readonly lang: UiLang;
  /** Open at this card index (deep link `?step=N`, dev and tests). */
  readonly step?: number | null;
  close(): void;
}): ReviewDeckState {
  const { moneyQueries } = useServices();
  const live = useQuery(moneyQueries.investments.review, {
    today: args.today,
    lang: args.lang,
    open: true,
  });
  const [frozen, setFrozen] = useState<Current | null>(live.status === "current" ? live : null);
  if (frozen === null && live.status === "current") setFrozen(live);
  const [state, setState] = useState<DeckState | null>(null);
  const [startedAt] = useState(() => Date.now());
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});
  const [written, setWritten] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [ideaError, setIdeaError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // `saving` reaches the buttons and the stack only on the next render: a double tap (or a swipe and
  // a tap) before that must not journal the choices twice.
  const busy = useRef(false);
  const decidePosition = useCommand(reviewPositionDecision);
  const decideSignal = useCommand(signalsOwnerCommands.decide);
  const save = useCommand(saveReview);
  const watch = useCommand(research.acceptCandidate);
  const dismiss = useCommand(research.dismissNote);

  if (frozen === null) return { kind: "unavailable", onClose: args.close };
  const result = frozen;
  const decideItems: readonly ReviewDecideItem[] = result.decide.items;
  // The deck starts from the frozen result on the first render that has one (and at `step`, if given).
  const initial = (): DeckState => {
    const { cards, skipped } = deckCardsOf(result);
    const start = initialDeck(cards, startedAt, { decide: decideItems, skipped });
    return args.step == null ? start : reduceDeck(start, { type: "jump", index: args.step });
  };
  const deck = state ?? initial();
  const dispatch = (event: DeckEvent) => setState((d) => reduceDeck(d ?? initial(), event));
  const progress = deckProgress(deck);
  const deckProgressModel: DeckProgress = {
    total: progress.total,
    done: progress.done,
    flagged: progress.flagged.map((id) => deck.cards.indexOf(id)),
  };
  const onBack = deck.history.length > 0 ? () => dispatch({ type: "back" }) : null;

  /** Journal the decide card's choices not written yet; false when one was refused. */
  const writeChoices = async (): Promise<boolean> => {
    for (const item of decideItems) {
      const choice = deck.choices[item.key];
      if (choice === undefined || written.has(item.key) || !needsChoice(item)) continue;
      const reason = reasons[item.key]?.trim() || null;
      const outcome =
        item.instrument !== null
          ? await decidePosition.run({
              instrument: item.instrument,
              signals: [...item.signals],
              action: choice,
              reason,
            })
          : item.lead !== undefined
            ? await decideSignal.run({ signal: item.lead.gid, action: choice, reason })
            : null;
      // Already decided elsewhere (no open signal left): nothing to write, the choice stands.
      if (
        outcome !== null &&
        outcome.kind !== "completed" &&
        !(outcome.kind === "refused" && outcome.reason === "no_open_signal")
      )
        return false;
      setWritten((prev) => new Set(prev).add(item.key));
    }
    return true;
  };

  /** Leave the current card forward; the decide card writes its choices first. */
  const leave = async (event: "keep" | "flag") => {
    if (busy.current) return;
    setError(null);
    if (event === "keep" && !canKeep(deck)) return;
    if (currentCard(deck).id === "decide") {
      busy.current = true;
      setSaving(true);
      try {
        const ok = await writeChoices();
        if (!ok) return setError(S.couldNotSave);
      } finally {
        busy.current = false;
        setSaving(false);
      }
    }
    dispatch({ type: event });
  };

  const now = currentCard(deck);
  if (now.id === "summary") {
    const summary = summaryOf(deck, decideItems);
    return {
      kind: "summary",
      progress: deckProgressModel,
      summary: {
        title: summary.done ? S.reviewDone : S.savedTitle,
        clear: summary.clear,
        waiting: summary.done ? null : S.cardsWaitOnMac(summary.flagged.length),
        decisions: summary.decisions.map((d) => ({
          title: d.title,
          choice: d.choice === null ? S.noDecisionYet : CHOICE_LABEL[d.choice](),
        })),
        skipped:
          deck.skipped.length === 0
            ? null
            : S.skipped(deck.skipped.map((s) => CARD_NAME[s.id]()).join(", ")),
      },
      primaryLabel: summary.done ? S.markDone : S.done,
      isSaving: saving || save.isPending,
      error,
      onDone: async () => {
        if (busy.current) return;
        busy.current = true;
        setError(null);
        setSaving(true);
        try {
          const outcome = await save.run({
            notes: null,
            session: deckSession(deck, decideItems, Date.now()),
          });
          if (outcome.kind !== "completed") return setError(S.couldNotSave);
          args.close();
        } finally {
          busy.current = false;
          setSaving(false);
        }
      },
      onBack,
      onClose: args.close,
    };
  }

  // The ideas' accepted / dismissed state stays live.
  const liveStates = (live.status === "current" ? live : result).candidateStates;
  const cardModel = (id: ReviewCardId): CardModel => {
    if (id === "ideas") {
      const ideas = result.ideas;
      return {
        id,
        eyebrow: S.eyebrowIdeas(ideas.length),
        title: ideas.length === 1 ? (ideas[0]?.title ?? "") : S.ideasTitle(ideas.length),
        body: {
          kind: "ideas",
          error: ideaError,
          rows: ideas.map((note) => {
            const state = liveStates.find((s) => s.id === note.id);
            return {
              id: note.id,
              title: note.title,
              body: note.summary,
              state: state?.accepted ? "watching" : state?.dismissed ? "dismissed" : "open",
              canWatch: note.instrument !== null,
              onWatch: async () => {
                setIdeaError(null);
                const outcome = await watch.run({ note: note.id, lang: args.lang });
                if (outcome.kind !== "completed") setIdeaError(S.couldNotSave);
              },
              onDismiss: async () => {
                setIdeaError(null);
                const outcome = await dismiss.run({ note: note.id, lang: args.lang });
                if (outcome.kind !== "completed") setIdeaError(S.couldNotSave);
              },
            };
          }),
        },
      };
    }
    if (id === "decide") {
      return {
        id,
        eyebrow: S.eyebrowDecide(decideItems.length),
        title:
          decideItems.length === 1
            ? S.decideOne(decideItems[0]?.title ?? "")
            : S.decideMany(decideItems.length),
        body: {
          kind: "decide",
          choices: [
            [S.choiceHeld, "held"],
            [S.choiceBought, "bought"],
            [S.choiceSold, "sold"],
          ],
          rows: decideItems.map((item) => ({
            key: item.key,
            title: item.title,
            why: item.why,
            facts: item.facts,
            mode: item.kind === "proposal" ? "mac" : needsChoice(item) ? "choose" : "info",
            choice: deck.choices[item.key] ?? null,
            saved: written.has(item.key),
            reason: reasons[item.key] ?? "",
            onChoose: (choice) => {
              if (!written.has(item.key)) dispatch({ type: "choose", key: item.key, choice });
            },
            onReason: (text) => setReasons((prev) => ({ ...prev, [item.key]: text })),
          })),
        },
      };
    }
    return staticCard(id, result);
  };

  const card = cardModel(now.id);
  const behindId = deck.cards[deck.index + 1];
  const behind = behindId === undefined ? null : cardModel(behindId);
  const onDecide = now.id === "decide";
  return {
    kind: "card",
    progress: deckProgressModel,
    step: S.stepOf(deck.index + 1, deck.cards.length),
    card,
    next: behind === null ? null : { eyebrow: behind.eyebrow, title: behind.title },
    canKeep: canKeep(deck),
    keepLabel: onDecide ? S.saveAndNext : S.keep,
    isSaving: saving,
    error,
    onKeep: () => leave("keep"),
    onFlag: () => leave("flag"),
    onBack,
    onClose: args.close,
  };
}
