import { addDays } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { researchScreenCommands } from "@cashu/store/investments/research-screen";
import type { ReviewDecideItem } from "@cashu/store/investments/review-screen";
import {
  reviewNotesSchema,
  reviewPositionDecision,
  reviewScreenQueries,
  saveReview,
} from "@cashu/store/investments/review-screen";
import {
  conditionalOwnerAcknowledge,
  saveSignalGroup,
  signalsSnooze,
} from "@cashu/store/investments/signals-screen";
import { useCommand, useProfile, useQuery, useUiAction } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useForm } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { useReviewMemory } from "./memory.js";
import {
  presentReviewIdea,
  presentReviewItem,
  type ReviewChoice,
  reviewChoiceLabel,
  reviewDisplayDates,
  reviewRiskMacro,
  reviewSkipReason,
} from "./presentation.js";
import { R } from "./Review.strings.js";
import {
  advanceSession,
  backSession,
  type ReviewSession,
  sessionAgenda,
  sessionCard,
  startSession,
} from "./session.js";
import { useReviewLifetime } from "./useReviewLifetime.js";

const queries = reviewScreenQueries(),
  research = researchScreenCommands();
export interface ReviewScreenProps {
  account?: string | null;
  onClosed(): void;
  onInstrumentOpened?(gid: string, note?: string): void;
  onResearchOpened?(input: { note?: string; topic?: string }): void;
  onProposalOpened?(gid: string, onResumed: () => void): boolean;
}
export function useReviewScreen(props: ReviewScreenProps) {
  const { privacy } = useUiEnv();
  const vault = useProfile(),
    today = useCalendarDay();
  const data = useQuery(queries.screen, {
    today,
    lang: lang(),
    account: props.account ?? null,
    open: true,
    privacy,
  });
  const memory = useReviewMemory.getState();
  const restored = memory.vault === vault ? memory.restored : null;
  const [initialClosing] = useState(
    () => restored?.closing ?? (memory.vault === vault ? memory.draft?.closing : null) ?? "",
  );
  const [startedAt] = useState(
    () => (memory.vault === vault ? memory.draft?.startedAt : null) ?? Date.now(),
  );
  const [session, setSession] = useState<ReviewSession | null>(
    () => restored?.session ?? (data.status === "current" ? startSession(data) : null),
  );
  const [detail, setDetail] = useState(false),
    [noteOpen, setNoteOpen] = useState(false),
    [suspended, setSuspended] = useState(false);
  const [reader, setReader] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [unknownItems, setUnknownItems] = useState<ReadonlySet<string>>(new Set());
  const [candidateChoices, setCandidateChoices] = useState<
    Readonly<Record<string, "watch" | "dismiss">>
  >({});
  const inFlight = useRef(false),
    completed = useRef(new Map<string, Set<string>>());
  const decisionReceipts = useRef(new Map<string, Set<string>>());
  const finish = useCommand(saveReview),
    position = useCommand(reviewPositionDecision),
    acknowledge = useCommand(conditionalOwnerAcknowledge);
  const snooze = useUiAction(signalsSnooze);
  const accept = useCommand(research.acceptCandidate),
    dismiss = useCommand(research.dismissNote),
    restore = useCommand(research.restoreNote),
    undoCandidate = useCommand(research.undoAcceptCandidate);
  const form = useForm({
    validators: { onChange: z.object({ closing: reviewNotesSchema }) },
    defaultValues: {
      closing: initialClosing,
    },
  });
  useEffect(() => {
    useReviewMemory.setState({ vault, restored: null });
  }, [vault]);
  if (session === null && data.status === "current") setSession(startSession(data));
  const captureLifetime = useReviewLifetime(vault, privacy);
  const card = session === null ? "summary" : sessionCard(session);
  const advance = (verdict: "keep" | "flag") => {
    if (!inFlight.current) {
      setSession((value) => (value === null ? value : advanceSession(value, verdict)));
      setDetail(false);
      setNoteOpen(false);
    }
  };
  const back = () => {
    if (!inFlight.current) {
      setSession((value) => (value === null ? value : backSession(value)));
      setDetail(false);
      setNoteOpen(false);
    }
  };
  const saveCardNote = (note: string) => {
    if (card !== "summary")
      setSession((value) =>
        value === null ? value : { ...value, notes: { ...value.notes, [card]: note.trim() } },
      );
    setNoteOpen(false);
  };
  const choose = async (item: ReviewDecideItem, action: ReviewChoice) => {
    const isCurrent = captureLifetime();
    if (!isCurrent()) return;
    if (inFlight.current || session === null || unknownItems.has(item.key)) return;
    if (item.kind === "proposal") {
      if (
        item.proposal &&
        props.onProposalOpened?.(item.proposal, () => {
          if (isCurrent()) setSuspended(false);
        })
      )
        setSuspended(true);
      else setNotice(R.unavailable);
      return;
    }
    if (item.kind === "thesis") {
      setSession({ ...session, choices: { ...session.choices, [item.key]: action } });
      return;
    }
    if (action === "review" || action === "keep") return;
    inFlight.current = true;
    setPending(item.key);
    setNotice(null);
    const done = completed.current.get(item.key) ?? new Set<string>();
    completed.current.set(item.key, done);
    try {
      if (action !== "snooze" && action !== "ack" && item.instrument !== null) {
        const result = await position.run({
          instrument: item.instrument,
          signals: [...item.signals],
          action,
          reason: R.ownerReason,
        });
        if (!result.ok) {
          if (isCurrent()) setNotice(R.failed);
          return;
        }
      } else if (action === "snooze") {
        for (const signal of item.signals) {
          if (!isCurrent()) return;
          if (done.has(signal)) continue;
          const result = await snooze.run({
            signal,
            until: addDays(
              (data.status === "current" ? data.now : session.snapshot.now).slice(0, 10),
              7,
            ),
          });
          if (result.status !== "completed") {
            if (isCurrent()) {
              setNotice(
                result.status === "outcome_unknown" ? R.unknown : done.size ? R.partial : R.failed,
              );
              if (result.status === "outcome_unknown")
                setUnknownItems((previous) => new Set([...previous, item.key]));
            }
            return;
          }
          done.add(signal);
          if (result.value.status === "saved_cleanup_unconfirmed" && isCurrent())
            setNotice(R.cleanup);
        }
      } else {
        const outcome = await saveSignalGroup(
          item.signals
            .filter((signal) => !done.has(signal))
            .map((signal) => async () => {
              const result = await acknowledge.run({ signal, reason: R.ownerReason });
              if (result.ok && result.value.decision !== null) done.add(signal);
              return result;
            }),
          isCurrent,
        );
        const receipts = decisionReceipts.current.get(item.key) ?? new Set<string>();
        for (const id of outcome.decisions) receipts.add(id);
        decisionReceipts.current.set(item.key, receipts);
        if (outcome.status === "skipped" && receipts.size === 0) {
          if (isCurrent()) setNotice(R.noRemainingSignals);
          return;
        }
        if (outcome.status !== "saved" && outcome.status !== "skipped") {
          if (isCurrent()) {
            setNotice(
              outcome.status === "unknown" ? R.unknown : receipts.size ? R.partial : R.failed,
            );
            if (outcome.status === "unknown")
              setUnknownItems((previous) => new Set([...previous, item.key]));
          }
          return;
        }
      }
      if (isCurrent())
        setSession((value) =>
          value === null ? value : { ...value, choices: { ...value.choices, [item.key]: action } },
        );
    } finally {
      inFlight.current = false;
      if (isCurrent()) setPending(null);
    }
  };
  const candidate = async (note: string, action: "watch" | "dismiss" | "undo") => {
    const isCurrent = captureLifetime();
    if (!isCurrent()) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(note);
    setNotice(null);
    try {
      const result =
        action === "watch"
          ? await accept.run({ note, lang: lang() })
          : action === "dismiss"
            ? await dismiss.run({ note, lang: lang() })
            : (
                  data.status === "current"
                    ? data.candidateStates.find((row) => row.id === note)?.accepted
                    : candidateChoices[note] === "watch"
                )
              ? await undoCandidate.run({ note })
              : await restore.run({ note, lang: lang() });
      if (!isCurrent()) return;
      if (!result.ok) {
        setNotice(
          result.reason === "unresolved_instrument" ||
            result.reason === "candidate_unresolved" ||
            result.reason === "no_instrument"
            ? R.unavailable
            : R.failed,
        );
        return;
      }
      setCandidateChoices((previous) => {
        const next = { ...previous };
        if (action === "undo") delete next[note];
        else next[note] = action;
        return next;
      });
    } finally {
      inFlight.current = false;
      if (isCurrent()) setPending(null);
    }
  };
  const save = async () => {
    const isCurrent = captureLifetime();
    if (!isCurrent()) return;
    if (inFlight.current || session === null) return;
    inFlight.current = true;
    setPending("finish");
    setNotice(null);
    try {
      const closing = form.state.values.closing.trim();
      if (!reviewNotesSchema.safeParse(closing).success) {
        setNotice(R.noteTooLong);
        return;
      }
      const result = await finish.run({
        notes: closing || null,
        session: {
          cards: session.snapshot.cards.map((id) => ({
            id,
            verdict: session.verdicts[id] ?? "keep",
          })),
          agenda: sessionAgenda(session),
          decisions: session.snapshot.decide.items.flatMap((item) =>
            session.choices[item.key]
              ? [{ subject: item.key, choice: session.choices[item.key] ?? "" }]
              : [],
          ),
          skipped: session.snapshot.skipped,
          minutes: Math.max(1, Math.round((Date.now() - startedAt) / 60000)),
        },
      });
      if (!isCurrent()) return;
      if (!result.ok) {
        setNotice(R.failed);
        return;
      }
      useReviewMemory.setState({
        vault,
        saved: { review: result.value.review, session, closing, savedAt: result.value.savedAt },
        restored: null,
        draft: null,
      });
      form.reset();
      props.onClosed();
    } finally {
      inFlight.current = false;
      if (isCurrent()) setPending(null);
    }
  };
  const close = () => {
    if (!inFlight.current) {
      useReviewMemory.setState({ vault, draft: { closing: form.state.values.closing, startedAt } });
      props.onClosed();
    }
  };
  return {
    ...props,
    onClosed: close,
    data,
    privacy,
    session,
    verdictRows:
      session?.snapshot.cards.map((id) => ({ id, verdict: session.verdicts[id] ?? "keep" })) ?? [],
    agenda: session === null ? [] : sessionAgenda(session),
    skips:
      session?.snapshot.skipped.map((row) => ({ ...row, label: reviewSkipReason(row.reason) })) ??
      [],
    chosen:
      session?.snapshot.decide.items.flatMap((row) =>
        session.choices[row.key]
          ? [
              {
                key: row.key,
                subject: presentReviewItem(row).title,
                label: reviewChoiceLabel(session.choices[row.key] ?? ""),
              },
            ]
          : [],
      ) ?? [],
    dates: reviewDisplayDates(session?.snapshot ?? null),
    items: session?.snapshot.decide.items.map(presentReviewItem) ?? [],
    ideas: session?.snapshot.ideas.map(presentReviewIdea) ?? [],
    riskMacro: reviewRiskMacro(session?.snapshot ?? null),
    card,
    detail,
    setDetail,
    noteOpen,
    setNoteOpen,
    saveCardNote,
    suspended,
    reader,
    setReader,
    notice,
    pending,
    unknownItems,
    candidateChoices:
      data.status === "current"
        ? Object.fromEntries(
            data.candidateStates.flatMap<[string, "watch" | "dismiss"]>((row) =>
              row.accepted
                ? [[row.id, "watch" as const]]
                : row.dismissed
                  ? [[row.id, "dismiss" as const]]
                  : [],
            ),
          )
        : candidateChoices,
    advance,
    back,
    choose,
    candidate,
    save,
    form,
  };
}
export type ReviewScreenState = ReturnType<typeof useReviewScreen>;
