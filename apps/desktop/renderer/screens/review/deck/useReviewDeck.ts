// The review deck's state (ab24ab6 v2/ReviewDeck.tsx ReviewDeck, lines 123-250): the deck built once when the
// data has arrived, the current card, verdicts, card notes, "Czytaj więcej", decisions, the note sheet and the
// swipe fly-out; every text formatted by reviewDeckModel.ts. ReviewDeckView renders what this returns.
import { C } from "@cashu/i18n/core/common.strings";
import { S as U } from "@cashu/i18n/investments/undo.strings";
import { S } from "@cashu/i18n/investments/v2/ReviewDeck.strings";
import { S as RS } from "@cashu/i18n/investments/v2/research/data.strings";
import { useToast } from "@cashu/ui";
import { label } from "@cashu/ui-logic/core/messages";
import { dm } from "@cashu/ui-logic/investments/labels";
import { noteSubject } from "@cashu/ui-logic/investments/v2/research/logic";
import type { ResearchNote } from "@cashu/ui-logic/investments/v2/research/types";
import { CARD_TITLE, type CardId } from "@cashu/ui-logic/investments/v2/reviewDeckLogic";
import type { DigestV2, Performance } from "@cashu/ui-logic/investments/v2/types";
import { useState } from "react";
import {
  agendaOf,
  type BuiltDeck,
  type Card,
  type CardContext,
  type CardModel,
  cardModel,
  type SheetModel,
  type SummaryModel,
  sheetModel,
  summaryModel,
} from "./reviewDeckModel.js";
import {
  type DeckStats,
  type ReviewDeckData,
  useReviewDeckCommands,
  type Verdict,
} from "./useReviewDeckData.js";

export interface ReviewDeckScreenProps {
  /** `useReviewDeckData(...)`: the Home holds it (the hero badge and the rail count the same cards). */
  data: ReviewDeckData;
  digest: DigestV2;
  /** The week's performance (the Home's 1m series): the currency of the week's money move. */
  perfWeek: Performance | null | undefined;
  /** The review is being saved: "Zamknij przegląd" is disabled. */
  busy?: boolean;
  /** A drawer opened from a card lies over the home: the deck hides meanwhile and keeps its place. */
  suspended?: boolean;
  /** The closing note (the caller keeps the draft for this window and sends it with the review). */
  note: string;
  onNote(value: string): void;
  onClose(): void;
  /** "Zamknij przegląd": the deck's cards, verdicts, agenda and decisions, and the skipped cards with why. */
  onDone(input: { deck: DeckStats; skipped: { id: CardId; why: string }[] }): void;
  /** A proposal item's action: the caller opens the proposal (legacy id, `gidOf`). */
  onOpenProposal(id: number): void;
}

export type DotLook = "on" | "keep" | "flag" | "";
export type StackEntry =
  | { kind: "back"; key: Card; depth: number }
  | { kind: "peek"; key: CardId; card: CardModel }
  | { kind: "summary"; key: "summary"; summary: SummaryModel }
  | {
      kind: "top";
      key: CardId;
      card: CardModel;
      detail: boolean;
      noteOpen: boolean;
      note: string;
    };

const snapshot = (data: ReviewDeckData): BuiltDeck => ({
  ...data.live,
  cards: [...data.live.cards, "summary"],
});

export function useReviewDeck(props: ReviewDeckScreenProps) {
  const { data, digest } = props;
  const commands = useReviewDeckCommands();
  const toast = useToast();
  const title = digest.review?.name ?? S.weeklyReview;

  // ---- the deck, built once when the data has arrived (decisions taken on it do not reshuffle the cards) ----
  const [built, setBuilt] = useState<BuiltDeck | null>(() => (data.ready ? snapshot(data) : null));
  if (!built && data.ready) setBuilt(snapshot(data));

  // ---- deck state ---------------------------------------------------------------------------------------------
  const [i, setI] = useState(0);
  const [hist, setHist] = useState<number[]>([]);
  const [verdicts, setVerdicts] = useState<Partial<Record<CardId, Verdict>>>({});
  const [notes, setNotes] = useState<Partial<Record<CardId, string>>>({});
  const [noteOpen, setNoteOpen] = useState<Partial<Record<CardId, boolean>>>({});
  const [detail, setDetail] = useState(false);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [sheet, setSheet] = useState<ResearchNote | null>(null);
  const [flying, setFlying] = useState<Verdict | null>(null);
  const cards = built?.cards ?? [];
  const current = cards[i];

  const advance = (v: Verdict) => {
    if (!current || current === "summary" || flying) return;
    setFlying(v);
    window.setTimeout(
      () => {
        setVerdicts((m) => ({ ...m, [current]: v }));
        setHist((h) => [...h, i]);
        setI((k) => k + 1);
        setDetail(false);
        setFlying(null);
      },
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240,
    );
  };
  const undo = () => {
    const k = hist.at(-1);
    if (k === undefined) return;
    setHist((h) => h.slice(0, -1));
    setVerdicts((m) => {
      const n = { ...m };
      delete n[cards[k] as CardId];
      return n;
    });
    setI(k);
    setDetail(false);
  };
  const toggleNote = () => {
    if (current && current !== "summary") setNoteOpen((m) => ({ ...m, [current]: !m[current] }));
  };

  const openNote = (noteId: number) => {
    const found =
      data.notesQ.data.find((n) => n.id === noteId) ??
      data.research.candidates.find((n) => n.id === noteId) ??
      data.allNotes.find((n) => n.id === noteId);
    if (found) setSheet(found);
    else toast(S.noteLoadFailed(label("error.not_found") ?? "not_found"), 4000);
  };

  const decide = async (key: string, action: string, choice: string) => {
    const item = built?.decide.find((d) => d.key === key);
    if (!item || pending) return;
    if (item.kind === "proposal") {
      if (item.proposalId != null) props.onOpenProposal(item.proposalId);
      return;
    }
    if (item.kind === "thesis") {
      setChoices((c) => ({ ...c, [key]: choice }));
      return;
    }
    setPending(key);
    try {
      const failed = await commands.decide(item, action);
      if (failed) toast(failed, 5000);
      else setChoices((c) => ({ ...c, [key]: choice }));
    } finally {
      setPending(null);
    }
  };

  /** The Okazje card's answers (old research/data.ts useResearchActions): the write, then a toast with undo. */
  const offerUndo = (text: string, what: string, run: () => Promise<string | null>) => {
    const retry = () => {
      void run().then((failed) => {
        if (failed) toast(U.failed(what), 8000, { label: C.undo, onClick: retry });
        else toast(U.done(what), 3000);
      });
    };
    toast(text, 10000, { label: C.undo, onClick: retry });
  };
  const idea = (id: number) => built?.ideas.find((n) => n.id === id);
  const watch = async (id: number) => {
    const n = idea(id);
    if (!n) return;
    const failed = await commands.watch(n);
    if (failed) {
      toast(RS.notWatched(failed), 5000);
      return;
    }
    setChoices((c) => ({ ...c, [`i:${id}`]: S.watching }));
    offerUndo(RS.watched(noteSubject(n).name), RS.whatWatch, () => commands.unwatch(n));
  };
  const dismiss = async (id: number) => {
    const n = idea(id);
    if (!n) return;
    const failed = await commands.dismiss(n);
    if (failed) {
      toast(RS.notDismissed(failed), 5000);
      return;
    }
    setChoices((c) => ({ ...c, [`i:${id}`]: S.dismissed }));
    offerUndo(RS.candidateDismissed(noteSubject(n).name), RS.whatCandidateDismiss, () =>
      commands.restore(n),
    );
  };

  const finish = () => {
    if (!built) return;
    const { shown, agenda } = agendaOf(built, verdicts, notes);
    props.onDone({
      deck: {
        cards: shown.map((id) => ({ id, verdict: verdicts[id] ?? "keep" })),
        agenda: agenda.map((id) => ({
          card: id,
          title: CARD_TITLE[id],
          note: (notes[id] ?? "").trim() || null,
        })),
        decisions: built.decide
          .filter((d) => choices[d.key])
          .map((d) => ({ subject: d.title, choice: choices[d.key] ?? "" })),
        skipped: built.skipped.map((s) => s.id),
      },
      skipped: built.skipped,
    });
  };

  /** A key on the deck (old onKey; the View skips keys typed into a field). True when handled. */
  const onKey = (key: string): boolean => {
    if (sheet) return false;
    if (key === "ArrowRight") advance("keep");
    else if (key === "ArrowLeft") advance("flag");
    else if (key === "ArrowUp" && current !== "summary") setDetail(true);
    else if (key === "ArrowDown") setDetail(false);
    else if (key === "z" || key === "Backspace") undo();
    else if (key === "n" && current && current !== "summary") toggleNote();
    else return false;
    return true;
  };

  // ---- what the View shows ------------------------------------------------------------------------------
  const ctx: CardContext = {
    data,
    digest,
    perfWeek: props.perfWeek,
    built,
    choices,
    pending,
    noteBusy: commands.noteBusy,
  };
  const left = cards.length ? cards.length - 1 - i : 0;
  // Painted back to front: the next card shows through while the top one flies off.
  const stack: StackEntry[] = !built
    ? []
    : cards
        .slice(i, i + 3)
        .reverse()
        .map((c): StackEntry => {
          const depth = cards.indexOf(c) - i;
          if (depth > 1 || (depth === 1 && c === "summary")) return { kind: "back", key: c, depth };
          if (c === "summary")
            return {
              kind: "summary",
              key: c,
              summary: summaryModel(built, verdicts, notes, choices),
            };
          if (depth === 1) return { kind: "peek", key: c, card: cardModel(c, ctx) };
          return {
            kind: "top",
            key: c,
            card: cardModel(c, ctx),
            detail,
            noteOpen: !!noteOpen[c],
            note: notes[c] ?? "",
          };
        });

  return {
    title,
    heading: !built ? title : current === "summary" ? S.lastCard : S.left(left),
    sub: `${title} · ${dm(digest.since)} - ${dm(digest.as_of)}`,
    built: built !== null,
    index: i,
    dots: cards.map(
      (c, k): DotLook => (k === i ? "on" : c !== "summary" ? (verdicts[c] ?? "") : ""),
    ),
    stack,
    flying,
    showButtons: built !== null && current !== "summary",
    canUndo: hist.length > 0,
    suspended: !!props.suspended,
    busy: !!props.busy,
    closing: props.note,
    sheet: sheet ? sheetModel(sheet) : (null as SheetModel | null),
    onClose: props.onClose,
    /** Escape / back on the deck: collapse "Czytaj więcej" first, else close (the sheet closes itself). */
    onEscape: (): void => {
      if (detail) setDetail(false);
      else props.onClose();
    },
    onUndo: undo,
    onAdvance: advance,
    onDetail: setDetail,
    onToggleNote: toggleNote,
    onCardNote: (value: string) => {
      if (current && current !== "summary") setNotes((m) => ({ ...m, [current]: value }));
    },
    onOpenNote: openNote,
    onSheetClosed: () => setSheet(null),
    onDecide: (key: string, action: string, choice: string): void => {
      void decide(key, action, choice);
    },
    onWatch: (id: number): void => {
      void watch(id);
    },
    onDismiss: (id: number): void => {
      void dismiss(id);
    },
    onClosing: props.onNote,
    onFinish: finish,
    onKey,
  };
}
export type ReviewDeckState = ReturnType<typeof useReviewDeck>;
